// Settings → Log subview (read-only). Shows the last few hundred lines of `logFile` (`window.launcher.readLog()` → `read-log`,
// LOG_VIEW_MAX_LINES) - so on the kiosk machine you can see without a terminal why something did not start. X = manual refresh, the newest
// line is focused on entry. Levels (lib/log-lines.js): L2/R2 = filter (all → warnings + errors → errors only), errors/warnings highlighted;
// □ = save the whole log to a file in the home folder (for a bug report). Load order: after settings.js.

const LOG_FILTERS = ['all', 'warn', 'error'];
const LOG_FILTER_KEYS = { all: 'sv.logFilterAll', warn: 'sv.logFilterWarn', error: 'sv.logFilterError' };

let logLines = []; // [{ text, level }]
let logFilter = 'all';
let logFocusIndex = 0;
let logButtonStates = {};

// The lines passing the filter (`warn` = warnings AND errors). Pure — also accepts the old (all-string) response shape (`info`).
function filterLogItems(items, filter) {
    const list = (items || []).map((it) => (typeof it === 'string' ? { text: it, level: 'info' } : it));
    if (filter === 'error') return list.filter((it) => it.level === 'error');
    if (filter === 'warn') return list.filter((it) => it.level === 'error' || it.level === 'warn');
    return list;
}

async function openLogView() {
    // - the user may still hold the entering X.
    logButtonStates = { cross: true };
    logFilter = 'all';
    setSubviewFrame({ title: tr('menu.log'), skeleton: true });
    $('settingsPanelHint').innerHTML = `
        <span>▲▼ ${esc(tr('hint.nav'))}</span>
        <span>L2 / R2 ${esc(tr('sv.logHintFilter'))}</span>
        <span>${btnIcon('alt')} ${esc(tr('sv.logHintExport'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('hint.refresh'))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>`;
    await refreshLog();
}

async function refreshLog() {
    const res = await window.launcher.readLog();
    if (settingsView !== 'log') return; // left the subview meanwhile
    if (!res.ok) { renderSubviewError(tr('sv.logFailed')); return; }
    logLines = filterLogItems(res.items, 'all');
    focusNewestLogLine();
    renderLogList();
}

// The newest line (passing the filter) should be focused (it is at the end of the file).
function focusNewestLogLine() {
    const n = filterLogItems(logLines, logFilter).length;
    logFocusIndex = n ? n - 1 : 0;
}

function renderLogList() {
    const listEl = $('settingsContent');
    const visible = filterLogItems(logLines, logFilter);
    const errors = logLines.filter((it) => it.level === 'error').length;
    let html = `<div class="settings-subhead">${esc(tr('sv.logFilterLine', {
        filter: tr(LOG_FILTER_KEYS[logFilter]), shown: visible.length, errors,
    }))}</div>`;
    if (!visible.length) {
        html += emptyState(tr(logLines.length ? 'sv.logFilterEmpty' : 'sv.noLogEntries'));
    } else {
        html += visible.map((it, i) => `
            <div class="settings-item log-${it.level}${i === logFocusIndex ? ' focused' : ''}">${esc(it.text)}</div>
        `).join('');
    }
    listEl.innerHTML = html;
    scrollSettingsFocusIntoView();
}

function cycleLogFilter(d) {
    logFilter = LOG_FILTERS[(LOG_FILTERS.indexOf(logFilter) + d + LOG_FILTERS.length) % LOG_FILTERS.length];
    feedback('nav');
    focusNewestLogLine();
    renderLogList();
}

function exportLogToFile() {
    window.launcher.exportLog().then((res) => {
        if (res && res.ok) showStatus(tr('toast.logExported', { file: res.file }));
        else showStatus(tr('toast.logExportFailed'), true);
    }).catch(() => showStatus(tr('toast.logExportFailed'), true));
}

function handleLogInput(gp) {
    const count = filterLogItems(logLines, logFilter).length;
    navList(gp, logButtonStates, {
        count,
        move: (d, repeated) => { logFocusIndex = stepIndex(logFocusIndex, d, count, repeated); renderLogList(); },
        onSelect: () => refreshLog(),
        onBack: () => backToSettingsMenu(gp),
    });
    edge(logButtonStates, 'filterPrev', gp.buttons[BTN.l2]?.pressed, () => cycleLogFilter(-1));
    edge(logButtonStates, 'filterNext', gp.buttons[BTN.r2]?.pressed, () => cycleLogFilter(1));
    edge(logButtonStates, 'export', gp.buttons[BTN.square]?.pressed, () => exportLogToFile());
}

SETTINGS_VIEWS['log'] = { open: openLogView, handle: handleLogInput };

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { filterLogItems });
}
