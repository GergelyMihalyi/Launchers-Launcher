// Settings → Games → "Playtime" subview (read-only). Splits the `get-usage-stats` IPC payload (the resolved rows of the `usage` config key)
// into two sections: "Launchers" (the `launch-app` launches of the static cards) and "Games" (the `steam-game-*` / `heroic-game-*` /
// `retroarch-game` entries). Both descending by `totalMs`; the Games top 15. X = refresh, ○/PS = back. Load order: after settings.js. No reset.

let statsRows = [];
let statsSections = [];
let statsFocusIndex = 0;
let statsButtonStates = {};

const STATS_GAMES_TOP_N = 15;

async function openStatsView() {
    // - the user may still hold the entering X.
    statsButtonStates = { cross: true };
    setSubviewFrame({ title: tr('menu.stats'), hint: 'hint.refresh', skeleton: true });
    statsFocusIndex = 0;
    await refreshStats();
}

async function refreshStats() {
    const rows = await window.launcher.getUsageStats().catch(() => []);
    if (settingsView !== 'stats') return; // left the subview meanwhile
    statsRows = Array.isArray(rows) ? rows : [];
    buildStatsSections();
    const total = statsItemCount();
    statsFocusIndex = total ? Math.min(statsFocusIndex, total - 1) : 0;
    renderStats();
}

function statsRowLabel(row) {
    return row.kind === 'retroarch' ? tr('sv.statsRetroarchAll') : (row.name || row.key);
}

function buildStatsSections() {
    const byTime = (a, b) => (b.totalMs - a.totalMs) || (b.count - a.count);
    const launcherRows = statsRows.filter((r) => r.kind === 'launcher').sort(byTime);
    const gameRows = statsRows.filter((r) => r.kind !== 'launcher').sort(byTime).slice(0, STATS_GAMES_TOP_N);

    statsSections = [];
    if (launcherRows.length) {
        statsSections.push({ title: tr('sv.statsLaunchers'), items: launcherRows });
    }
    if (gameRows.length) {
        statsSections.push({ title: tr('sv.statsGames'), items: gameRows, note: tr('sv.statsSteamNote') });
    }
}

function statsItemCount() {
    return flatSectionItemCount(statsSections);
}

function renderStatsItem(row) {
    const stat = tr('sv.statsCount', { n: row.count || 0, t: formatDuration(row.totalMs) });
    return `<span class="bt-name">${esc(statsRowLabel(row))}</span> ${currentTag(stat, { paren: true })}`;
}

function renderStats() {
    if (!statsItemCount()) {
        $('settingsContent').innerHTML = emptyState(tr('sv.statsEmpty'));
        return;
    }
    $('settingsContent').innerHTML = renderFlatSections(statsSections, statsFocusIndex, renderStatsItem);
    scrollSettingsFocusIntoView();
}

function handleStatsInput(gp) {
    const count = statsItemCount();
    navList(gp, statsButtonStates, {
        count,
        move: (d, repeated) => { statsFocusIndex = stepIndex(statsFocusIndex, d, count, repeated); renderStats(); },
        onSelect: () => refreshStats(),
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['stats'] = { open: openStatsView, handle: handleStatsInput };
