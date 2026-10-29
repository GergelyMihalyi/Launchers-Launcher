// Data loading of the Games panel: the root list query (`refreshGamesPanel`), the manual Refresh (`refreshGamesLibrary`), the emulator and
// RetroArch ROM sets loading in the background (registry `background`), and refreshing the open panel's "Recently played" row. The state
// (`gamesPanelRows` etc.) lives in games-panel.js.

// When the background download of a fresh RetroArch cover finishes, main signals on the existing `running-changed` "generic nudge" channel —
// `onRunningChanged` of `renderer/ipc.js` calls this so the root view of a currently OPEN games panel refreshes too, without reopening the
// panel. Not relevant in the system view (`gamesPanelSystem`), no-op.

function refreshGamesPanelRecentIfOpen() {
    if (!gamesPanel.isOpen() || gamesPanelSystem) return;
    window.launcher.listGamesRecent().then((res) => {
        if (!gamesPanel.isOpen() || gamesPanelSystem || !res || !res.ok) return;
        gamesPanelRecent = res.items || [];
        renderGamesPanel();
    }).catch(ignoreError);
}

// The manual "Refresh" (Start/Options in the root view): main clears and rescans EVERY source's cache (`refresh-games`) — so a ROM copied in /
// a game installed while playing shows up without a launcher restart or waiting for the 10-minute TTL (returning from a game only refreshes
// the closed launcher's + the Steam/Heroic/Lutris source, see `warmupSourcesForAppId` of lib/ipc/games-ipc.js). One at a time.
let gamesRefreshInFlight = false;

async function refreshGamesLibrary() {
    if (gamesRefreshInFlight) return;
    gamesRefreshInFlight = true;
    feedback('nav');
    showStatus(tr('games.refreshing'));
    try {
        const res = await window.launcher.refreshGames();
        if (!res || !res.ok) throw new Error('refresh-games');
        if (!gamesPanel.isOpen() || gamesPanelSystem) return; // closed meanwhile / entered the system view
        // The session dedup of the lazy cover download restarts (so the missing cover of a game just discovered gets its turn too).
        unifiedRetroCoverRequested = new Set();
        resetNetworkCoverFetchState();
        await refreshGamesPanel();
        refreshRomAccessInBackground(true); // a flatpak permission granted meanwhile should show too
        showStatus(tr('games.refreshed'));
    } catch (err) {
        showStatus(tr('games.refreshFailed'));
    } finally {
        gamesRefreshInFlight = false;
    }
}


const EMPTY_LIST_RES = { ok: false, items: [] };

// Sandbox visibility of the flatpak emulators' ROM folders — in the background (one `flatpak info` per emulator, the panel opening does
// not wait for it); only the NOT visible folders matter. Error → no warning (no judgement).
function refreshRomAccessInBackground(refresh) {
    window.launcher.getRomAccess({ refresh: !!refresh }).then((res) => {
        if (!gamesPanel.isOpen()) return;
        const hidden = (res && res.ok && Array.isArray(res.items)) ? res.items.filter((it) => it && !it.visible) : [];
        if (!hidden.length && !gamesPanelRomAccess.length) return;
        gamesPanelRomAccess = hidden;
        if (!gamesPanelSystem) renderGamesPanel();
    }).catch(ignoreError);
}

// The keys of the non-RetroArch games for the "NEW" badge (`note-games-seen`): main records the "first seen" time and returns the fresh,
// not yet launched keys. Also called after the emulator rows loading in the background.
let gamesSeenTimer = null;
function noteGamesSeenSoon() {
    clearTimeout(gamesSeenTimer);
    gamesSeenTimer = setTimeout(() => {
        const keys = [];
        for (const r of gamesPanelRows) {
            const k = (r.type === 'game' || EMULATOR_SOURCE_BY_TYPE[r.type]) ? sortKeyOfRow(r) : null;
            if (k) keys.push(k);
        }
        if (!keys.length) return;
        window.launcher.noteGamesSeen(keys).then((res) => {
            if (!res || !res.ok || !gamesPanel.isOpen()) return;
            const next = new Set(res.newKeys || []);
            const same = next.size === gamesNewKeys.size && [...next].every((k) => gamesNewKeys.has(k));
            if (same) return;
            gamesNewKeys = next;
            gamesUnifiedCache = null; // the ALL memo does not depend on it, but the row markers do — redraw
            if (!gamesPanelSystem) renderGamesPanel();
        }).catch(ignoreError);
    }, 400);
}

async function refreshGamesPanel() {
    // The registry emulators' lists over the shared `list-emulator-games` IPC: the `background` sources (melonDS) are NOT awaited — see
    // `refreshEmulatorGamesInBackground`.
    const foreground = EMULATOR_SOURCES.filter((src) => !src.background && !src.custom);
    const [
        gamesRes, retroRes, favs, recentRes, hiddenSources, viewModeMap, customRes, sortModeMap, sortStatsRes, hiddenGames, ...emulatorRes
    ] = await Promise.all([
        window.launcher.listGames().catch(() => EMPTY_LIST_RES),
        window.launcher.listRetroarchSystems().catch(() => EMPTY_LIST_RES),
        window.launcher.getFavoriteGames().catch(() => []),
        window.launcher.listGamesRecent().catch(() => EMPTY_LIST_RES),
        window.launcher.getGamesHiddenSources().catch(() => []),
        window.launcher.getGamesViewMode().catch(() => ({})),
        window.launcher.listCustomGames().catch(() => EMPTY_LIST_RES),
        window.launcher.getGamesSortMode().catch(() => ({})),
        window.launcher.getGamesSortStats().catch(() => EMPTY_LIST_RES),
        window.launcher.getHiddenGames().catch(() => []),
        ...foreground.map((src) => window.launcher.listEmulatorGames({ source: src.id }).catch(() => EMPTY_LIST_RES)),
    ]);
    if (!gamesPanel.isOpen()) return; // closed meanwhile

    gamesPanelFavorites = Array.isArray(favs) ? favs : [];
    gamesHiddenSources = new Set(Array.isArray(hiddenSources) ? hiddenSources : []);
    gamesViewModeMap = (viewModeMap && typeof viewModeMap === 'object' && !Array.isArray(viewModeMap))
        ? viewModeMap : {};
    gamesSortModeMap = (sortModeMap && typeof sortModeMap === 'object' && !Array.isArray(sortModeMap)) ? sortModeMap : {};
    gamesSortStats = (sortStatsRes && sortStatsRes.ok && sortStatsRes.items && typeof sortStatsRes.items === 'object') ? sortStatsRes.items : {};
    gamesHiddenGames = new Set(Array.isArray(hiddenGames) ? hiddenGames : []);
    gamesPanelLoadOk = gamesRes.ok && retroRes.ok;
    // The recent bar AND the emulator lists are only "nice to have" — a failed query gives a silent empty result and does not spoil the load
    // state of the whole panel (gamesPanelLoadOk): on most machines each one is simply empty (not installed / no ROM folder).
    gamesPanelRecent = (recentRes && recentRes.ok) ? (recentRes.items || []) : [];
    gamesPanelRows = [
        ...(gamesRes.items || []).map(gameListRowFromApi),
        ...(retroRes.items || []).map((r) => ({ type: 'retro-system', system: r.system, count: r.count })),
        // The emulators: NO "N games, enter" summary — every single game is directly a root list row.
        ...foreground.flatMap((src, i) => emulatorRowsFromRes(src, emulatorRes[i])),
        // Custom ROM-folder sources — badge: the launcher name.
        ...customGameRowsFromApi(customRes && customRes.ok ? customRes.items : [], launchers),
    ];
    gamesPanelFocusIndex = gamesPanelRows.length ? Math.min(gamesPanelFocusIndex, gamesPanelRows.length - 1) : 0;
    renderGamesPanelHint(); // the source-filter hint only becomes known now (>1 source)
    renderGamesPanel();
    noteGamesSeenSoon();

    for (const src of EMULATOR_SOURCES) if (src.background) refreshEmulatorGamesInBackground(src);
    refreshRetroAllGamesInBackground();
    refreshRomAccessInBackground(false);
    // The lazy cover download of the network-downloading launchers is scheduled from the tail of `renderGamesPanel()` above — no separate
    // call here.
}

// A `list-emulator-games` response → root list rows (`type: '<id>-game'`); error → empty.
function emulatorRowsFromRes(src, res) {
    const items = (res && res.ok && Array.isArray(res.items)) ? res.items : [];
    return items.map((g) => ({ type: src.type, ...g }));
}

// The registry's `background: true` sources (melonDS today) are requested SEPARATELY, independent of the Promise.all above, in the
// BACKGROUND — not blocking the panel's opening/rendering. The persistent file cache only speeds up the SECOND+ open within a session — the
// FIRST scan after a launcher start is still slow for a big/network ROM collection (~1.6 s for the user). So the panel opens immediately
// without it, and the rows "pop" into the list when the query finishes (the user can browse the other sources meanwhile).

function refreshEmulatorGamesInBackground(src) {
    window.launcher.listEmulatorGames({ source: src.id }).then((res) => {
        if (!gamesPanel.isOpen() || gamesPanelSystem) return; // closed meanwhile / entered the system view
        const rows = emulatorRowsFromRes(src, res);
        if (!rows.length) return; // nothing to append to the already rendered list
        gamesPanelRows = [...gamesPanelRows.filter((r) => r.type !== src.type), ...rows];
        gamesPanelFocusIndex = Math.min(gamesPanelFocusIndex, gamesPanelRows.length - 1);
        renderGamesPanelHint(); // the source-filter chip only appears now
        renderGamesPanel();
        noteGamesSeenSoon();
    }).catch(ignoreError);
}

// The full RetroArch ROM set (~15,700 items) loads SEPARATELY, in the background, into the shared "ALL" list (the melonDS pattern — the panel
// opens immediately with the other sources while RetroArch shows the summary row below, then the ROMs pop into the list when the query
// finishes and the summary disappears). With an unchanged set (system:count signature) the fresh response is dropped, so the already patched
// (lazily downloaded) covers stay. On a failed query (`ok: false`) everything stays in the old summary state.

function refreshRetroAllGamesInBackground() {
    window.launcher.listRetroarchAllGames().then((res) => {
        if (!gamesPanel.isOpen() || !res || !res.ok || !Array.isArray(res.items)) return;
        const sig = res.items.map((g) => `${g.system}:${(g.games || []).length}`).join('|');
        if (gamesPanelRetroUnified && sig === gamesPanelRetroSig) return;
        gamesPanelRetroSig = sig;
        gamesPanelRetroUnified = retroGroupsToUnifiedRows(res.items);
        if (gamesPanelSystem) return; // nothing to redraw in the system view; it renders on exit
        renderGamesPanel();
    }).catch(ignoreError);
}
