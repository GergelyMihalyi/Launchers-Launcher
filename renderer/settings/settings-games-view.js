// Settings → Games → "Grid or list": the Games panel display per source — ALL + every launcher source (Steam/GOG/Epic/Amazon/Lutris/RetroArch
// + every EMULATOR_SOURCES emulator) INDEPENDENTLY of each other. The `★ FAVORITE` filter and the RetroArch root summary cannot be switched.
// The rows are FIXED lists (the view of a launcher not installed yet can be preset too). ✕ = toggle (persists immediately, does not close).
// Load order: AFTER settings.js + games-panel.js (uses the `GAME_SOURCES`/`EMULATOR_SOURCES`/`filterChipLabel`/`effectiveViewMode` globals).

// The fixed-order id list built from the source tables of games-panel.js — 'all' + the Steam/GOG/Epic/Amazon/Lutris chips + 'retro' (the
// RetroArch system ROM drill-down) + every EMULATOR_SOURCES emulator.
const GAMES_VIEW_ROW_IDS = [
    'all', ...GAME_SOURCES.map((s) => s.id), 'retro', ...EMULATOR_SOURCES.map((s) => s.id),
];

let gamesViewSettingsMap = {};
let gamesViewFocusIndex = 0;
let gamesViewButtonStates = {};

async function openGamesViewModeView() {
    setSubviewFrame({ title: tr('menu.games-view'), hint: 'hint.switch', skeleton: true });
    gamesViewButtonStates = { cross: true };
    gamesViewFocusIndex = 0;
    const res = await window.launcher.getGamesViewMode().catch(() => ({}));
    if (settingsView !== 'games-view') return;
    gamesViewSettingsMap = (res && typeof res === 'object' && !Array.isArray(res)) ? res : {};
    renderGamesViewModeView();
}

function renderGamesViewModeView() {
    const rows = GAMES_VIEW_ROW_IDS.map((id, i) => {
        const mode = effectiveViewMode(gamesViewSettingsMap, id);
        const badge = mode === 'grid' ? tr('sv.gamesViewGrid') : tr('sv.gamesViewList');
        const focused = i === gamesViewFocusIndex ? ' focused' : '';
        return `<div class="settings-item${focused}"><span class="bt-name">${esc(filterChipLabel(id))}</span>`
            + ` ${currentTag(badge)}</div>`;
    });
    $('settingsContent').innerHTML = rows.join('');
    scrollSettingsFocusIntoView();
}

function toggleGamesViewModeFocused() {
    const id = GAMES_VIEW_ROW_IDS[gamesViewFocusIndex];
    if (!id) return;
    const next = effectiveViewMode(gamesViewSettingsMap, id) === 'grid' ? 'list' : 'grid';
    gamesViewSettingsMap = { ...gamesViewSettingsMap, [id]: next };
    window.launcher.setGamesViewMode(id, next);
    renderGamesViewModeView();
}

function handleGamesViewModeInput(gp) {
    navList(gp, gamesViewButtonStates, {
        count: GAMES_VIEW_ROW_IDS.length,
        move: (d, repeated) => {
            const n = GAMES_VIEW_ROW_IDS.length;
            gamesViewFocusIndex = stepIndex(gamesViewFocusIndex, d, n, repeated);
            renderGamesViewModeView();
        },
        onSelect: () => toggleGamesViewModeFocused(),
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['games-view'] = { open: openGamesViewModeView, handle: handleGamesViewModeInput };
