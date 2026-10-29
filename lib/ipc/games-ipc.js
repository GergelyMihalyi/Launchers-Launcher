// @ts-check
'use strict';

// The Games panel IPC. `createGamesHandlers(deps)` = the handler bodies (for tests), `registerGamesIpc({ ipcMain, … })` =
// the same + channel registration. The launcher-specific library modules come in as DEPS (testability).
// `GAME_LOADERS` is the SINGLE place of the panel's sources: the `list-*` handlers AND `games-warmup` call the same `load` thunk
// (the `createTtlCache` key is the JSON of the arguments — a separately built argument list would leave a cold cache).
// New source: 1 row in `GAME_LOADERS` + 1 in `GAME_WARMUP_ORDER`. Background: docs/dev/games-panel.md#data-flow-and-the-single-source-table

const { createGamesWarmup } = require('../games/games-warmup.js');
const { combineGamesList } = require('../games/games-list.js');
const gamesCache = require('../games/games-cache.js');
const { EMULATOR_REGISTRY } = require('../../launcher-registry.js');
const customRoms = require('../launchers/custom-roms-library.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { applyCoverOverrides } = require('../launchers/shared/cover-override.js');
const { requireDeps } = require('./require-deps.js');

// Manual cover override (lib/launchers/shared/cover-override.js): the (source, id) pair of the `list-games`
// rows — Heroic's 3 stores share one `heroic/` folder.
function storeRowOverrideTarget(row) {
    if (row.source === 'steam') return { source: 'steam', id: row.appid };
    if (row.source === 'lutris') return { source: 'lutris', id: row.lutrisId };
    return { source: 'heroic', id: row.appName };
}
// The id field of the emulator rows (`titleId` for RPCS3, `id` for the rest) — from the registry.
const EMULATOR_ID_FIELD = Object.fromEntries(EMULATOR_REGISTRY.map((e) => [e.id, e.idField]));

// SHARED, table-driven descriptor of the emulators that download covers from the network (Ryujinx/PCSX2/Dolphin/DuckStation):
// `buildNetworkCoverHandler` NARROWS the (TTL-cached) `GAME_LOADERS[x].load()` list to the `{ids}` sent by the renderer, and only
// runs the launcher's own `ensure*Covers()` on the rows still missing a cover. Background: docs/dev/games-panel.md#covers
const COVER_FETCH_MAX_IDS = 60;

// Sources ALWAYS reread on return from a game / launcher: in these clients (Steam / Heroic / Lutris) the
// user can install a new game while playing.
const WARMUP_CLIENT_SOURCES = ['steam', 'heroic', 'lutris'];

// A finished `spawnGame()` appId → the `GAME_LOADERS` keys whose cache the return warmup should clear. Only
// the finished launcher's source + the clients; the other sources refresh via the 10-minute TTL or the Games
// panel's manual "Refresh". The appId convention matches `derivedSourceForAppId` in `lib/recent/usage.js`:
// `<launcherId>` (card launch), `<launcherId>-game-<id>` (game launch), `'retroarch-game'` (RetroArch ROM). Pure.
/**
 * @param {string|null|undefined} appId
 * @param {string[]} loaderIds a `GAME_LOADERS` kulcsai
 * @returns {string[]}
 */
function warmupSourcesForAppId(appId, loaderIds) {
    const out = new Set(WARMUP_CLIENT_SOURCES);
    if (typeof appId === 'string' && appId) {
        const launcherId = appId === 'retroarch-game' ? 'retroarch' : appId.replace(/-game-.*$/, '');
        if (launcherId === 'retroarch') {
            out.add('retroSystems');
            out.add('retroAll');
        } else if (loaderIds.includes(launcherId)) {
            out.add(launcherId);
        }
    }
    return [...out].filter((id) => loaderIds.includes(id));
}

/**
 * @param {Object} deps
 * @param {Object} deps.config
 * @param {(msg: string) => void} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {Object} deps.prefs
 * @param {(url: string, dest: string) => Promise<boolean>} deps.downloadFile
 * @param {(label: string, fn: () => Promise<any>) => Promise<{ok: boolean, items: any[]}>} deps.safeList
 * @param {Object} deps.findInstalledSteamGames the `.invalidate()`-able TTL-cached Steam finder
 * @param {() => string} deps.defaultSteamRoot
 * @param {Object} deps.findInstalledHeroicGames
 * @param {() => string} deps.heroicConfigRoot
 * @param {Object} deps.lutrisLibrary
 * @param {Object} deps.findRetroarchSystemCounts
 * @param {Object} deps.findRetroarchGamesForSystem
 * @param {Function} deps.ensureRetroarchThumbnails
 * @param {() => string} deps.retroarchConfigRoot
 * @param {Record<string, any>} deps.emulatorSources main-side descriptor of the registry emulators
 *   (lib/launchers/emulator-sources.js — loader / ensureCovers / nativePlay / library)
 * @param {Object} deps.recentGamesMerge source of `lutrisLauncherEntry`
 * @param {Record<string, any>} deps.workerScans main-side, `.invalidate()`-able TTL caches of the heavy
 *   worker-thread scans — only `retroAll` here; the emulators' are in the descriptor
 * @param {{ clear: () => void } | null} [deps.coverMisses] the negative cover cache (cleared by "Clear cache",
 *   lib/launchers/shared/cover-miss-cache.js)
 * @param {(() => void) | null} [deps.invalidateDerivedRecent] clears the derived "recently played" cache
 *   after a cache wipe (lib/recent/usage.js)
 */
function createGamesHandlers(deps) {
    const {
        config, log, sendToRenderer, prefs, downloadFile, safeList,
        findInstalledSteamGames, defaultSteamRoot,
        findInstalledHeroicGames, heroicConfigRoot,
        lutrisLibrary,
        findRetroarchSystemCounts, findRetroarchGamesForSystem,
        ensureRetroarchThumbnails, retroarchConfigRoot,
        emulatorSources,
        recentGamesMerge, workerScans,
        coverMisses = null, invalidateDerivedRecent = null,
    } = deps;
    requireDeps(deps, ['config', 'log', 'sendToRenderer', 'prefs', 'downloadFile', 'safeList', 'findInstalledSteamGames', 'defaultSteamRoot', 'findInstalledHeroicGames', 'heroicConfigRoot', 'lutrisLibrary', 'findRetroarchSystemCounts', 'findRetroarchGamesForSystem', 'ensureRetroarchThumbnails', 'retroarchConfigRoot', 'emulatorSources', 'recentGamesMerge', 'workerScans'], 'createGamesHandlers');

    // Games of the custom ROM-folder sources (lib/launchers/custom-roms-library.js) — the config JSON is the
    // cache key, so a source change gives a fresh scan by itself.
    const customGamesCached = createTtlCache((sources) => customRoms.findAllCustomGames(sources), GAMES_CACHE_TTL_MS);

    // Source running in the worker thread (see lib/scan/scan-pool.js): async, does not block the main
    // process — the warmup starts it FIRST as an `async` step, in parallel with the synchronous steps.
    function workerLoader(key, ...argFns) {
        return {
            load: () => workerScans[key](...argFns.map((f) => f())),
            invalidate: () => workerScans[key].invalidate(),
            async: true,
        };
    }

    const GAME_LOADERS = {
        steam: { load: () => findInstalledSteamGames(defaultSteamRoot()), invalidate: () => findInstalledSteamGames.invalidate() },
        heroic: { load: () => findInstalledHeroicGames(heroicConfigRoot()), invalidate: () => findInstalledHeroicGames.invalidate() },
        lutris: {
            load: () => lutrisLibrary.findInstalledGamesCached(recentGamesMerge.lutrisLauncherEntry()),
            invalidate: () => lutrisLibrary.findInstalledGamesCached.invalidate(),
            async: true, // CLI call (~0.7 s), does not block the main process
        },
        // The panel uses both cached RetroArch calls (per-system summary AND the full ROM set of "ALL"); the
        // per-system list (`findGamesForSystemCached`) only takes part in the return invalidation, warming it is
        // not worth it (needed when entering a system).
        retroSystems: {
            load: () => findRetroarchSystemCounts(retroarchConfigRoot()),
            invalidate: () => {
                findRetroarchSystemCounts.invalidate();
                findRetroarchGamesForSystem.invalidate();
            },
        },
        retroAll: workerLoader('retroAll', retroarchConfigRoot),
        // Lists of the registry emulators from the descriptor (lib/launchers/emulator-sources.js).
        ...Object.fromEntries(Object.entries(emulatorSources).map(([id, src]) => [id, src.loader])),
        custom: {
            load: () => customGamesCached(customRoms.readCustomGameSources(config)),
            invalidate: () => customGamesCached.invalidate(),
            async: true, // async folder walk (may be NFS)
        },
    };

    // Warmup (see `lib/games/games-warmup.js`): cheapest to most expensive. The `async` steps (Lutris CLI + the
    // worker scans: the sources of `lib/scan/scan-sources.js`) start FIRST and enter the worker queue in this
    // order — melonDS (up to 13 s cold on NFS) is last.
    const GAME_WARMUP_ORDER = [
        'lutris', 'rpcs3', 'steam', 'retroSystems', 'cemu', 'dolphin', 'pcsx2', 'retroAll',
        'heroic', 'duckstation', 'ryujinx', 'ppsspp', 'custom', 'melonds',
    ];
    const gamesWarmup = createGamesWarmup({
        steps: GAME_WARMUP_ORDER.map((id) => ({
            id, run: GAME_LOADERS[id].load, invalidate: GAME_LOADERS[id].invalidate, async: !!GAME_LOADERS[id].async,
        })),
        log,
        onState: (state) => sendToRenderer('games-warmup-state', state),
    });

    // Runs delayed (the first paint / card render must not compete with the scans); `run` never throws, the
    // `.catch` is only a safety net. The caller (window creation + `invalidateRecent`) supplies `delayMs`
    // (startup vs. return delay). `onDone` (optional): at the end of the warmup — the startup timeline
    // (lib/startup-timeline.js).
    function scheduleGamesWarmup(reason, opts, delayMs, onDone) {
        const timer = setTimeout(() => {
            gamesWarmup.run(reason, opts)
                .catch((err) => log(`[warmup] ${reason}: ${err.message}`))
                .then(() => { if (onDone) onDone(); });
        }, delayMs);
        if (timer.unref) timer.unref();
    }

    function getGamesWarmupState() {
        return gamesWarmup.getState();
    }

    // The Games panel's manual "Refresh" (Start/Options): clears and rescans EVERY source's cache — so a ROM
    // copied in / a game installed while playing shows up without a launcher restart or waiting for the
    // 10-minute TTL. The warmup never throws; if one is running, the request schedules an extra round and the
    // returned Promise resolves with it.
    async function refreshGames() {
        await gamesWarmup.run('manual', { invalidate: true });
        return { ok: true };
    }

    // The Ryujinx/PCSX2/Cemu/RPCS3/PPSSPP/Dolphin/DuckStation root lists of the Games panel all have the SAME
    // shape: ONE aggregated row, entering it gives the full browsable list — `safeList(label, GAME_LOADERS.x.load)`.
    // The manual cover override runs on a COPY of the TTL-cached list (the cache stays untouched).
    function gameListHandler(label, loader, sourceId) {
        const idField = EMULATOR_ID_FIELD[sourceId];
        return () => safeList(label, async () => applyCoverOverrides(
            await loader.load(), (g) => ({ source: sourceId, id: g[idField] }),
        ));
    }

    function listGames() {
        return safeList('Games list error', async () => {
            const steamGames = GAME_LOADERS.steam.load();
            const heroicGames = GAME_LOADERS.heroic.load();
            const lutrisGames = await GAME_LOADERS.lutris.load();
            return applyCoverOverrides(combineGamesList(steamGames, heroicGames, lutrisGames), storeRowOverrideTarget);
        });
    }

    // The ~15,700-item RetroArch ROM set cannot be navigated by controller in one piece — hence only a
    // per-system summary here; `listRetroarchGames` returns the full list of ONE chosen system (requested
    // when the Games panel enters a system).
    function listRetroarchSystems() {
        return safeList('RetroArch system list error', GAME_LOADERS.retroSystems.load);
    }

    function listRetroarchGames(system) {
        return safeList(`RetroArch games list error (${system})`, () => applyCoverOverrides(
            findRetroarchGamesForSystem(retroarchConfigRoot(), system),
            (g) => ({ source: `retroarch/${system}`, id: g.label }),
        ));
    }

    // The FULL RetroArch ROM set to merge into the "ALL" view, grouped by system — the renderer requests it in
    // the BACKGROUND after opening the panel; the actual display is windowed.
    function listRetroarchAllGames() {
        return safeList('RetroArch full games list error', async () => {
            const groups = await GAME_LOADERS.retroAll.load();
            if (!Array.isArray(groups)) return groups;
            return groups.map((grp) => {
                const games = applyCoverOverrides(grp.games, (g) => ({ source: `retroarch/${grp.system}`, id: g.label }));
                return games === grp.games ? grp : { ...grp, games };
            });
        });
    }

    // Lazy cover download of the "Games → RetroArch → <system>" cover grid — the renderer only sends a small
    // batch windowed around the focus (`labels`) — one RetroArch system may hold 5000+ ROMs, downloading every
    // missing cover at once would be unacceptable. `COVER_FETCH_MAX_IDS` is a shared protective cap. Respects
    // the `coverDownload` switch and builds on the existing `ensureRecentThumbnails()`.
    function ensureRetroarchGameCovers(payload) {
        return safeList('RetroArch cover refresh error', async () => {
            if (!prefs.getCoverDownload()) return [];
            const system = payload && payload.system;
            const labels = Array.isArray(payload && payload.labels) ? payload.labels.slice(0, COVER_FETCH_MAX_IDS) : [];
            if (!system || !labels.length) return [];
            const entries = labels.map((label) => ({ name: label, cover: null, params: { system } }));
            await ensureRetroarchThumbnails(retroarchConfigRoot(), entries, { download: downloadFile, log });
            return entries.filter((e) => e.cover).map((e) => ({ label: e.name, cover: e.cover }));
        });
    }

    // Network-downloaded covers of the Ryujinx/PCSX2/Dolphin/DuckStation root grids — the same focus-windowed /
    // debounced / session-deduped `{ids}` pattern as RetroArch. The DATA part of the descriptor (which source
    // downloads, key field, whether the name is needed) comes from the shared launcher registry; only the
    // descriptor's (lib/launchers/emulator-sources.js) `ensureCovers` is attached here.
    const NETWORK_COVER_SOURCES = Object.fromEntries(EMULATOR_REGISTRY
        .filter((e) => e.networkCover)
        .map((e) => [e.id, {
            loaderKey: e.id,
            keyField: e.networkCover.keyField,
            withName: !!e.networkCover.withName,
            label: e.name,
            ensureCovers: emulatorSources[e.id] && emulatorSources[e.id].ensureCovers,
        }]));
    function buildNetworkCoverHandler(cfg) {
        return (payload) => safeList(`${cfg.label} cover refresh error`, async () => {
            if (!prefs.getCoverDownload()) return [];
            const ids = new Set(Array.isArray(payload && payload.ids) ? payload.ids.slice(0, COVER_FETCH_MAX_IDS) : []);
            if (!ids.size) return [];
            const list = await GAME_LOADERS[cfg.loaderKey].load();
            const missing = list.filter((g) => ids.has(g.id) && !g.cover && g[cfg.keyField]);
            if (!missing.length) return [];
            const adapted = missing.map((g) => ({
                cover: null,
                ...(cfg.withName ? { name: g.name } : {}),
                params: { [cfg.keyField]: g[cfg.keyField] },
            }));
            await cfg.ensureCovers(adapted, { download: downloadFile, log });
            const patched = missing
                .map((g, i) => ({ id: g.id, cover: adapted[i].cover }))
                .filter((entry) => entry.cover);
            // The downloaded cover is part of the scan (`resolve*Cover`), but the 10-minute TTL cache would still
            // hold the old list without it — clear it so the next open includes it.
            if (patched.length) GAME_LOADERS[cfg.loaderKey].invalidate();
            return patched;
        });
    }
    const networkCoverHandlers = Object.fromEntries(Object.entries(NETWORK_COVER_SOURCES)
        .map(([id, cfg]) => [id, buildNetworkCoverHandler(cfg)]));

    // EVERY registry emulator's root list uses the SAME `gameListHandler` (the cover comes ready from the
    // library module — decoded locally OR from the cache after the lazy network download). The single-argument
    // `findInstalledGamesCached(configRoot)` of PCSX2/DuckStation shares the cache key with the `fetch*Recent`
    // thunk — one scan, not two. melonDS ROM folders: melonDS's own `melonDS.toml` + the `melondsRomDirs` key.
    const emulatorListHandlers = Object.fromEntries(EMULATOR_REGISTRY.map((e) => [
        e.id, gameListHandler(`${e.name} games list error`, GAME_LOADERS[e.id], e.id),
    ]));

    // The SHARED emulator IPC: `list-emulator-games` { source } and `ensure-emulator-covers` { source, ids } — `source`
    // is whitelisted against the registry ids (the renderer cannot request an arbitrary loader). Unknown source →
    // `{ ok: false, items: [] }`.
    function listEmulatorGames(payload) {
        const source = payload && payload.source;
        const handler = typeof source === 'string' && Object.prototype.hasOwnProperty.call(emulatorListHandlers, source)
            ? emulatorListHandlers[source] : null;
        if (!handler) {
            log(`list-emulator-games: unknown source: ${JSON.stringify(source)}`);
            return Promise.resolve({ ok: false, items: [] });
        }
        return handler();
    }

    function ensureEmulatorCovers(payload) {
        const source = payload && payload.source;
        const handler = typeof source === 'string' && Object.prototype.hasOwnProperty.call(networkCoverHandlers, source)
            ? networkCoverHandlers[source] : null;
        if (!handler) {
            log(`ensure-emulator-covers: not a network-cover source: ${JSON.stringify(source)}`);
            return Promise.resolve({ ok: false, items: [] });
        }
        return handler(payload);
    }

    // --- Custom ROM-folder sources ---

    // The Games panel's `custom-game` rows (flat list, `launcherId` per row). The manual cover override source is
    // `custom` (the row `id` is a path hash salted with the launcher).
    function listCustomGames() {
        return safeList('Custom games list error', async () => applyCoverOverrides(
            await GAME_LOADERS.custom.load(), (g) => ({ source: 'custom', id: g.id }),
        ));
    }

    // Settings → System → "Clear cache".
    // `{ ok, items: [{ id, bytes, files }] }` — the `safeList` wrapper pattern.
    function getGamesCacheInfo() {
        return safeList('Cache size error', () => gamesCache.measureGamesCache());
    }

    // Delete → the negative cover cache + the derived "recently played" cache are cleared too, then a full rescan
    // in the background (the panel's "Refresh" path) — the response does NOT wait for it (melonDS cold on NFS can
    // take 13 s).
    async function clearGamesCache() {
        const res = await gamesCache.clearGamesCache();
        if (!res.ok) {
            log(`Cache clear error: ${res.error}`);
            return res;
        }
        if (coverMisses) coverMisses.clear();
        if (invalidateDerivedRecent) invalidateDerivedRecent();
        log(`Cache cleared (${Math.round(res.freedBytes / 1024)} KB)`);
        refreshGames().catch((err) => log(`[warmup] cache-clear: ${err.message}`));
        return res;
    }

    return {
        scheduleGamesWarmup,
        getGamesWarmupState,
        refreshGames,
        getGamesCacheInfo,
        clearGamesCache,
        warmupSourcesForAppId: (appId) => warmupSourcesForAppId(appId, Object.keys(GAME_LOADERS)),
        listGames,
        listRetroarchSystems,
        listRetroarchGames,
        listRetroarchAllGames,
        ensureRetroarchGameCovers,
        listEmulatorGames,
        ensureEmulatorCovers,
        listCustomGames,
        // For the other IPC modules (recent-ipc: native playtime; game-sources-ipc: source changes) —
        // `GAME_LOADERS` stays the SINGLE place of the sources.
        loadGames: (id) => GAME_LOADERS[id].load(),
        invalidateGameSource: (id) => GAME_LOADERS[id].invalidate(),
    };
}

/**
 * The Games panel channels (lists, lazy covers, warmup/refresh, cache). Besides the deps of
 * `createGamesHandlers`: `usage` (clearing the derived recent) + `pushLauncherState` (refreshing the bars
 * after a manual "Refresh"). Favorites / Continue / stats / details live in lib/ipc/recent-ipc.js, the
 * source settings + folder browser in lib/ipc/game-sources-ipc.js.
 * @param {Parameters<typeof createGamesHandlers>[0] & {
 *   ipcMain: import('../types.js').IpcMainLike,
 *   usage: { invalidateDerivedRecent: (id?: string|null) => void },
 *   pushLauncherState: () => void }} deps
 * @returns {ReturnType<typeof createGamesHandlers>}
 */
function registerGamesIpc(deps) {
    const { ipcMain, usage, pushLauncherState } = deps;
    requireDeps(deps, ['ipcMain', 'usage', 'pushLauncherState'], 'registerGamesIpc');
    const h = createGamesHandlers(deps);

    ipcMain.handle('get-games-warmup-state', () => h.getGamesWarmupState());
    // The manual "Refresh": rescan every source, then clear the derived "recently played" cache so the
    // quick-launch / Continue bars show fresh data too.
    ipcMain.handle('refresh-games', async () => {
        const res = await h.refreshGames();
        usage.invalidateDerivedRecent();
        pushLauncherState();
        return res;
    });
    ipcMain.handle('list-games', () => h.listGames());
    ipcMain.handle('get-games-cache-info', () => h.getGamesCacheInfo());
    ipcMain.handle('clear-games-cache', () => h.clearGamesCache());
    ipcMain.handle('list-retroarch-systems', () => h.listRetroarchSystems());
    ipcMain.handle('list-retroarch-games', (event, system) => h.listRetroarchGames(system));
    ipcMain.handle('list-retroarch-all-games', () => h.listRetroarchAllGames());
    ipcMain.handle('ensure-retroarch-game-covers', (event, payload) => h.ensureRetroarchGameCovers(payload));
    // SHARED list + lazy cover IPC of the registry emulators: { source }.
    ipcMain.handle('list-emulator-games', (event, payload) => h.listEmulatorGames(payload));
    ipcMain.handle('ensure-emulator-covers', (event, payload) => h.ensureEmulatorCovers(payload));
    // Games of the custom ROM-folder sources (their settings: game-sources-ipc).
    ipcMain.handle('list-custom-games', () => h.listCustomGames());
    return h;
}

module.exports = { createGamesHandlers, registerGamesIpc, warmupSourcesForAppId, WARMUP_CLIENT_SOURCES };
