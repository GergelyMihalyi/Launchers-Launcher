// Home-screen controller badge: EVERY connected controller separately, with a type-specific icon (CONTROLLER_ICONS) + (where available) its
// battery %, below the header clock. Data: (1) BT controllers — the `list-bt-devices` 'controller' IPC poll (`type` + `battery` per device);
// (2) USB/wired — the Gamepad API surplus (padCount − BT-connected), type from `pad.id`, no battery. `controllerChips()` is pure. Load order:
// AFTER util.js + controller-icons.js, BEFORE settings-bt.js. Background: docs/dev/devices.md#controller-identification-and-battery

// Node/test: classifyController from controller-id.js (a global <script> in the browser).
if (typeof classifyController === 'undefined' && typeof module !== 'undefined') {
    // eslint-disable-next-line no-undef
    Object.assign(globalThis, { classifyController: module.require('../../controller-id.js').classifyController });
}

const CTRL_STATUS_POLL_MS = 30000; // the battery changes slowly
let ctrlStatusPollTimer = null;
let ctrlBtItems = []; // the items of the last list-bt-devices 'controller' response

// "No controller" hint: appears after this long without a pad.
const NO_PAD_HINT_DELAY_MS = 3000;
let noPadTimer = null;
let noPadReady = false; // the delay elapsed and there has been no pad since
let noPadDismissed = false; // closed by the user (for this run)

/** Is the hint visible: no pad, the delay elapsed, not closed, the window is visible. */
function noPadHintVisible(chipCount, ready, dismissed, hidden) {
    return chipCount === 0 && !!ready && !dismissed && !hidden;
}

function updateNoPadHint(chipCount) {
    const el = $('noPadHint');
    if (!el) return;
    if (chipCount > 0) {
        clearTimeout(noPadTimer);
        noPadTimer = null;
        noPadReady = false;
    } else if (!noPadReady && !noPadTimer) {
        noPadTimer = setTimeout(() => {
            noPadTimer = null;
            noPadReady = true;
            renderControllerStatus();
        }, NO_PAD_HINT_DELAY_MS);
    }
    const show = noPadHintVisible(chipCount, noPadReady, noPadDismissed, document.hidden);
    if (show) {
        $('noPadHintText').textContent = tr('noPad.text');
        $('noPadHintLink').textContent = tr('noPad.link');
    }
    el.hidden = !show;
}

function initNoPadHint() {
    $('noPadHintLink').addEventListener('click', () => {
        noPadDismissed = true;
        updateNoPadHint(0);
        openSettingsView('bt-controller');
    });
    $('noPadHintClose').addEventListener('click', () => {
        noPadDismissed = true;
        updateNoPadHint(0);
    });
}

// Controller battery warning: below LOW we toast once per device, and it only "re-arms" when the `%` climbs back above CLEAR (hysteresis —
// no spamming at the threshold). The `warned` mac->true map lives at the caller; the helper is pure (module.exports).
const CTRL_BAT_LOW = 15;
const CTRL_BAT_CLEAR = 25;
let ctrlBatWarned = {};

function pickBatteryWarnings(items, warned, low = CTRL_BAT_LOW, clear = CTRL_BAT_CLEAR) {
    const nextWarned = { ...warned };
    const warn = [];
    for (const d of items || []) {
        if (!d || !d.connected || typeof d.battery !== 'number') continue;
        if (d.battery <= low && !nextWarned[d.mac]) {
            nextWarned[d.mac] = true;
            warn.push({ name: d.name || d.mac, battery: d.battery });
        } else if (d.battery >= clear && nextWarned[d.mac]) {
            delete nextWarned[d.mac];
        }
    }
    return { warn, warned: nextWarned };
}

// btItems: the items of the list-bt-devices 'controller' response; pads: getGamepads()-like (Boolean-filtered, with an { id } string).
// -> the controllers to show on the home screen.
function controllerChips(btItems, pads) {
    const btConnected = (btItems || []).filter((d) => d.connected);
    const chips = btConnected.map((d) => ({
        type: d.type || 'generic',
        battery: (typeof d.battery === 'number') ? d.battery : null,
        source: 'bt',
        mac: d.mac ? String(d.mac).toUpperCase() : null,
    }));
    const list = (pads || []).filter(Boolean);
    const surplus = Math.max(0, list.length - btConnected.length);
    for (const p of list.slice(list.length - surplus)) {
        chips.push({ type: classifyController((p && p.id) || ''), battery: null, source: 'usb', mac: null });
    }
    return chips; // [] -> the bar is hidden
}

// PS+Square "which controller is which" flash (see renderer/gamepad.js handlePsCombo). If main's evdev watcher told the pressing
// controller's MAC, the BT chip of that MAC flashes (`chipIndexForMac`) — EXACT. Without a MAC (USB pad / no evdev) the old order-based
// ESTIMATE is the fallback (`chipIndexForPad`: looks up the position in the SAME `pads` list used by renderControllerStatus()).
const CTRL_FLASH_MS = 1500;
let ctrlFlashChipIndex = -1;
let ctrlFlashTimer = null;

function chipIndexForPad(padIndex, pads) {
    return (pads || []).findIndex((p) => p && p.index === padIndex);
}

function chipIndexForMac(mac, chips) {
    if (!mac) return -1;
    const m = String(mac).toUpperCase();
    return (chips || []).findIndex((c) => c && c.mac === m);
}

function flashControllerChip(padIndex, mac) {
    const pads = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
    let idx = chipIndexForMac(mac, controllerChips(ctrlBtItems, pads));
    if (idx === -1) idx = chipIndexForPad(padIndex, pads);
    if (idx === -1) return;
    ctrlFlashChipIndex = idx;
    renderControllerStatus();
    clearTimeout(ctrlFlashTimer);
    ctrlFlashTimer = setTimeout(() => {
        ctrlFlashChipIndex = -1;
        renderControllerStatus();
    }, CTRL_FLASH_MS);
}

function renderControllerStatus() {
    const el = $('controllerStatus');
    if (!el) return;
    const pads = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
    const chips = controllerChips(ctrlBtItems, pads);
    updateNoPadHint(chips.length);
    if (!chips.length) {
        el.innerHTML = '';
        el.hidden = true;
        return;
    }
    el.innerHTML = chips.map((c, i) => {
        const icon = CONTROLLER_ICONS[c.type] || CONTROLLER_ICONS.generic;
        const bat = (c.battery != null)
            ? `<span class="ctrl-bat ${c.battery <= 20 ? 'low' : ''}">${c.battery}%</span>`
            : '';
        const flashCls = i === ctrlFlashChipIndex ? ' flash' : '';
        return `<span class="ctrl-chip${flashCls}">${icon}${bat}</span>`;
    }).join('');
    el.hidden = false;
}

// BT poll (only with a visible window - the launcher is hidden while playing, do not poll bluetoothctl needlessly). Best effort: on error
// the old list stays.
async function pollControllerStatus() {
    if (document.hidden) return;
    try {
        const res = await window.launcher.listBtDevices('controller');
        if (res && res.ok) {
            ctrlBtItems = res.items || [];
            const { warn, warned } = pickBatteryWarnings(ctrlBtItems, ctrlBatWarned);
            ctrlBatWarned = warned;
            for (const w of warn) {
                showStatus(tr('toast.controllerBatteryLow', { name: w.name, pct: w.battery }), true);
            }
        }
    } catch (_) { /* best effort */ }
    renderControllerStatus();
}

function startControllerStatus() {
    initNoPadHint();
    renderControllerStatus();
    pollControllerStatus();
    if (!ctrlStatusPollTimer) {
        ctrlStatusPollTimer = setInterval(pollControllerStatus, CTRL_STATUS_POLL_MS);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { noPadHintVisible, controllerChips, pickBatteryWarnings, chipIndexForPad, chipIndexForMac });
}
