// @ts-check
'use strict';

// MAIN-side, function-heavy descriptor of the Games panel's emulator sources — ONE entry PER EMULATOR. The pure DATA lives in
// `EMULATOR_REGISTRY` of the repo-root `launcher-registry.js`; whatever is a function and calls the library module lives here:
//   loader        — `{ load, invalidate, async? }` for `GAME_LOADERS` (lib/ipc/games-ipc.js)
//   ensureCovers  — the network cover downloader (only for `networkCover` sources)
//   nativePlay(p) — the emulator's OWN playtime bookkeeping, for the details view
//   recent        — the derived "recently played" query (`derivedRecent`) + `background` (stale-while-revalidate)
//   cover         — quick-launch/favorite cover filling (`COVER_LAUNCHERS`); `configKey` = list booked at launch time
//   launch        — path-based launch: `gameId(p)`, `args(p)` (the library's `<x>GameArgs`), `missingReason`, `killable?`
//                   (RPCS3 has none: title-ID based, own handler)
//   romDirArgs()  — the arguments of the library's `readGameDirs` (flatpak ROM visibility check, lib/launchers/rom-access.js)
//   invalidateModuleCache / onStartup({ log }) / label / library — cache clear on game close / one-off startup step / name / module
// The worker scans come from `lib/scan/scan-sources.js`, the save locations live in `lib/saves/save-sources.js`.
// NEW EMULATOR: `npm run new-emulator` (`test/contracts/launcher-tables.test.js` complains if something is missing) —
// docs/dev/launchers/README.md#adding-an-emulator

const { EMULATOR_REGISTRY } = require('../../launcher-registry.js');

const DEFAULT_LIBS = {
    ryujinx: () => require('./ryujinx-library.js'),
    pcsx2: () => require('./pcsx2-library.js'),
    cemu: () => require('./cemu-library.js'),
    rpcs3: () => require('./rpcs3-library.js'),
    ppsspp: () => require('./ppsspp-library.js'),
    dolphin: () => require('./dolphin-library.js'),
    melonds: () => require('./melonds-library.js'),
    duckstation: () => require('./duckstation-library.js'),
};

const RECENT_MAX = 3;

/**
 * @param {Object} ctx
 * @param {Record<string, any>} [ctx.libs] the library modules by id (tests: fakes; default: the real ones)
 * @param {Record<string, any>} ctx.workerScans main's worker-scan TTL caches (the keys of `lib/scan/scan-sources.js` — every ROM-folder-walking source)
 * @param {{ get: (key: string, fallback: any) => any }} ctx.config
 * @param {() => string} ctx.activeRpcs3ConfigRoot root of the added RPCS3 (native AppImage / flatpak)
 * @param {(kind: string) => ((list: any[]) => unknown)} [ctx.coverFetcher] the quick-launch bar's cover downloader by
 *   `kind` — resolved LAZILY (recent-covers is built AFTER the descriptor)
 */
function createEmulatorSources(ctx) {
    const { workerScans, config, activeRpcs3ConfigRoot, coverFetcher = () => () => {} } = ctx;
    /** @type {Record<string, any>} */
    const libs = {};
    for (const id of Object.keys(DEFAULT_LIBS)) libs[id] = (ctx.libs && ctx.libs[id]) || DEFAULT_LIBS[id]();
    const nameOf = Object.fromEntries(EMULATOR_REGISTRY.map((e) => [e.id, e.name]));

    // The module's own TTL-cached `findInstalledGamesCached(configRoot)` (SINGLE-ARGUMENT — the derived recent runs on the
    // same cache key, one scan, not two).
    const cachedLoader = (lib, configRoot) => ({
        load: () => lib.findInstalledGamesCached(configRoot()),
        invalidate: () => lib.findInstalledGamesCached.invalidate(),
    });
    // Scan running in a worker thread (lib/scan/scan-pool.js): async, the warmup starts it FIRST.
    const workerLoader = (key, ...argFns) => ({
        load: () => workerScans[key](...argFns.map((f) => f())),
        invalidate: () => workerScans[key].invalidate(),
        async: true,
    });
    // `playtime.dat` / `[PlayTime]` map → the "native" row of the details view.
    const fromPlaytimeMap = (map, id, kind) => {
        const pt = id ? map.get(id) : null;
        return pt ? { playtimeMs: pt.seconds * 1000, lastPlayedAt: pt.lastPlayedAt, label: nameOf[kind] } : null;
    };
    // Fire-and-forget download of the derived recent top-3's missing covers, then the list.
    const withCoverFetch = (kind, list) => {
        const fetch = coverFetcher(kind);
        if (typeof fetch === 'function') fetch(list);
        return list;
    };

    const { ryujinx, pcsx2, cemu, rpcs3, ppsspp, dolphin, melonds, duckstation } = libs;

    /** @type {Record<string, any>} */
    const SOURCES = {
        ryujinx: {
            launch: {
                gameId: (p) => ryujinx.ryujinxGameId(p.titleId || null, p.path),
                args: (p) => ryujinx.ryujinxGameArgs(p.path),
                missingReason: 'Missing Ryujinx ROM path',
            },
            romDirArgs: () => [ryujinx.ryujinxConfigRoot()],
            loader: workerLoader('ryujinx', ryujinx.ryujinxConfigRoot),
            ensureCovers: ryujinx.ensureRyujinxCovers,
            // recent booked at launch time (`recentGames.ryujinx`) — no `recent`
            cover: {
                configKey: 'ryujinx',
                hasParams: (f) => f.params && f.params.titleId,
                ensure: (list, opts) => ryujinx.ensureRyujinxCovers(list, opts),
                resolve: (f) => ryujinx.resolveRyujinxCover(f.params.titleId),
            },
        },
        pcsx2: {
            launch: {
                gameId: (p) => pcsx2.pcsx2GameId(p.serial || null, p.path),
                args: (p) => pcsx2.pcsx2GameArgs(p.path),
                missingReason: 'Missing PCSX2 disc image path',
            },
            romDirArgs: () => [pcsx2.pcsx2ConfigRoot()],
            loader: workerLoader('pcsx2', pcsx2.pcsx2ConfigRoot),
            ensureCovers: pcsx2.ensurePcsx2Covers,
            nativePlay: (p) => fromPlaytimeMap(pcsx2.readPlaytime(pcsx2.pcsx2ConfigRoot()), p.serial, 'pcsx2'),
            // from the worker-scan list (same cache key as the list IPC — one scan, not two)
            recent: {
                fetch: async () => withCoverFetch('pcsx2', pcsx2.recentFromGames(
                    await workerScans.pcsx2(pcsx2.pcsx2ConfigRoot()), RECENT_MAX)),
                background: true,
            },
            cover: {
                hasParams: (f) => f.params && f.params.serial,
                ensure: (list, opts) => pcsx2.ensurePcsx2Covers(list, opts),
                resolve: (f) => pcsx2.resolvePcsx2Cover(f.params.serial),
            },
            invalidateModuleCache: () => workerScans.pcsx2.invalidate(),
        },
        cemu: {
            launch: {
                gameId: (p) => cemu.cemuGameId(p.titleId || null, p.path),
                args: (p) => cemu.cemuGameArgs(p.path),
                missingReason: 'Missing Cemu game path',
            },
            // the cover is decoded locally (TGA → PNG), recent is booked at launch time
            romDirArgs: () => [cemu.cemuConfigRoot()],
            loader: workerLoader('cemu', cemu.cemuConfigRoot, cemu.cemuDataRoot),
        },
        rpcs3: {
            loader: cachedLoader(rpcs3, activeRpcs3ConfigRoot),
            nativePlay: (p) => {
                if (!p.titleId) return null;
                const { lastPlayed, playtimeMs } = rpcs3.readPersistentSettings(activeRpcs3ConfigRoot());
                if (!lastPlayed.has(p.titleId) && !playtimeMs.has(p.titleId)) return null;
                return {
                    playtimeMs: playtimeMs.get(p.titleId) || 0, lastPlayedAt: lastPlayed.get(p.titleId) || null,
                    label: nameOf.rpcs3,
                };
            },
            // the cover (ICON0.PNG) comes ready — no download
            recent: { fetch: () => rpcs3.findRecentlyPlayed(activeRpcs3ConfigRoot(), RECENT_MAX), background: true },
            invalidateModuleCache: () => rpcs3.findInstalledGamesCached.invalidate(),
        },
        ppsspp: {
            // `.pbp` homebrew never has a `discId` (no UMD serial) → always a path hash.
            launch: {
                gameId: (p) => ppsspp.ppssppGameId(p.discId || null, p.path),
                args: (p) => ppsspp.ppssppGameArgs(p.path),
                missingReason: 'Missing PPSSPP game path',
            },
            romDirArgs: () => [ppsspp.ppssppConfigRoot()],
            loader: workerLoader('ppsspp', ppsspp.ppssppConfigRoot),
            nativePlay: (p) => fromPlaytimeMap(ppsspp.readPlaytime(ppsspp.ppssppConfigRoot()), p.discId, 'ppsspp'),
            // from the worker-scan list (same cache key as the list IPC)
            recent: {
                fetch: async () => ppsspp.recentFromGames(await workerScans.ppsspp(ppsspp.ppssppConfigRoot()), RECENT_MAX),
                background: true,
            },
            invalidateModuleCache: () => workerScans.ppsspp.invalidate(),
        },
        dolphin: {
            launch: {
                gameId: (p) => dolphin.dolphinGameId(p.gameId || null, p.path),
                args: (p) => dolphin.dolphinGameArgs(p.path),
                missingReason: 'Missing Dolphin disc image path',
            },
            romDirArgs: () => [dolphin.dolphinConfigRoot()],
            loader: workerLoader('dolphin', dolphin.dolphinConfigRoot, dolphin.dolphinCacheRoot),
            ensureCovers: dolphin.ensureDolphinCovers,
            cover: {
                configKey: 'dolphin',
                hasParams: (f) => f.params && f.params.gameId,
                ensure: (list, opts) => dolphin.ensureDolphinCovers(list, opts),
                // `dolphinCacheRoot()` is cheap and pure (the favorite list is small)
                resolve: (f) => dolphin.resolveDolphinCover(dolphin.dolphinCacheRoot(), f.params.gameId),
            },
        },
        melonds: {
            // `archiveEntry` ONLY for a ROM opened from a zip archive (for the `-a` flag) — the path hash includes it too, so two ROMs of
            // one zip do not collide. `killable`: melonDS has NO controller exit → PS/Home force close
            // (lib/ipc/launch-ipc.js `emulatorRecentMeta`).
            launch: {
                gameId: (p) => melonds.melondsGameId(p.gamecode || null, p.path, p.archiveEntry || null),
                args: (p) => melonds.melondsGameArgs(p.path, p.archiveEntry || null),
                missingReason: 'Missing melonDS ROM path',
                killable: true,
            },
            // the ROM folders: melonDS's own `melonDS.toml` + the `melondsRomDirs` config key
            romDirArgs: () => [melonds.melondsConfigRoot(), config.get('melondsRomDirs', [])],
            loader: workerLoader('melonds', melonds.melondsConfigRoot, () => config.get('melondsRomDirs', [])),
            // Startup sync of the flatpak sandbox access for the `melondsRomDirs` entries outside $HOME (hand-edited
            // config.json / folders added earlier — idempotent).
            onStartup: ({ log }) => melonds.syncFlatpakOverrides([], config.get('melondsRomDirs', []), { log }),
        },
        duckstation: {
            launch: {
                gameId: (p) => duckstation.duckstationGameId(p.serial || null, p.path),
                args: (p) => duckstation.duckstationGameArgs(p.path),
                missingReason: 'Missing DuckStation disc image path',
            },
            romDirArgs: () => [duckstation.duckstationConfigRoot()],
            loader: workerLoader('duckstation', duckstation.duckstationConfigRoot),
            ensureCovers: duckstation.ensureDuckstationCovers,
            nativePlay: (p) => fromPlaytimeMap(
                duckstation.readPlaytime(duckstation.duckstationConfigRoot()), p.serial, 'duckstation'),
            recent: {
                fetch: async () => withCoverFetch('duckstation', duckstation.recentFromGames(
                    await workerScans.duckstation(duckstation.duckstationConfigRoot()), RECENT_MAX)),
                background: true,
            },
            cover: {
                hasParams: (f) => f.params && f.params.serial,
                ensure: (list, opts) => duckstation.ensureDuckstationCovers(list, opts),
                resolve: (f) => duckstation.resolveDuckstationCover(f.params.serial),
            },
            invalidateModuleCache: () => workerScans.duckstation.invalidate(),
        },
    };
    for (const [id, s] of Object.entries(SOURCES)) {
        s.label = nameOf[id] || id;
        s.library = libs[id]; // for the rare, emulator-specific calls (e.g. the melonDS flatpak override)
    }
    return SOURCES;
}

// Convenience filters for the consumers (in registry order).
/** @param {Record<string, any>} sources @param {string} field */
function sourcesWith(sources, field) {
    return EMULATOR_REGISTRY.map((e) => e.id).filter((id) => sources[id] && sources[id][field]);
}

module.exports = { createEmulatorSources, sourcesWith, DEFAULT_LIBS };
