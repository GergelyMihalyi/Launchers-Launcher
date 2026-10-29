// Games panel — a STANDALONE overlay (NOT a Settings subview): opens from the carousel's GAMES_CARD pseudo-launcher card (gamepad.js
// `launchApp()` calls `openGamesPanel()`). This file is the "controller": panel lifecycle (open/close/refresh), pinning, the shared
// `startGameLaunch()` launch entry and the gamepad input dispatch (`handleGamesPanelInput`). The other responsibilities live in the sibling
// files (all loaded AFTER carousel.js, BEFORE card-menu.js): sources (source tables) · covers (lazy covers) · search (live search) · render
// (HTML builders + `renderGamesPanel()`) · unified (ALL list + virtualization) · favorites · filter (source filter popup) · details (game
// details) · data (loading/refresh).
// **A two-level view ONLY for RetroArch** (root "system" row → the system's FULL ROM list as a cover grid, L2/R2 letter jump;
// `openRetroSystem`/`backFromRetroSystem`) — the ~15,700 item set would be unnavigable in one piece. There is NO drill-down for the
// emulators: the root view lists the games directly (`{ type: '<x>-game' }` rows, `EMULATOR_SOURCES`-driven, a cover grid by default,
// switchable to a list with `gamesViewMode`). The "Recently played" SUMMARY bar sits above the shared list in the ALL filter
// (`list-games-recent` → `usage.globalRecentGames(10)`). Background: docs/dev/games-panel.md#the-panel-ui


let gamesPanelRows = []; // root list: [{ type: 'game', name, source, cover } | { type: 'retro-system', system, count } | { type: 'ryujinx-game'|'pcsx2-game'|'duckstation-game', id, name, path, ..., cover }]

let gamesPanelVisibleRows = []; // the rows actually visible in the root view (source-filtered) - the focus moves on these

let gamesPanelSource = 'all'; // the active source filter — 'all' | 'fav' | steam/gog/legendary/nile | 'retro'

let gamesPanelFavorites = []; // pinned favorite games (get-favorite-games IPC)

let gamesPanelFocusIndex = 0;


let gamesPanelLoadOk = true;

let gamesPanelGridCols = 1; // the cover grid's column count (measured after rendering)


// Grid/list display per source (`gamesViewMode` config key, Settings → Games → "Grid or list" subview). Only stores the DEVIATIONS —
// `effectiveViewMode()` gives the actual mode. main does not push it live (no push listener) — Settings and the Games panel are two
// separate, mutually exclusive overlays, and `refreshGamesPanel()` requests fresh data at the next open/refresh of the panel anyway, like
// for `gamesHiddenSources`.

let gamesViewModeMap = {};

// Sort order per source (`gamesSortMode`; toggled with R3) + the per-game sort data (`get-games-sort-stats`: { <favorite-key>: { at,
// totalMs } }). Loaded when the panel opens/refreshes.
let gamesSortModeMap = {};
let gamesSortStats = {};

// "ALL" + RetroArch (see the block above `NAME_COLLATOR`): the full ROM set as `'unified'` rows; `null` = the background load has not happened
// yet (or failed) — the ALL view then shows the old per-system summary. The row objects are PERSISTENT (the cover download writes `cover` in
// place); `Sig` is the system:count signature of the last load (with an unchanged set a reload drops the fresh data so the patched covers
// stay).

let gamesPanelRetroUnified = null;

let gamesPanelRetroSig = '';

// "Recently played" SUMMARY bar from EVERY launcher (Steam + Heroic + RetroArch) — the `list-games-recent` IPC returns at most 10 items
// (`usage.globalRecentGames(10)`, the same basis as the header's "▶ Continue" bar, just with more items). Only lives in the "ALL" source
// filter, and sits at the VERY START of the `gamesPanelVisibleRows` flat list as ONE `{ type: 'recent', items }` row — both the cover grid
// AND the RetroArch system list appear BELOW it.
let gamesPanelRecent = [];

// The flatpak emulator ROM folders the sandbox does NOT see (`get-rom-access`): [{ source, name, dir }] — a warning row at the top of the
// list (the launcher lists it, the emulator cannot find it).
let gamesPanelRomAccess = [];

let gamesPanelRecentItemFocus = 0; // index of the focused mini cover within the bar

// After entering a system: a sub-state independent of the root, ONLY for RetroArch (Ryujinx/PCSX2 are not drill-downs but direct root-list
// rows). `null` = the root view is active.

let gamesPanelSystem = null;

let gamesPanelSystemGames = []; // [{ label, path, cover }]

let gamesPanelRootFocusIndex = 0; // the root's focus while a system view is active


// --- Panel lifecycle ---

// `initialSource` (optional) — the "Open games" quick-menu row of a launcher card (openGamesPanelForLauncher) opens with a preselected source
// filter this way; the normal GAMES_CARD / △ entry calls it without a parameter, the 'all' default stays. Lifecycle on the shared
// `createOverlay` (renderer/util.js). The root view and the RetroArch system view use the SAME `gamesPanel.states` (not swapped on a view
// change).
const gamesPanel = createOverlay({
    elementId: 'gamesOverlay',
    // The panel must not take the opening Cross (from the carousel card) as an immediate selection.
    enterStates: { cross: true },
    // The main navigation's buttonStates were not updated while the panel was open — otherwise the main branch would see the closing
    // (Circle/PS) and the opening (Cross) button as new presses (immediate `quit()` / relaunching the focused card).
    syncOnClose: () => ({ states: buttonStates, keys: ['cross', 'ps', 'start'] }),
    onOpen: (initialSource) => {
        // Location memory: an open without parameters (△ / GAMES_CARD / back from a game) continues where the panel was closed; the card menu's
        // "Open games" (a specific source) starts from the top.
        const mem = initialSource ? null : gamesPanelMemory;
        gamesPanelSystem = null;
        gamesFilter.reset();
        gamesPanelFocusIndex = mem ? mem.focusIndex : 0;
        gamesPanelPendingFocusKey = mem ? mem.focusKey : null;
        gamesPanelRecentItemFocus = mem ? mem.recentItemFocus : 0;
        gamesPanelSource = initialSource || (mem && mem.source) || 'all';
        showTipOnce('gamesPanel');
        gamesPanelQuery = mem ? mem.query : '';
        gamesSearchTyping = false;
        setGamesSearchDock(false);
        unifiedRetroCoverRequested = new Set();
        resetNetworkCoverFetchState();
        $('gamesPanelContent').innerHTML = skeletonList();
        renderGamesPanelHint();
        refreshGamesPanel().then(() => {
            // It was closed inside a RetroArch system's ROM list → step back there, onto the ROM.
            if (!mem || !mem.system || !gamesPanel.isOpen() || gamesPanelSystem) return;
            const i = gamesPanelVisibleRows.findIndex((r) => r.type === 'retro-system' && r.system === mem.system);
            if (i < 0) return;
            gamesPanelFocusIndex = i;
            gamesPanelPendingFocusKey = null;
            openRetroSystem(mem.system, mem.systemFocusKey).catch(ignoreError);
        }).catch(ignoreError);
    },
    onClose: () => { gamesPanelMemory = captureGamesPanelMemory(); },
});

// --- Location memory (user decision: only for the current run, no config key) ---
// On close (○ OR launching a game from the panel) we save where the focus was; the next open without parameters returns here. The focus is
// restored by KEY (not by index): the list may refresh meanwhile, and the full RetroArch set loads in the background —
// `gamesPanelPendingFocusKey` lives until the item appears or the user moves away.
let gamesPanelMemory = null;
let gamesPanelPendingFocusKey = null;

// The stable id of a root-view row (like the favorite keys, see `focusedGameEntry` in games-panel-favorites.js).
function gamesRowKey(row) {
    if (!row) return null;
    if (row.type === 'recent') return 'recent';
    if (row.type === 'retro-system') return `sys:${row.system}`;
    if (row.type === 'unified') return row.favKey || null;
    if (row.type === 'favorite') return row.key || null;
    if (row.type === 'game') return gameRowKey(row) || null;
    const src = EMULATOR_SOURCE_BY_TYPE[row.type];
    return src ? `${src.keyPrefix}-${row[src.idField]}` : null;
}

function captureGamesPanelMemory() {
    if (gamesPanelSystem) {
        const g = systemGamesView()[gamesPanelFocusIndex];
        return {
            source: gamesPanelSource, query: '', focusIndex: gamesPanelRootFocusIndex,
            focusKey: `sys:${gamesPanelSystem}`, recentItemFocus: 0,
            system: gamesPanelSystem, systemFocusKey: g ? g.path : null,
        };
    }
    return {
        source: gamesPanelSource, query: gamesPanelQuery, focusIndex: gamesPanelFocusIndex,
        focusKey: gamesRowKey(gamesPanelVisibleRows[gamesPanelFocusIndex]),
        recentItemFocus: gamesPanelRecentItemFocus, system: null, systemFocusKey: null,
    };
}

// Called by renderGamesPanel() after computing the visible rows: if the item to restore is already in the list, sets the focus on it.
function applyPendingGamesFocus() {
    if (!gamesPanelPendingFocusKey) return;
    const i = gamesPanelVisibleRows.findIndex((r) => gamesRowKey(r) === gamesPanelPendingFocusKey);
    if (i < 0) return;
    gamesPanelFocusIndex = i;
    gamesPanelPendingFocusKey = null;
}

// `initialSource` (optional) — see above.
function openGamesPanel(initialSource) { gamesPanel.open(initialSource); }

function closeGamesPanel(gp) { gamesPanel.close(gp); }


function cycleSource(dir) {
    const list = availableSources();
    if (list.length < 2) return;
    gamesPanelSource = nextInCycle(list, gamesPanelSource, dir);
    gamesPanelFocusIndex = 0;
    gamesPanelPendingFocusKey = null;
    renderGamesPanelHint();
    // The lazy cover download of the network-downloading launchers (Ryujinx/PCSX2/Dolphin/DuckStation) is scheduled from the tail of
    // `renderGamesPanel()` (the RetroArch pattern) — no separate call here.
    renderGamesPanel();
    feedback('nav');
}


// R3: switches the source's sort order (name → last played → playtime). Favorites and RetroArch (no per-ROM data) cannot be sorted; the
// mode is kept per source (`gamesSortMode`).
function cycleSortMode() {
    const id = gamesPanelSource;
    if (id === 'fav' || id === 'retro') { feedback('back'); return; }
    const next = nextSortMode(effectiveSortMode(gamesSortModeMap, id));
    gamesSortModeMap = { ...gamesSortModeMap, [id]: next };
    window.launcher.setGamesSortMode(id, next);
    gamesPanelFocusIndex = 0;
    gamesPanelPendingFocusKey = null;
    renderGamesPanel();
    feedback('nav');
    showStatus(tr('games.sortMode', { mode: tr(`games.sort.${next}`) }));
}

// Opens the full ROM list of a system (X on a root "retro-system" row). For big systems (e.g. NES ~5000 items) in the cover grid ▲▼◀▶ =
// plain grid navigation, L2/R2 = letter jump. `focusPath` (optional) — location memory: focus this ROM after the list loads.
async function openRetroSystem(system, focusPath) {
    gamesPanelRootFocusIndex = gamesPanelFocusIndex;
    gamesPanelSystem = system;
    gamesPanelFocusIndex = 0;
    gamesPanelPendingFocusKey = null;
    gamesPanelQuery = ''; // the drill-down is a separate search scope
    resetRetroCoverFetchState();
    $('gamesPanelContent').innerHTML = skeletonList();
    renderGamesPanelHint();

    const res = await window.launcher.listRetroarchGames(system);
    if (!gamesPanel.isOpen() || gamesPanelSystem !== system) return; // closed/left meanwhile

    if (!res.ok) {
        $('gamesPanelContent').innerHTML =
            emptyState(tr('games.retroListFailed'), `${btnGlyph('back')} ${tr('hint.back').toUpperCase()}`);
        return;
    }
    gamesPanelSystemGames = res.items || [];
    if (focusPath) gamesPanelFocusIndex = Math.max(0, gamesPanelSystemGames.findIndex((g) => g.path === focusPath));
    renderGamesPanel();
}


function backFromRetroSystem() {
    gamesPanelSystem = null;
    gamesPanelSystemGames = [];
    gamesPanelQuery = '';
    gamesPanelFocusIndex = gamesPanelRootFocusIndex;
    resetRetroCoverFetchState();
    renderGamesPanelHint();
    renderGamesPanel();
}

// SHARED entry of a game-level launch: the root and system views AND the quick-launch bar (`launchRecentGame`) call it — the `kind → launch
// IPC` mapping in one place. Every IPC goes through main's normal `spawnGame()`, hence the same `isLaunching` + `showLoading` +
// `armLaunchWatchdog`.
//   kind      — 'steam' | 'heroic' | 'retroarch' | 'lutris' | the id of a registry emulator (launcher-registry.js)
//   params    — the launch IPC parameters (steam: {appid}; heroic: {appName, runner}; retroarch: {system, path}; lutris: {id}; emulator: the registry's `launchParams`)
//   name/cover — the loading overlay's title + the quick-launch bar cover (for derived sources: derived)
//   fromPanel — the Games overlay must be closed first

/**
 * @param {{ kind: string, params?: Object, name?: string, cover?: string|null, fromPanel?: boolean }} opts
 */
function startGameLaunch({ kind, params, name, cover, fromPanel }) {
    if (isLaunching) return;
    const p = params || {};
    const send = {
        steam: () => window.launcher.launchSteamGame({ appid: p.appid, name, cover: cover || null }),
        heroic: () => window.launcher.launchHeroicGame({ appName: p.appName, runner: p.runner, name, cover: cover || null }),
        retroarch: () => window.launcher.launchRetroarchGame({ system: p.system, path: p.path, name }),
        lutris: () => window.launcher.launchLutrisGame({ id: p.id }),
        // Custom ROM-folder source — over the `launch-custom-game` IPC.
        custom: () => window.launcher.launchCustomGame({ launcherId: p.launcherId, path: p.path, name }),
    }[kind] || (EMULATOR_SOURCE_BY_ID[kind]
        // The registry emulators over the SHARED `launch-emulator-game` IPC — `params` come from the registry's `launchParams`
        // (`launch(row)` of games-panel-sources.js); `name`/`cover` are needed for the "recently played" booked at launch time.
        ? () => window.launcher.launchEmulatorGame({ ...p, source: kind, name, cover: cover || null })
        : null);
    if (!send) return;
    if (fromPanel) closeGamesPanel();
    feedback('launch');
    isLaunching = true;
    recentBarFocus = -1;
    renderRecentBar();
    showLoading(name, tr('verb.launching'), kind, cover);
    send();
    armLaunchWatchdog();
}


// --- Input ---

// `repeated` = repeat of a held direction (edgeRepeat) — sound only then, no rumble.
function focusRow(ni, repeated) {
    gamesPanelPendingFocusKey = null; // the user navigated away — the location memory no longer overrides it
    if (ni !== gamesPanelFocusIndex) {
        gamesPanelFocusIndex = ni;
        // When entering the recent bar the focus always goes to the first mini cover (not the earlier ◀▶ position if we were here before at a bigger
        // index).
        const row = gamesPanelVisibleRows[ni];
        if (row && row.type === 'recent') gamesPanelRecentItemFocus = 0;
        renderGamesPanel();
        feedback('nav', { repeated });
    }
}


function selectRootRow() {
    const row = gamesPanelVisibleRows[gamesPanelFocusIndex];
    if (!row) return;
    if (row.type === 'recent') {
        const item = row.items[gamesPanelRecentItemFocus];
        if (item) startGameLaunch({ kind: item.kind, params: item.params, name: item.name, cover: item.cover, fromPanel: true });
        return;
    }
    if (row.type === 'retro-system') {
        feedback('nav');
        openRetroSystem(row.system);
        return;
    }
    if (row.type === 'unified') {
        startGameLaunch({ ...row.launch, name: row.name, cover: row.cover, fromPanel: true });
        return;
    }
    if (row.type === 'favorite') {
        startGameLaunch({ kind: row.kind, params: row.params, name: row.name, cover: row.cover, fromPanel: true });
        return;
    }
    const emu = EMULATOR_SOURCE_BY_TYPE[row.type]; // ryujinx-game / pcsx2-game / cemu-game / …
    if (emu) {
        startGameLaunch({ ...emu.launch(row), name: row.name, cover: row.cover, fromPanel: true });
        return;
    }
    const src = GAME_SOURCE_BY_ID[row.source]; // steam / gog / legendary / nile
    if (src) startGameLaunch({ ...src.launch(row), name: row.name, cover: row.cover, fromPanel: true });
}

// The letter jump (L2/R2, RetroArch system ROM view) repeats slower than stepping when held.

const LETTER_REPEAT_INTERVAL_MS = 150;


function handleGamesPanelInput(gp) {
    if (gamesPanelSystem) {
        // In grid mode plain grid navigation, like the root grid (`gridNavIndex`, headRows: 0, every entry is a grid cell). This replaced the old
        // D-pad "page by 12". In list mode ◀▶ is a no-op, ▲▼ a simple ±1 step. The L2/R2 letter jump is unchanged in BOTH modes (index-based).
        const view = systemGamesView();
        const count = view.length;
        const st = gamesPanel.states;
        const grid = effectiveViewMode(gamesViewModeMap, 'retro') === 'grid';
        const nav = (dir, rep) => {
            if (!grid) {
                if (dir === 'up') focusRow(Math.max(0, gamesPanelFocusIndex - 1), rep);
                else if (dir === 'down') focusRow(Math.min(count - 1, gamesPanelFocusIndex + 1), rep);
                return;
            }
            focusRow(gridNavIndex(gamesPanelFocusIndex, dir, gamesPanelGridCols, count, count, 0), rep);
        };
        // A held direction / letter jump repeats (edgeRepeat).
        edgeRepeat(st, 'up', gp.buttons[BTN.up]?.pressed, (rep) => nav('up', rep));
        edgeRepeat(st, 'down', gp.buttons[BTN.down]?.pressed, (rep) => nav('down', rep));
        edgeRepeat(st, 'left', gp.buttons[BTN.left]?.pressed, (rep) => nav('left', rep));
        edgeRepeat(st, 'right', gp.buttons[BTN.right]?.pressed, (rep) => nav('right', rep));
        edgeRepeat(st, 'letterPrev', gp.buttons[BTN.l2]?.pressed, (rep) => focusRow(nextLetterIndex(view.map((g) => g.label), gamesPanelFocusIndex, -1), rep), { interval: LETTER_REPEAT_INTERVAL_MS });
        edgeRepeat(st, 'letterNext', gp.buttons[BTN.r2]?.pressed, (rep) => focusRow(nextLetterIndex(view.map((g) => g.label), gamesPanelFocusIndex, 1), rep), { interval: LETTER_REPEAT_INTERVAL_MS });
        edge(st, 'pin', gp.buttons[BTN.triangle]?.pressed, () => toggleFavoriteFocused()); // △ = pin
        edge(st, 'search', gp.buttons[BTN.select]?.pressed, () => openGamesSearch()); // Select/View = search
        // short ✕ = launch (on release), long = details view (games-panel-details.js).
        edgeHold(st, 'cross', gp.buttons[BTN.cross]?.pressed, () => {
            const game = view[gamesPanelFocusIndex];
            if (!game) return;
            startGameLaunch({
                kind: 'retroarch', params: { system: gamesPanelSystem, path: game.path }, name: game.label,
                cover: game.cover, fromPanel: true,
            });
        }, () => openGameDetailsForFocused());
        edge(st, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
            feedback('back');
            if (gamesPanelQuery) setGamesQuery(''); // with an active search the first back only clears it
            else backFromRetroSystem();
        });
        return;
    }

    // Root view: (optional summary recent bar) + (source-filtered) cover grid + retro list rows. ▲▼ = row, ◀▶ = column, L2/R2 = switch the
    // source filter.
    const total = gamesPanelVisibleRows.length;
    const headRows = gamesPanelVisibleRows[0] && gamesPanelVisibleRows[0].type === 'recent' ? 1 : 0;
    const st = gamesPanel.states;
    // `nGames` (the number of grid cells) is only needed on an edge — on the ~16,000 row ALL + RetroArch list a per-frame (60 fps) `filter`
    // would be a needless load.
    const nav = (dir, rep) => {
        const nGames = gamesPanelVisibleRows.filter(isGridRow).length;
        focusRow(gridNavIndex(gamesPanelFocusIndex, dir, gamesPanelGridCols, nGames, total, headRows), rep);
    };
    // ◀▶ on the recently-played bar steps between the mini covers (not a row/column switch) — elsewhere the usual grid navigation (for the
    // retro-system list rows gridNavIndex is already a no-op on ◀▶).
    const onHorizontal = (dir, rep) => {
        const row = gamesPanelVisibleRows[gamesPanelFocusIndex];
        if (row && row.type === 'recent') {
            const n = row.items.length;
            const ni = Math.max(0, Math.min(n - 1, gamesPanelRecentItemFocus + dir));
            if (ni !== gamesPanelRecentItemFocus) {
                gamesPanelRecentItemFocus = ni;
                renderGamesPanel();
                feedback('nav', { repeated: rep });
            }
            return;
        }
        nav(dir > 0 ? 'right' : 'left', rep);
    };
    edgeRepeat(st, 'up', gp.buttons[BTN.up]?.pressed, (rep) => nav('up', rep));
    edgeRepeat(st, 'down', gp.buttons[BTN.down]?.pressed, (rep) => nav('down', rep));
    edgeRepeat(st, 'left', gp.buttons[BTN.left]?.pressed, (rep) => onHorizontal(-1, rep));
    edgeRepeat(st, 'right', gp.buttons[BTN.right]?.pressed, (rep) => onHorizontal(1, rep));
    edge(st, 'srcPrev', gp.buttons[BTN.l2]?.pressed, () => cycleSource(-1));
    edge(st, 'srcNext', gp.buttons[BTN.r2]?.pressed, () => cycleSource(1));
    edge(st, 'pin', gp.buttons[BTN.triangle]?.pressed, () => toggleFavoriteFocused()); // △ = pin
    // □ Square → source filter popup — only in the root view, and only if there are at least 2 sources (like the discoverability of the L2/R2
    // hint).
    edge(st, 'square', gp.buttons[BTN.square]?.pressed, () => {
        if (filterableSources().length > 1 || gamesHiddenGames.size) openGamesSourceFilter();
    });
    edge(st, 'search', gp.buttons[BTN.select]?.pressed, () => openGamesSearch()); // Select/View = search
    edge(st, 'sort', gp.buttons[BTN.r3]?.pressed, () => cycleSortMode()); // R3 = switch the sort order
    edge(st, 'refresh', gp.buttons[BTN.start]?.pressed, () => refreshGamesLibrary()); // Start/Options = refresh
    // short ✕ = open/launch (on release), long = details view — where there is nothing to show (a RetroArch system row), the hold runs as a
    // short press too.
    edgeHold(st, 'cross', gp.buttons[BTN.cross]?.pressed, () => selectRootRow(), () => openGameDetailsForFocused());
    edge(st, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        if (gamesPanelQuery) setGamesQuery(''); // with an active search the first back only clears it
        else closeGamesPanel(gp);
    });
}

