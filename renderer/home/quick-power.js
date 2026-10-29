// Quick system menu — the Start/Options button (buttons[9]) opens it from ANYWHERE on the home screen: Power off / Reboot / Sleep (2-step
// confirmation, with the shared `createArmedActionList` factory, like Settings → Power management) + "Close program" (immediate).
// A standalone overlay (`#quickPowerOverlay`), NOT a Settings subview (the card-menu.js pattern). Load order: AFTER card-menu.js, BEFORE
// gamepad.js. Background: docs/dev/renderer/home.md#quick-power-menu


// `armed: true` = needs a 2-step confirmation (irreversibly changes the machine state); `armed: false` = immediate ("Close program" is no
// more dangerous than the existing PS-button quit).
const QP_ROWS = [
    { id: 'poweroff', labelKey: 'sv.powerOff', icon: '⏻', armed: true, sectionKey: 'sv.powerHint' },
    { id: 'reboot', labelKey: 'sv.powerReboot', icon: '↻', armed: true },
    { id: 'suspend', labelKey: 'sv.powerSuspend', icon: '☾', armed: true },
    { id: 'quit', labelKey: 'qp.quit', icon: '⎋', armed: false },
];

// Quick settings: the most common couch adjustments at the top of the menu, ✕ = the next value (cycling), live immediately — all existing
// IPC. The audio output row only shows with ≥ 2 sinks. The values load when the menu opens (`loadQuickState`), the row label always shows
// the current state.
const QP_SLEEP_STEPS = [0, 30, 60, 90];
let qpSinks = [];
let qpNight = 0;
let qpDnd = true;

const qpSleepLabel = (m) => (m ? tr(`sv.sleep${m}`) : tr('sv.sleepOff'));
const qpNightLabel = (l) => tr(['sv.optOff', 'sv.nightMild', 'sv.nightStrong'][l] || 'sv.optOff');

/** The next value in a cycled list (unknown current → the first). */
function qpNext(list, current) {
    const i = list.indexOf(current);
    return list[(i + 1) % list.length];
}

function qpRows() {
    const quick = [];
    const sink = qpSinks.find((x) => x.isDefault);
    if (qpSinks.length > 1) quick.push({ id: 'q-sink', label: `${tr('qp.sink')}: ${sink ? sink.description : '—'}`, icon: '🔊', armed: false });
    quick.push({ id: 'q-sleep', label: `${tr('menu.sleep-timer')}: ${qpSleepLabel(sleepTimerMinutes)}`, icon: '☾', armed: false });
    quick.push({ id: 'q-night', label: `${tr('menu.night-mode')}: ${qpNightLabel(qpNight)}`, icon: '🌙', armed: false });
    quick.push({ id: 'q-dnd', label: `${tr('qp.dnd')}: ${tr(qpDnd ? 'qp.on' : 'qp.off')}`, icon: '🔕', armed: false });
    quick[0] = { ...quick[0], sectionKey: 'qp.quickSection' };
    return [...quick, ...QP_ROWS];
}

function qpQuickAction(row) {
    if (row.id === 'q-sink') {
        const i = qpSinks.findIndex((x) => x.isDefault);
        const next = qpSinks[(i + 1) % qpSinks.length];
        qpSinks = qpSinks.map((x) => ({ ...x, isDefault: x === next }));
        window.launcher.setAudioSink(next.name);
    } else if (row.id === 'q-sleep') {
        sleepTimerMinutes = qpNext(QP_SLEEP_STEPS, sleepTimerMinutes);
        window.launcher.setSleepTimer(sleepTimerMinutes);
    } else if (row.id === 'q-night') {
        qpNight = qpNext([0, 1, 2], qpNight);
        window.launcher.setNightMode(qpNight);
    } else if (row.id === 'q-dnd') {
        qpDnd = !qpDnd;
        window.launcher.setDoNotDisturb(qpDnd);
    }
    feedback('nav');
    renderQuickPowerMenu();
}

function loadQuickState() {
    window.launcher.listAudioSinks()
        .then((res) => { if (res && res.ok) { qpSinks = res.items || []; if (quickPower.isOpen()) renderQuickPowerMenu(); } })
        .catch(ignoreError);
    window.launcher.getNightMode()
        .then((v) => { qpNight = Number(v) || 0; if (quickPower.isOpen()) renderQuickPowerMenu(); })
        .catch(ignoreError);
    window.launcher.getDoNotDisturb()
        .then((v) => { qpDnd = v !== false; if (quickPower.isOpen()) renderQuickPowerMenu(); })
        .catch(ignoreError);
}

const qpList = createArmedActionList({
    rows: qpRows,
    onImmediate: (row) => {
        if (row.id.startsWith('q-')) { qpQuickAction(row); return; }
        feedback('back');
        closeQuickPowerMenu();
        window.launcher.quit();
    },
    // The machine is about to power off/sleep, a success feedback is pointless — the factory ALREADY played `feedback('launch')`.
    onConfirm: (row) => {
        showStatus(tr('sv.powerRunning'));
        window.launcher.systemAction(row.id);
    },
    rerender: () => renderQuickPowerMenu(),
    isStillOpen: () => quickPower.isOpen(), // do not write into a stale/closed overlay from the reset timer
});

// Lifecycle on the shared `createOverlay` (renderer/util.js).
const quickPower = createOverlay({
    elementId: 'quickPowerOverlay',
    // The opening Start button may still be held — the menu must not take it as an immediate selection.
    enterStates: { cross: true },
    // The main branch must not take the still held Start as a new press on the next frame.
    syncOnClose: () => ({ states: buttonStates, keys: ['cross', 'ps', 'start'] }),
    onOpen: () => { qpList.reset(); renderQuickPowerMenu(); loadQuickState(); },
    onClose: () => qpList.clearArm(),
});

function openQuickPowerMenu() { quickPower.open(); }

function closeQuickPowerMenu(gp) { quickPower.close(gp); }

function renderQuickPowerMenu() {
    $('quickPowerTitle').textContent = tr('qp.title');
    $('quickPowerHint').innerHTML = subviewHint('hint.select');
    $('quickPowerContent').innerHTML = qpList.rowsHtml();
}

function handleQuickPowerInput(gp) {
    const bs = quickPower.states;
    edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed, (rep) => qpList.moveFocus(-1, rep));
    edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed, (rep) => qpList.moveFocus(1, rep));
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => qpList.select());
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        closeQuickPowerMenu(gp);
    });
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { QP_ROWS, QP_SLEEP_STEPS, qpNext });
}
