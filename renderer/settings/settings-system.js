// Settings → Power and network → "Power management": Power off / Reboot / Sleep — main calls `systemctl --no-ask-password <verb>` (whitelist,
// lib/system-power.js; polkit allows it without a password). A 2-step confirmation on the `createArmedActionList` factory (shared with
// home/quick-power.js): 1st ✕ → "✕ AGAIN" (a 3 s timer resets it), 2nd ✕ → the actual IPC; ○/PS or ▲▼ clears the arming at any time.
// Load order: AFTER settings.js (SETTINGS_VIEWS registry).

let powerButtonStates = {};

const POWER_ROWS = [
    { id: 'poweroff', labelKey: 'sv.powerOff', icon: '⏻' },
    { id: 'reboot', labelKey: 'sv.powerReboot', icon: '↻' },
    { id: 'suspend', labelKey: 'sv.powerSuspend', icon: '☾' },
];

const powerList = createArmedActionList({
    rows: POWER_ROWS,
    // The machine is about to power off/sleep, a success feedback is pointless — the factory ALREADY played `feedback('launch')`.
    onConfirm: (row) => {
        showStatus(tr('sv.powerRunning'));
        window.launcher.systemAction(row.id);
    },
    rerender: () => renderPowerView(),
    isStillOpen: () => settingsView === 'power', // do not write into a stale subview from the reset timer
});

function openPowerView() {
    setSubviewFrame({ title: tr('menu.power'), hint: 'hint.select' });
    powerButtonStates = { cross: true };  // entered from the menu with ✕ — do not take it as immediate arming
    powerList.reset();
    renderPowerView();
}

function renderPowerView() {
    $('settingsContent').innerHTML = `<div class="settings-subhead">${esc(tr('sv.powerHint'))}</div>${powerList.rowsHtml()}`;
    scrollSettingsFocusIntoView();
}

function handlePowerInput(gp) {
    const bs = powerButtonStates;
    edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed, (rep) => powerList.moveFocus(-1, rep));
    edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed, (rep) => powerList.moveFocus(1, rep));
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => powerList.select());
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        powerList.clearArm();
        backToSettingsMenu(gp);
    });
}

SETTINGS_VIEWS['power'] = { open: openPowerView, handle: handlePowerInput };
