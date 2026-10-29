// Settings → Display and audio → "Startup display and audio" subview: one shared, concatenated list (monitors at the top, audio devices
// below), one selectable of each. A choice is applied IMMEDIATELY AND written into the `display` config key for the next start. Load order:
// after settings.js.

let startupMonitors = [];
let startupSinks = [];
let startupConfig = { monitor: null, sink: null };
let startupFocusIndex = 0;
let startupOutputButtonStates = {};
// "Keep this display?" — started by the `confirmMs` field of main's `monitor-config-changed` (only if the chosen monitor was not active before
// the switch). The timer runs in MAIN (on expiry it reverts and sends `monitor-config-reverted`); here only the countdown display + ✕/○.
let monitorConfirm = null; // { name, deadline, tick }
// Monitor switch in progress (until main's `monitor-config-changed`/`-reverted` response): kscreen-doctor + the TV's mode change take seconds
// — meanwhile the row shows "SWITCHING…", and another ✕ does NOT start a parallel switch (in production, after 7 overlapping switches
// several monitors stayed active). The main side queues them anyway; this is the UI-side feedback.
let monitorSwitching = null; // { name, timer } | null
const MONITOR_SWITCH_GUARD_MS = 20000; // allow again after this long without a response

function endMonitorSwitching() {
    if (monitorSwitching) clearTimeout(monitorSwitching.timer);
    monitorSwitching = null;
}

// Rows of the shared list: first the monitors, then the audio devices. The focus index moves on this virtual, concatenated list.
function startupRows() {
    return [
        ...startupMonitors.map((m) => ({ type: 'monitor', item: m })),
        ...startupSinks.map((s) => ({ type: 'sink', item: s })),
    ];
}

async function openStartupOutputView() {
    setSubviewFrame({ title: tr('menu.startup-output'), hint: 'hint.pick', skeleton: true });
    const [mRes, sRes, cfg] = await Promise.all([
        window.launcher.listMonitors(),
        window.launcher.listAudioSinks(),
        window.launcher.getDisplayConfig(),
    ]);
    if (settingsView !== 'startup-output') return; // left the subview meanwhile
    if (!mRes.ok && !sRes.ok) { renderSubviewError(tr('sv.outputsFailed')); return; }
    startupMonitors = mRes.items || [];
    startupSinks = sRes.items || [];
    startupConfig = cfg || { monitor: null, sink: null };
    const savedIdx = startupMonitors.findIndex((m) => m.name === startupConfig.monitor);
    startupFocusIndex = savedIdx !== -1 ? savedIdx : 0;
    // Entered from the menu with X; while it is held, it must not count as an immediate selection.
    startupOutputButtonStates = { cross: true };
    renderStartupOutput();
}

function startMonitorConfirm(name, confirmMs) {
    endMonitorConfirm();
    const tick = setInterval(() => {
        if (settingsView === 'startup-output') renderStartupOutput();
    }, 1000);
    monitorConfirm = { name, deadline: Date.now() + confirmMs, tick };
    if (settingsView === 'startup-output') renderStartupOutput();
}

function endMonitorConfirm() {
    if (monitorConfirm) clearInterval(monitorConfirm.tick);
    monitorConfirm = null;
}

function monitorConfirmHtml() {
    const secs = Math.max(0, Math.ceil((monitorConfirm.deadline - Date.now()) / 1000));
    return `<div class="settings-item focused armed monitor-confirm">`
        + `<span class="bt-name">${esc(tr('sv.monitorKeep', { secs }))}</span>`
        + ` <span class="audio-current-tag">${btnIcon('confirm')} ${esc(tr('sv.monitorKeepYes'))}`
        + `  ${btnIcon('back')} ${esc(tr('sv.monitorKeepNo'))}</span></div>`;
}

function renderStartupOutput() {
    const listEl = $('settingsContent');
    let html = monitorConfirm ? monitorConfirmHtml() : '';
    html += `<div class="settings-subhead">${esc(tr('sv.subMonitor'))}</div>`;
    if (!startupMonitors.length) {
        html += emptyState(tr('sv.noMonitors'));
    } else {
        html += startupMonitors.map((m, i) => {
            const chosen = m.name === startupConfig.monitor;
            const switching = monitorSwitching && monitorSwitching.name === m.name;
            const tag = switching ? ` ${currentTag(tr('sv.monitorSwitching'))}`
                : (chosen ? ` ${currentTag(tr('sv.startupTag'))}` : '');
            return `<div class="settings-item ${i === startupFocusIndex ? 'focused' : ''}"><span class="bt-name">${esc(m.label)}</span>${tag}</div>`;
        }).join('');
    }
    html += `<div class="settings-subhead">${esc(tr('sv.subSink'))}</div>`;
    if (!startupSinks.length) {
        html += emptyState(tr('sv.noSinks'));
    } else {
        html += startupSinks.map((s, j) => {
            const idx = startupMonitors.length + j;
            const chosen = s.name === startupConfig.sink;
            const tag = chosen ? ` ${currentTag(tr('sv.startupTag'))}` : '';
            return `<div class="settings-item ${idx === startupFocusIndex ? 'focused' : ''}"><span class="bt-name">${esc(s.description)}</span>${tag}</div>`;
        }).join('');
    }
    listEl.innerHTML = html;
    scrollSettingsFocusIntoView();
}

function selectStartupRow() {
    const row = startupRows()[startupFocusIndex];
    if (!row) return;
    if (row.type === 'monitor') {
        if (monitorSwitching) return; // a switch is already running — see above
        const name = row.item.name;
        monitorSwitching = {
            name,
            timer: setTimeout(() => {
                monitorSwitching = null;
                if (settingsView === 'startup-output') renderStartupOutput();
            }, MONITOR_SWITCH_GUARD_MS),
        };
        window.launcher.setStartupMonitor(name);
    } else {
        startupConfig.sink = row.item.name;
        window.launcher.setStartupSink(row.item.name);
    }
    renderStartupOutput();
}

function handleStartupOutputInput(gp) {
    if (monitorConfirm) {
        // Pending monitor switch: ONLY ✕ (keep) / ○·PS (back) — the list is not navigable, and the back button does not leave the subview while
        // the question is open.
        const bs = startupOutputButtonStates;
        edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => {
            feedback('launch');
            window.launcher.confirmStartupMonitor();
            showStatus(tr('toast.startupMonitor', { name: monitorConfirm.name }));
            endMonitorConfirm();
            renderStartupOutput();
        });
        edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
            feedback('back');
            window.launcher.revertStartupMonitor();
        });
        return;
    }
    const count = startupRows().length;
    navList(gp, startupOutputButtonStates, {
        count,
        move: (d, repeated) => { startupFocusIndex = stepIndex(startupFocusIndex, d, count, repeated); renderStartupOutput(); },
        onSelect: () => selectStartupRow(),
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['startup-output'] = { open: openStartupOutputView, handle: handleStartupOutputInput };
