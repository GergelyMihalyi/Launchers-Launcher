// Settings → Games → "Recently played bars": the 3 independent "recently played" surfaces on/off (`recentGamesUi` key); a toggle is live
// immediately (writes `recentGamesUiState` too) and persists. On the `createMultiToggleSubview` factory; the NAMES
// `recentGamesUiState`/`renderRecentGamesUiView` stay (`onRecentGamesUiChanged` of renderer/ipc.js references them). Load order: AFTER
// settings-toggle.js, BEFORE ipc.js.

const RECENT_GAMES_UI_ROWS = [
    { key: 'continueBar', labelKey: 'sv.rguContinueBar' },
    { key: 'gamesPanelRecent', labelKey: 'sv.rguGamesPanel' },
    { key: 'launcherRecent', labelKey: 'sv.rguLauncherBar' },
];

const recentGamesUiView = createMultiToggleSubview({
    id: 'recent-games',
    hintKey: 'hint.toggle',
    rows: RECENT_GAMES_UI_ROWS,
    getState: () => recentGamesUiState,
    setState: (next) => { recentGamesUiState = next; },
    persist: (patch) => window.launcher.setRecentGamesUi(patch),
    // Whichever of the 3 bars was toggled, all three must be refreshed (the games panel only if it is open).
    afterToggle: () => {
        renderContinueBar();
        renderRecentBar();
        if (gamesPanel.isOpen()) renderGamesPanel();
    },
});

function renderRecentGamesUiView() { recentGamesUiView.render(); }

SETTINGS_VIEWS['recent-games'] = recentGamesUiView;
