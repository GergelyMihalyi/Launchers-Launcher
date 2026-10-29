// Settings → Power and network → "Wi-Fi": main calls `nmcli` (lib/network/wifi.js). Rows: [Turn on Wi-Fi] → networks (active first, by
// signal strength) → "Rescan networks". ✕ on a network: active → only a notice; WPA-Enterprise → "not supported"; open or SAVED → connect
// immediately; password-protected not saved (or a wrong saved password) → on-screen keyboard (masked). The password only travels to the
// `connectWifi` IPC, it is neither stored nor logged. Load order: AFTER settings.js, BEFORE keyboard.js. Background: docs/dev/devices.md#wi-fi-nmcli

const wifiState = {
    device: true, radio: true, items: [], focusIndex: 0, buttonStates: {},
    busySsid: null, // connecting to this one right now (input disabled)
    forgetArmedSsid: null, // △ armed the forget (for 3 s; a second △ executes it)
    forgetTimer: null,
    scanning: false, // a blocking (re)scan is running: only the indicator, no navigation
    refreshing: false, // the background refresh after the instant cached list: indicator, navigation allowed
    loadSeq: 0, // only the latest list request is applied (a slow background refresh must not overwrite a newer list)
    rowError: null, // { ssid, key }: the last failed connect, shown on the network's row for WIFI_ROW_ERROR_MS
    rowErrorTimer: null,
    loaded: false,
};

const WIFI_ROW_ERROR_MS = 8000;

// Toast texts for main's `errorKey`s (literal keys — test/contracts/i18n-keys).
const WIFI_ERROR_KEYS = {
    badPassword: 'sv.wifiErrBadPassword',
    badPasswordFormat: 'sv.wifiErrPasswordFormat',
    needPassword: 'sv.wifiErrBadPassword',
    notFound: 'sv.wifiErrNotFound',
    unsupported: 'sv.wifiErrUnsupported',
    denied: 'sv.wifiErrDenied',
    timeout: 'sv.wifiErrTimeout',
    failed: 'sv.wifiErrFailed',
};

// Signal strength (0–100) → a 4-step bar: the full bars normal, the rest dimmed (`.wifi-bars-dim`).
function wifiSignalBars(signal) {
    const n = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
    const bars = '▂▄▆█';
    return `${bars.slice(0, n)}<span class="wifi-bars-dim">${bars.slice(n)}</span>`;
}

/** @returns {{ type: 'radio' | 'net' | 'rescan' | 'hidden', net?: any }[]} */
function wifiNavRows() {
    const st = wifiState;
    if (!st.device) return [];
    if (!st.radio) return [{ type: 'radio' }];
    /** @type {{ type: 'radio' | 'net' | 'rescan' | 'hidden', net?: any }[]} */
    const rows = st.items.map((net) => ({ type: 'net', net }));
    if (!st.scanning) rows.push({ type: 'hidden' });
    if (!st.scanning && !st.refreshing) rows.push({ type: 'rescan' });
    return rows;
}

// A row's identity across reloads: the list is re-sorted (the active network first), so the focus follows the NETWORK, not the index —
// otherwise after a switch the focus stayed on the old (now "saved") network and the next ✕ switched back.
function wifiRowKey(row) {
    if (!row) return null;
    return row.type === 'net' ? `net:${row.net.ssid}` : row.type;
}

// Pure: the focus index in `rows` for the row `key`; missing → `fallback` clamped into the list.
function wifiFocusIndex(rows, key, fallback) {
    const i = key == null ? -1 : rows.findIndex((r) => wifiRowKey(r) === key);
    if (i >= 0) return i;
    return Math.max(0, Math.min(fallback, rows.length - 1));
}

// `mode`: 'cached' = NetworkManager's last scan result (instant), 'rescan' = a fresh scan, otherwise auto (a fresh scan if the last
// one is old — ~6 s). `opts.focusSsid` = focus this network after loading (the freshly connected one).
async function loadWifiList(mode, opts = {}) {
    const st = wifiState;
    const seq = ++st.loadSeq;
    const req = mode === 'rescan' ? { rescan: true } : mode === 'cached' ? { cached: true } : {};
    const res = await window.launcher.listWifi(req).catch(() => null);
    if (settingsView !== 'wifi' || seq !== st.loadSeq) return;
    // Before the first list the only row is "＋ Hidden network…" — following it would leave the focus there instead of on the first network.
    const focusKey = opts.focusSsid ? `net:${opts.focusSsid}` : st.loaded ? wifiRowKey(wifiNavRows()[st.focusIndex]) : null;
    if (!res || !res.ok) {
        if (mode === 'cached') return; // the background refresh follows, the indicator stays
        st.scanning = false;
        st.refreshing = false;
        st.loaded = false;
        renderSubviewError(tr('sv.wifiFailed'));
        return;
    }
    st.scanning = false;
    if (mode !== 'cached') st.refreshing = false;
    st.device = res.device !== false;
    st.radio = res.radio !== false;
    st.items = Array.isArray(res.items) ? res.items : [];
    st.loaded = true;
    st.focusIndex = wifiFocusIndex(wifiNavRows(), focusKey, st.focusIndex);
    renderWifiList();
}

// Opening: the "Searching for networks..." indicator immediately, then the cached list (~40 ms), then a refresh in the background —
// the first `nmcli … --rescan auto` alone takes ~6 s, the subview looked empty meanwhile.
function openWifiView() {
    const st = wifiState;
    setSubviewFrame({ title: tr('menu.wifi'), hint: 'hint.connect' });
    $('settingsPanelHint').innerHTML += `<span>${btnIcon('menu')} ${esc(tr('sv.wifiForgetHint'))}</span>`;
    st.buttonStates = { cross: true }; // entered from the menu with ✕
    st.focusIndex = 0;
    st.busySsid = null;
    st.device = true;
    st.radio = true;
    st.items = [];
    st.scanning = false;
    st.refreshing = true;
    st.loaded = false;
    clearTimeout(st.rowErrorTimer);
    st.rowError = null;
    renderWifiList();
    loadWifiList('cached')
        .then(() => { if (settingsView === 'wifi' && st.refreshing) return loadWifiList(); })
        .catch(ignoreError);
}

// The failed connect's reason on the network's row (besides the toast, which is easy to miss).
function setWifiRowError(ssid, key) {
    const st = wifiState;
    clearTimeout(st.rowErrorTimer);
    st.rowError = ssid ? { ssid, key } : null;
    st.rowErrorTimer = setTimeout(() => {
        st.rowError = null;
        if (settingsView === 'wifi') renderWifiList();
    }, WIFI_ROW_ERROR_MS);
}

function renderWifiList() {
    const st = wifiState;
    if (!st.device) { $('settingsContent').innerHTML = emptyState(tr('sv.wifiNoDevice')); return; }
    const rows = wifiNavRows();
    const searching = st.scanning || st.refreshing;
    let html = '';
    if (st.radio && !st.items.length && !searching) html += emptyState(tr('sv.wifiNone'));
    // The search indicator goes right after the network rows (before "＋ Hidden network…"); a big one while there is no list yet.
    const indicator = searching && st.radio
        ? `<div class="settings-item-readonly">${esc(tr('sv.wifiScanning'))}</div>${loadingBlock(st.items.length ? 'sm' : 'md', { immediate: true })}`
        : '';
    let indicatorPlaced = false;
    rows.forEach((row, i) => {
        if (row.type !== 'net' && !indicatorPlaced) { html += indicator; indicatorPlaced = true; }
        const focused = i === st.focusIndex ? ' focused' : '';
        if (row.type === 'radio') {
            html += `<div class="settings-subhead">${esc(tr('sv.wifiRadioOff'))}</div>`;
            html += `<div class="settings-item${focused}"><span class="bt-name">${esc(tr('sv.wifiRadioOn'))}</span></div>`;
        } else if (row.type === 'rescan') {
            html += `<div class="settings-item${focused}"><span class="bt-name">${esc(tr('sv.wifiRescan'))}</span></div>`;
        } else if (row.type === 'hidden') {
            html += `<div class="settings-item${focused}"><span class="bt-name">＋ ${esc(tr('sv.wifiHidden'))}</span></div>`;
        } else {
            const n = row.net;
            let tag = '';
            if (st.busySsid === n.ssid) tag = ' <span class="audio-current-tag">...</span>';
            else if (st.rowError && st.rowError.ssid === n.ssid && !n.active) {
                tag = ` <span class="wifi-error-tag">· ${esc(tr(WIFI_ERROR_KEYS[st.rowError.key] || WIFI_ERROR_KEYS.failed))}</span>`;
            } else if (n.active) tag = ` <span class="audio-current-tag">${esc(tr('sv.active'))}</span>`;
            else if (n.enterprise) tag = ` <span class="bt-disamb">· ${esc(tr('sv.wifiEnterprise'))}</span>`;
            else if (n.saved && st.forgetArmedSsid === n.ssid) tag = ` <span class="audio-current-tag">${esc(tr('sv.wifiForgetConfirm', { btn: btnGlyph('menu') }))}</span>`;
            else if (n.saved) tag = ` <span class="bt-disamb">· ${esc(tr('sv.wifiSaved'))}</span>`;
            const lock = n.secured ? ' 🔒' : '';
            const aria = `${n.ssid}, ${n.signal}%${n.secured ? ', ' + tr('sv.wifiSecured') : ''}`;
            html += `<div class="settings-item${focused}" aria-label="${esc(aria)}"><span class="wifi-bars">${wifiSignalBars(n.signal)}</span><span class="bt-name">${esc(n.ssid)}${lock}</span>${tag}</div>`;
        }
    });
    if (!indicatorPlaced) html += indicator;
    $('settingsContent').innerHTML = html;
    scrollSettingsFocusIntoView();
}

// Masked password keyboard. `opts.errorKey` = the previous attempt failed (wrong password / too short / timeout) → the title says so
// and asks again; `opts.hidden` = a hidden network (empty password = open network).
function askWifiPassword(net, opts = {}) {
    const hidden = opts.hidden === true;
    const title = opts.errorKey
        ? tr('sv.wifiPasswordRetryTitle', { error: tr(WIFI_ERROR_KEYS[opts.errorKey] || WIFI_ERROR_KEYS.failed), ssid: net.ssid })
        : tr(hidden ? 'sv.wifiHiddenPasswordTitle' : 'sv.wifiPasswordTitle', { ssid: net.ssid });
    openKeyboard({
        title,
        initial: '',
        masked: true,
        maxLength: 64,
        ownerStates: wifiState.buttonStates,
        onCancel: () => { },
        onConfirm: (txt) => {
            const pwd = String(txt);
            if ((pwd || !hidden) && pwd.length < 8) {
                showStatus(tr('sv.wifiErrPasswordFormat'), true);
                askWifiPassword(net, { errorKey: 'badPasswordFormat', hidden });
                return;
            }
            connectWifiNetwork(net, pwd || null, { hidden }).catch(ignoreError);
        },
    });
}

// Pure: after a failed connect, should the password keyboard open again? A typed password that was wrong / malformed / timed out →
// yes (with the error in the title); without a password: a saved password that no longer works, or a network that needs one.
function wifiRetryWithPassword(errorKey, hadPassword) {
    return hadPassword
        ? ['badPassword', 'badPasswordFormat', 'timeout'].includes(errorKey)
        : ['badPassword', 'needPassword'].includes(errorKey);
}

async function connectWifiNetwork(net, password, opts = {}) {
    const st = wifiState;
    if (st.busySsid) return;
    st.busySsid = net.ssid;
    renderWifiList();
    showStatus(tr('sv.wifiConnecting', { ssid: net.ssid }));
    const res = await window.launcher.connectWifi(net.ssid, password || null, opts.hidden === true).catch(() => null);
    st.busySsid = null;
    if (res && res.ok) {
        if (st.rowError && st.rowError.ssid === net.ssid) { clearTimeout(st.rowErrorTimer); st.rowError = null; }
        showStatus(tr('sv.wifiConnected', { ssid: net.ssid }));
        // The focus moves with the network to the top of the re-sorted list (it is the active one now).
        if (settingsView === 'wifi') loadWifiList(undefined, { focusSsid: net.ssid }).catch(ignoreError);
        return;
    }
    const key = (res && res.errorKey) || 'failed';
    showStatus(tr(WIFI_ERROR_KEYS[key] || WIFI_ERROR_KEYS.failed), true);
    setWifiRowError(net.ssid, key);
    if (settingsView !== 'wifi') return;
    renderWifiList();
    // Wrong password → the keyboard again, the error in its title — only if the user is still in this subview.
    if (wifiRetryWithPassword(key, !!password)) {
        askWifiPassword(net, { errorKey: key === 'needPassword' ? undefined : key, hidden: opts.hidden === true });
    }
    // The list is reloaded either way (a failed attempt may have dropped / restored the previous connection).
    loadWifiList().catch(ignoreError);
}

// Hidden network: SSID (plain text) → password (masked, empty = open network) → connect with `hidden yes`.
function askHiddenWifi() {
    openKeyboard({
        title: tr('sv.wifiHiddenSsidTitle'), initial: '', maxLength: 32, layout: 'full',
        ownerStates: wifiState.buttonStates,
        onCancel: () => { },
        onConfirm: (ssidText) => {
            const ssid = String(ssidText).trim();
            if (!ssid) return;
            askWifiPassword({ ssid }, { hidden: true });
        },
    });
}

// △ on a SAVED network: the first arms (3 s), the second forgets it (deletes the saved profiles).
function forgetWifiRow(row) {
    const st = wifiState;
    if (!row || row.type !== 'net' || !row.net.saved) return;
    const ssid = row.net.ssid;
    if (st.forgetArmedSsid !== ssid) {
        st.forgetArmedSsid = ssid;
        clearTimeout(st.forgetTimer);
        st.forgetTimer = setTimeout(() => { st.forgetArmedSsid = null; if (settingsView === 'wifi') renderWifiList(); }, 3000);
        feedback('nav');
        renderWifiList();
        return;
    }
    clearTimeout(st.forgetTimer);
    st.forgetArmedSsid = null;
    feedback('launch');
    window.launcher.forgetWifi(ssid).then((res) => {
        showStatus(res && res.ok ? tr('sv.wifiForgotten', { ssid }) : tr('sv.wifiErrFailed'), !(res && res.ok));
        if (settingsView === 'wifi') return loadWifiList();
    }).catch(ignoreError);
}

function selectWifiRow(row) {
    const st = wifiState;
    if (row.type === 'hidden') { askHiddenWifi(); return; }
    if (row.type === 'rescan') {
        st.scanning = true;
        renderWifiList();
        loadWifiList('rescan').catch(ignoreError);
        return;
    }
    if (row.type === 'radio') {
        st.scanning = true;
        renderWifiList();
        window.launcher.setWifiRadio(true).then((res) => {
            if (!res || !res.ok) showStatus(tr('sv.wifiErrFailed'), true);
            // After turning it on, the scan takes a few s — a freshly rescanned list.
            if (settingsView === 'wifi') return loadWifiList('rescan');
        }).catch(ignoreError);
        return;
    }
    const net = row.net;
    if (net.active) { showStatus(tr('sv.wifiAlready', { ssid: net.ssid })); return; }
    if (net.enterprise) { showStatus(tr('sv.wifiErrUnsupported'), true); return; }
    if (net.secured && !net.saved) { askWifiPassword(net); return; }
    connectWifiNetwork(net, null).catch(ignoreError);
}

function handleWifiInput(gp) {
    const st = wifiState;
    const rows = wifiNavRows();
    // While connecting / scanning ▲▼ + ✕ are disabled; ○ back to the menu (the connection running in the background continues, the result
    // arrives as a toast).
    navList(gp, st.buttonStates, {
        count: (st.busySsid || st.scanning || !st.loaded) ? 0 : rows.length,
        move: (d, repeated) => {
            st.focusIndex = stepIndex(st.focusIndex, d, rows.length, repeated);
            renderWifiList();
        },
        onSelect: () => {
            const row = rows[st.focusIndex];
            if (row) selectWifiRow(row);
        },
        onBack: () => backToSettingsMenu(gp),
    });
    edge(st.buttonStates, 'forget', gp.buttons[BTN.triangle]?.pressed, () => {
        if (!(st.busySsid || st.scanning || !st.loaded)) forgetWifiRow(rows[st.focusIndex]);
    });
}

SETTINGS_VIEWS['wifi'] = { open: openWifiView, handle: handleWifiInput };

if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { wifiSignalBars, wifiNavRows, wifiState, wifiRowKey, wifiFocusIndex, wifiRetryWithPassword });
