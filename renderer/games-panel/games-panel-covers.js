// Games panel — lazy cover download. Two independent branches with a shared focus-windowed + debounced + session-deduped pattern:
// (1) covers of the RetroArch system ROM grid and of the RetroArch rows of the ALL list (`retroCoverRequested`/`scheduleRetroCoverFetch`,
// `unifiedRetroCoverRequested`/`scheduleUnifiedRetroCoverFetch`); (2) the network covers of the Ryujinx/PCSX2/Dolphin/DuckStation root grid
// (`networkCoverFetch`/`scheduleNetworkCoverFetch` — by the `networkCover` field of `EMULATOR_SOURCES`). The Cemu/RPCS3/PPSSPP/melonDS covers
// come from local decoding (nothing to do here). Load order: AFTER games-panel-sources.js. The pure helpers
// (`retroCoverBatchLabels`/`visibleMissingCoverIds`) are exported (test/games-panel/games-panel.test.js). Background: docs/dev/games-panel.md#covers

// SHARED lazy cover download parameters for the 5 network-downloading launchers (RetroArch + Ryujinx/PCSX2/Dolphin/DuckStation):
// `COVER_FETCH_WINDOW` is the item range in BOTH directions around the focus index (not a pixel/DOM measurement — controller navigation moves
// in discrete jumps); `COVER_FETCH_DEBOUNCE_MS` throttles the request during fast nav steps (one batch only after "settling"). No per-launcher
// tuning — the value tuned for the big (~15,700 item) RetroArch list is fine for the smaller ones too.
const COVER_FETCH_WINDOW = 24;
const COVER_FETCH_DEBOUNCE_MS = 200;

// Lazy, windowed cover download state of the Ryujinx/PCSX2/Dolphin/DuckStation root grid, per launcher (keyed by the `id` of
// `EMULATOR_SOURCES`) — a generalization of RetroArch's `retroCoverRequested`/`unifiedRetroCoverRequested` pattern, see
// `scheduleNetworkCoverFetch()`/`fetchVisibleNetworkCovers()` below. `requested` = ids already requested IN THIS panel session (dedup, so a
// failed/404 attempt is not repeated needlessly); `timer` = the running debounce timer.
const networkCoverFetch = {};
function networkCoverState(sourceId) {
    if (!networkCoverFetch[sourceId]) networkCoverFetch[sourceId] = { requested: new Set(), timer: null };
    return networkCoverFetch[sourceId];
}
// Called when `#gamesOverlay` OPENS (see `openGamesPanel()`) — the dedup state of every network-downloading launcher is reset in one go,
// like the reset of `unifiedRetroCoverRequested`/`gamesPanelQuery`.
function resetNetworkCoverFetchState() {
    for (const src of EMULATOR_SOURCES) {
        if (!src.networkCover) continue;
        const st = networkCoverState(src.id);
        if (st.timer) clearTimeout(st.timer);
        st.timer = null;
        st.requested = new Set();
    }
}

// Session dedup set of the RetroArch covers lazily downloaded in the ALL grid (`system\0label`).
let unifiedRetroCoverRequested = new Set();
let unifiedRetroCoverTimer = null;

// Lazy cover download state of the RetroArch system ROM grid. `retroCoverRequested` — which labels we already requested IN THIS system-view
// session (a voluntary session dedup: does not ask again even after a 404 while the user stays in the system); emptied by
// `openRetroSystem()`/`backFromRetroSystem()`.
let retroCoverRequested = new Set();
let retroCoverFetchTimer = null;

// Lazy cover download of the RetroArch system ROM grid: the labels of the entries STILL WITHOUT A COVER within `windowSize` (in both
// directions) around `focusIndex`, deduped (the same label may in theory occur within a system). Pure function, no network/IPC — called by
// `scheduleRetroCoverFetch()`, which sends the returned list to the `ensure-retroarch-game-covers` IPC.
function retroCoverBatchLabels(games, focusIndex, windowSize) {
    if (!Array.isArray(games) || !games.length) return [];
    const from = Math.max(0, focusIndex - windowSize);
    const to = Math.min(games.length - 1, focusIndex + windowSize);
    const out = [];
    const seen = new Set();
    for (let i = from; i <= to; i++) {
        const g = games[i];
        if (g && !g.cover && g.label && !seen.has(g.label)) {
            seen.add(g.label);
            out.push(g.label);
        }
    }
    return out;
}

// For the Ryujinx/PCSX2/Dolphin/DuckStation root grid: a generalization of `retroCoverBatchLabels()` to `row.id` (instead of RetroArch's
// `label` — every EMULATOR_SOURCES grid row carries it as a stable id, see `gridCellKey()`). Pure function, no network/IPC.
function visibleMissingCoverIds(rows, focusIndex, windowSize) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const from = Math.max(0, focusIndex - windowSize);
    const to = Math.min(rows.length - 1, focusIndex + windowSize);
    const out = [];
    const seen = new Set();
    for (let i = from; i <= to; i++) {
        const r = rows[i];
        if (r && !r.cover && r.id && !seen.has(r.id)) {
            seen.add(r.id);
            out.push(r.id);
        }
    }
    return out;
}

// Called AFTER rendering the root grid (the tail of `renderGamesPanel()`, `rows`/`offset` are the given `EMULATOR_SOURCES` section's array +
// its start index in the global `gamesPanelFocusIndex` flat list) — the pattern of RetroArch's `scheduleRetroCoverFetch()`/
// `scheduleUnifiedRetroCoverFetch()`: debounce, then send the not yet requested, cover-less `id`s in the window around the focus to the
// launcher's own `ensure-*-covers` IPC.
function scheduleNetworkCoverFetch(sourceId, rows, offset) {
    const st = networkCoverState(sourceId);
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
        st.timer = null;
        fetchVisibleNetworkCovers(sourceId, rows, offset);
    }, COVER_FETCH_DEBOUNCE_MS);
}

function fetchVisibleNetworkCovers(sourceId, rows, offset) {
    if (!gamesPanel.isOpen() || gamesPanelSource !== sourceId) return;
    const src = EMULATOR_SOURCE_BY_ID[sourceId];
    if (!src || !src.networkCover) return;
    const st = networkCoverState(sourceId);
    const localFocus = Math.max(0, Math.min(rows.length - 1, gamesPanelFocusIndex - offset));
    const ids = visibleMissingCoverIds(rows, localFocus, COVER_FETCH_WINDOW)
        .filter((id) => !st.requested.has(id));
    if (!ids.length) return;
    ids.forEach((id) => st.requested.add(id));
    window.launcher.ensureEmulatorCovers({ source: sourceId, ids }).then((res) => {
        if (!gamesPanel.isOpen() || gamesPanelSource !== sourceId || !res || !res.ok) return;
        if (!Array.isArray(res.items) || !res.items.length) return;
        const byId = new Map(res.items.map((it) => [it.id, it.cover]));
        gamesPanelRows = gamesPanelRows.map((r) => (
            r.type === src.type && byId.has(r.id) ? { ...r, cover: byId.get(r.id) } : r
        ));
        renderGamesPanel();
    }).catch(ignoreError);
}

// Lazy download of the missing covers of the RetroArch rows visible in the "ALL" GRID — the counterpart of the system view's
// `scheduleRetroCoverFetch()`: a small, debounced batch windowed around the focus, with one `ensure-retroarch-game-covers` call per system
// (the main IPC expects system+label pairs). The returned cover is written into the PERSISTENT unified row objects (no need to rebuild the
// ~16,000 item list). Nothing to download in list mode.
function scheduleUnifiedRetroCoverFetch() {
    if (unifiedRetroCoverTimer) clearTimeout(unifiedRetroCoverTimer);
    unifiedRetroCoverTimer = setTimeout(() => {
        unifiedRetroCoverTimer = null;
        fetchUnifiedRetroCovers();
    }, COVER_FETCH_DEBOUNCE_MS);
}

function fetchUnifiedRetroCovers() {
    if (!gamesPanel.isOpen() || gamesPanelSystem || (gamesPanelSource !== 'all' && gamesPanelSource !== 'retro')) return;
    // The rows rendered LAST (not the unfiltered memo): during a search the filtered list's indexes are the focus's.
    const list = gamesPanelShownUnified;
    if (!list.length || !list[0].grid || !gamesPanelRetroUnified) return;
    const head = gamesPanelVisibleRows[0] && gamesPanelVisibleRows[0].type === 'recent' ? 1 : 0;
    const center = Math.max(0, Math.min(list.length - 1, gamesPanelFocusIndex - head));
    const from = Math.max(0, center - COVER_FETCH_WINDOW);
    const to = Math.min(list.length, center + COVER_FETCH_WINDOW + 1);
    const bySystem = new Map(); // system -> Map(label -> [rows])
    for (let i = from; i < to; i++) {
        const r = list[i];
        if (!r.retroSystem || r.cover) continue;
        const key = `${r.retroSystem}\u0000${r.name}`;
        if (unifiedRetroCoverRequested.has(key)) continue;
        unifiedRetroCoverRequested.add(key);
        if (!bySystem.has(r.retroSystem)) bySystem.set(r.retroSystem, new Map());
        const labels = bySystem.get(r.retroSystem);
        if (!labels.has(r.name)) labels.set(r.name, []);
        labels.get(r.name).push(r);
    }
    for (const [system, labels] of bySystem) {
        window.launcher.ensureRetroarchGameCovers({ system, labels: [...labels.keys()] }).then((res) => {
            if (!gamesPanel.isOpen() || !res || !res.ok || !Array.isArray(res.items) || !res.items.length) return;
            for (const it of res.items) {
                for (const row of labels.get(it.label) || []) {
                    row.cover = it.cover;
                    if (row._src) row._src.cover = it.cover; // the RETRO chip's search copy -> the persistent row
                }
            }
            if (!gamesPanelSystem && (gamesPanelSource === 'all' || gamesPanelSource === 'retro')) renderGamesPanel();
        }).catch(ignoreError);
    }
}

// Clears the session state of the lazy cover download — when opening/leaving a system, so the `retroCoverRequested` dedup does not leak
// between systems and a stale timed batch request for another system does not run.
function resetRetroCoverFetchState() {
    retroCoverRequested = new Set();
    if (retroCoverFetchTimer) {
        clearTimeout(retroCoverFetchTimer);
        retroCoverFetchTimer = null;
    }
}

// Requests the cover-less labels around the focus — debounced (during fast consecutive nav steps only one batch goes out after
// "settling"), and only for those not requested yet IN THIS system-view session (`retroCoverRequested`).
function scheduleRetroCoverFetch() {
    if (retroCoverFetchTimer) clearTimeout(retroCoverFetchTimer);
    retroCoverFetchTimer = setTimeout(() => {
        retroCoverFetchTimer = null;
        fetchVisibleRetroCovers();
    }, COVER_FETCH_DEBOUNCE_MS);
}

function fetchVisibleRetroCovers() {
    if (!gamesPanelSystem) return;
    const system = gamesPanelSystem;
    const labels = retroCoverBatchLabels(systemGamesView(), gamesPanelFocusIndex, COVER_FETCH_WINDOW)
        .filter((label) => !retroCoverRequested.has(label));
    if (!labels.length) return;
    labels.forEach((label) => retroCoverRequested.add(label));
    window.launcher.ensureRetroarchGameCovers({ system, labels }).then((res) => {
        if (!gamesPanel.isOpen() || gamesPanelSystem !== system || !res || !res.ok) return;
        if (!Array.isArray(res.items) || !res.items.length) return;
        const byLabel = new Map(res.items.map((it) => [it.label, it.cover]));
        gamesPanelSystemGames = gamesPanelSystemGames.map((g) => (
            byLabel.has(g.label) ? { ...g, cover: byLabel.get(g.label) } : g
        ));
        renderGamesPanel();
    }).catch(ignoreError);
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { retroCoverBatchLabels, visibleMissingCoverIds });
}
