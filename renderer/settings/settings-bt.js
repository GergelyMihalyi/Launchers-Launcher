// Settings → Bluetooth headphones + Controllers subview. A generic quartet (open/render/toggle/handle) by `kind` ('headset' | 'controller'),
// the per-kind state in the `btState` object. Load order: after controller-id.js + settings.js.

// Controller type icons: `CONTROLLER_ICONS` (renderer/controller/controller-icons.js, shared with the home-screen controller badge). Type:
// `classifyController()` (controller-id.js).

const BT_BRAND_LABEL = { dualsense: 'PS', dualshock: 'PS', xbox: 'Xbox', generic: '' };

// Shared BT device subview (headphones + controller), separate state per `kind`. `busyMac`: MAC of the device currently being
// connected/disconnected/paired - while non-null, that subview's input is disabled (bluetoothctl connect may take 1-5+ s). `scanning`: is
// device discovery running; `found`: the found, not yet paired devices (`bt-scan` / `bt-pair` IPC).
const btState = {
    headset: { list: [], focusIndex: 0, busyMac: null, buttonStates: {}, scanning: false, found: [] },
    controller: { list: [], focusIndex: 0, busyMac: null, buttonStates: {}, scanning: false, found: [] },
};

function sortBtList(list) {
    list.sort((a, b) => (Number(b.connected) - Number(a.connected)) || a.name.localeCompare(b.name));
}

// Model of the navigable rows: paired devices → the "Search for a new device" row (unless a scan runs) → found devices. The USB block is
// readonly, NOT a row (the nav skips it).
function btNavRows(kind) {
    const st = btState[kind];
    const rows = st.list.map((d) => ({ type: 'device', device: d }));
    if (!st.scanning) rows.push({ type: 'scan' });
    (st.found || []).forEach((f) => rows.push({ type: 'found', found: f }));
    return rows;
}

async function openBtDeviceView(kind) {
    const isController = kind === 'controller';
    setSubviewFrame({ title: tr(isController ? 'menu.bt-controller' : 'menu.bt-headset'), hint: 'hint.connectToggle', skeleton: true });
    const st = btState[kind];
    // — the user may still hold the entering X, it must not count as an immediate selection of row 0 (disconnect/connect/start search).
    st.buttonStates = { cross: true };
    st.busyMac = null;
    st.scanning = false;
    st.found = [];
    const res = await window.launcher.listBtDevices(kind);
    if (settingsView !== viewFor(kind)) return; // left the subview meanwhile
    if (!res.ok) { renderSubviewError(tr('sv.btFailed')); return; }
    st.list = res.items;
    sortBtList(st.list);
    st.focusIndex = Math.max(0, st.list.findIndex((d) => d.connected));
    renderBtDeviceList(kind);
}

// Gamepad API label: the technical part in parentheses cut off ("... (STANDARD GAMEPAD ...)").
function gamepadLabel(pad) {
    return ((pad.id || 'Kontroller').replace(/\s*\(.*$/, '').trim()) || 'Kontroller';
}

// USB/wired pads: the Gamepad API entries beyond the number of `connected` BT devices - the surplus is taken as wired (without a MAC they
// cannot be matched exactly; this heuristic is accurate in practice with 1-2 active pads).
function usbOnlyControllers(btList) {
    const pads = Array.from(navigator.getGamepads()).filter(Boolean);
    const connectedBt = btList.filter((d) => d.connected).length;
    const surplus = Math.max(0, pads.length - connectedBt);
    if (!surplus) return [];
    return pads.slice(pads.length - surplus).map((p) => ({
        name: gamepadLabel(p),
        type: classifyController(p.id),
    }));
}

function renderBtDeviceList(kind) {
    const st = btState[kind];
    const isController = kind === 'controller';
    const listEl = $('settingsContent');
    const rows = btNavRows(kind);

    const nameCounts = {};
    st.list.forEach((d) => { nameCounts[d.name] = (nameCounts[d.name] || 0) + 1; });

    let html = '';
    if (!st.list.length && !st.scanning && !(st.found || []).length) {
        // The paired list is empty, but the "search" row is still needed — not a full emptyState.
        html += `<div class="settings-item settings-item-readonly"><span class="bt-name">${esc(tr(isController ? 'sv.noPairedController' : 'sv.noPairedHeadset'))}</span></div>`;
    }

    rows.forEach((row, i) => {
        const focused = i === st.focusIndex ? 'focused' : '';
        if (row.type === 'device') {
            const d = row.device;
            const icon = isController
                ? `<span class="bt-icon">${CONTROLLER_ICONS[d.type] || CONTROLLER_ICONS.generic}</span>`
                : '';
            let disamb = '';
            if (nameCounts[d.name] > 1) {
                const brand = BT_BRAND_LABEL[d.type] || '';
                disamb = ` <span class="bt-disamb">· ${esc(brand ? brand + ' · ' : '')}${esc(d.mac.slice(-5))}</span>`;
            }
            let tag = '';
            if (st.busyMac === d.mac) {
                tag = ' <span class="audio-current-tag">...</span>';
            } else if (d.connected) {
                const bat = (d.battery != null) ? ` ${d.battery}%` : '';
                tag = ` <span class="audio-current-tag">${esc(tr('sv.active'))}${bat}</span>`;
            }
            html += `<div class="settings-item ${focused}">${icon}<span class="bt-name">${esc(d.name)}</span>${disamb}${tag}</div>`;
        } else if (row.type === 'scan') {
            html += `<div class="settings-subhead">${esc(tr('sv.btNewDevice'))}</div>`;
            html += `<div class="settings-item ${focused}"><span class="bt-name">${esc(tr('sv.btScan'))}</span></div>`;
        } else if (row.type === 'found') {
            // a header before the first found row
            const firstFound = rows.findIndex((r) => r.type === 'found');
            if (i === firstFound) html += `<div class="settings-subhead">${esc(tr('sv.btFoundHead'))}</div>`;
            const f = row.found;
            const ficon = isController ? `<span class="bt-icon">${CONTROLLER_ICONS[classifyController(f.name)] || CONTROLLER_ICONS.generic}</span>` : '';
            const tag = st.busyMac === f.mac ? ' <span class="audio-current-tag">...</span>' : '';
            html += `<div class="settings-item ${focused}">${ficon}<span class="bt-name">${esc(f.name)}</span> <span class="bt-disamb">· ${esc(f.mac.slice(-5))}</span>${tag}</div>`;
        }
    });

    if (st.scanning) {
        html += `<div class="settings-subhead">${esc(tr('sv.btNewDevice'))}</div>`;
        html += `<div class="settings-item-readonly">${esc(tr('sv.btScanning'))}</div>`;
        html += loadingBlock('sm', { immediate: true });
    }

    if (isController) {
        const usb = usbOnlyControllers(st.list);
        if (usb.length) {
            html += `<div class="settings-subhead">${esc(tr('sv.usbWired'))}</div>`;
            html += usb.map((u) => `
                <div class="settings-item settings-item-readonly">
                    <span class="bt-icon">${CONTROLLER_ICONS[u.type] || CONTROLLER_ICONS.generic}</span><span class="bt-name">${esc(u.name)}</span>
                    <span class="audio-current-tag">USB</span>
                </div>
            `).join('');
        }
    }

    listEl.innerHTML = html;
    scrollSettingsFocusIntoView();
}

function toggleBtDevice(kind) {
    const st = btState[kind];
    if (st.busyMac) return; // a connect/disconnect is already in progress
    const device = st.list[st.focusIndex];
    if (!device) return;
    st.busyMac = device.mac;
    renderBtDeviceList(kind);
    if (device.connected) {
        window.launcher.btDisconnect(kind, device.mac);
    } else {
        window.launcher.btConnect(kind, device.mac);
    }
}

function startBtScan(kind) {
    const st = btState[kind];
    if (st.busyMac || st.scanning) return;
    st.scanning = true;
    st.found = [];
    renderBtDeviceList(kind);
    window.launcher.btScan(kind); // a bt-scan-result push oldja fel (renderer/ipc.js)
}

function pairBtFound(kind, found) {
    const st = btState[kind];
    if (st.busyMac || st.scanning) return;
    st.busyMac = found.mac;
    renderBtDeviceList(kind);
    window.launcher.btPair(kind, found.mac); // resolved by bt-device-changed (action: 'pair')
}

function handleBtDeviceInput(gp, kind) {
    const st = btState[kind];
    const rows = btNavRows(kind);
    // During busyMac / a scan ▲▼ + X are disabled (count 0). ○/PS: back to the menu (the connect/pair running in the background continues, the
    // push handler guards with a settingsView check).
    navList(gp, st.buttonStates, {
        count: (st.busyMac || st.scanning) ? 0 : rows.length,
        move: (d, repeated) => {
            st.focusIndex = stepIndex(st.focusIndex, d, rows.length, repeated);
            renderBtDeviceList(kind);
        },
        onSelect: () => {
            const row = rows[st.focusIndex];
            if (!row) return;
            if (row.type === 'device') toggleBtDevice(kind);
            else if (row.type === 'scan') startBtScan(kind);
            else if (row.type === 'found') pairBtFound(kind, row.found);
        },
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['bt-headset'] = {
    open: () => openBtDeviceView('headset'),
    handle: (gp) => handleBtDeviceInput(gp, 'headset'),
};
SETTINGS_VIEWS['bt-controller'] = {
    open: () => openBtDeviceView('controller'),
    handle: (gp) => handleBtDeviceInput(gp, 'controller'),
};
