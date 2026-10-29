// @ts-check
'use strict';

// Per-launcher "missing cover" filling/download for the games of the quick-launch bar + the favorite list, from one shared
// `COVER_LAUNCHERS` table. Factory: the caller injects config/log/sendToRenderer/prefs/downloadFile, `launchersPayload()`,
// `invalidateDerivedRecent(id)` and the emulator descriptor (`lib/launchers/emulator-sources.js`). Background: docs/dev/games-panel.md#covers

const { EMULATOR_REGISTRY } = require('../../launcher-registry.js');

/**
 * @param {Object} deps
 * @param {typeof import('../config.js')} deps.config
 * @param {import('../types.js').Logger} deps.log
 * @param {(channel: string, payload: any) => void} deps.sendToRenderer
 * @param {typeof import('../prefs.js')} deps.prefs
 * @param {(url: string, dest: string) => Promise<boolean>} deps.downloadFile
 * @param {() => any} deps.launchersPayload
 * @param {(appIdOrLauncherId?: string) => void} deps.invalidateDerivedRecent
 * @param {() => string} deps.retroarchConfigRoot
 * @param {Function} deps.resolveRetroarchThumbnail
 * @param {Function} deps.ensureRetroarchThumbnails
 * @param {Record<string, any>} deps.emulatorSources descriptor of the registry emulators
 *   (lib/launchers/emulator-sources.js — `cover` / `invalidateModuleCache` / `label`)
 * @param {Object} deps.findInstalledSteamGames the `.invalidate()`-able TTL-cached Steam finder
 */
function createRecentCovers({
    config, log, sendToRenderer, prefs, downloadFile, launchersPayload, invalidateDerivedRecent,
    retroarchConfigRoot, resolveRetroarchThumbnail, ensureRetroarchThumbnails,
    emulatorSources, findInstalledSteamGames,
}) {
    // The derived "recently played" reads the same cache as the `list-*-games` IPC, so opening the panel and refreshing the continue bar do
    // not scan the library twice. So besides `invalidateDerivedRecent(appId)` the MODULE's own cache must be invalidated on game close too,
    // otherwise the fresh `lastPlayedAt` would lag. RetroArch is deliberately not here (derived from `content_history.lpl`, no shared cache).
    // The `invalidateRecent` callback calls this too.
    const DERIVED_MODULE_CACHE_INVALIDATORS = {
        steam: () => findInstalledSteamGames.invalidate(),
        // the emulators' from the descriptor (PCSX2/RPCS3: the module's own cache; PPSSPP/DuckStation: the worker scan's)
        ...Object.fromEntries(Object.entries(emulatorSources)
            .filter(([, src]) => src.invalidateModuleCache).map(([id, src]) => [id, src.invalidateModuleCache])),
    };

    // Shared factory of the "fire-and-forget download of the quick-launch bar's missing covers" wrappers; two kinds, by `configKey`:
    //   - "derived" (no `configKey`): the caller passes the `list` (from the launcher's own source derived at read time); on success
    //     `invalidateDerivedRecent(kind)` — only clears its own source. `DERIVED_MODULE_CACHE_INVALIDATORS` clears the module's own cache too
    //     (otherwise the fresh cover would lag because of the TTL; RetroArch has none).
    //   - "persisted" (booked at launch time): the list lives in `recentGames.<configKey>` and is written BACK there on success.
    // Every launcher has its own in-flight guard (closure); the 30 s TTL of `derivedRecentGames` throttles 404 repeats.
    /**
     * @param {Object} opts
     * @param {string} opts.kind the launcher id (on the derived branch also the key of `invalidateDerivedRecent`)
     * @param {string} [opts.configKey] on the "persisted" branch the `recentGames.<configKey>` list
     * @param {(g: any) => boolean} opts.hasParams
     * @param {(list: any[], ctx: {download: Function, log: Function}) => Promise<number>} opts.ensure
     * @param {string} opts.logLabel
     */
    function createRecentCoverFetcher({
        kind, configKey, hasParams, ensure, logLabel,
    }) {
        // On the derived branch the launcher's own `ensure*` decides which entry has enough data (e.g. it skips a PCSX2 row without a serial) —
        // `!cover` is enough; on the persisted list `hasParams` is needed too (without it there could never be a cover).
        const hasMissingCover = (g) => g && !g.cover && (!configKey || hasParams(g));
        let inFlight = false;
        return async (listArg) => {
            if (!prefs.getCoverDownload()) return;
            if (inFlight) return;
            const list = configKey ? config.get('recentGames', {})[configKey] : listArg;
            if (!Array.isArray(list) || !list.some(hasMissingCover)) return;
            inFlight = true;
            try {
                const downloaded = await ensure(list, {
                    download: (url, dest) => downloadFile(url, dest),
                    log: (msg) => log(msg),
                });
                if (downloaded > 0) {
                    if (configKey) {
                        config.patch('recentGames', { [configKey]: list });
                    } else {
                        invalidateDerivedRecent(kind);
                        const invalidateModuleCache = DERIVED_MODULE_CACHE_INVALIDATORS[kind];
                        if (invalidateModuleCache) invalidateModuleCache();
                    }
                    sendToRenderer('running-changed', launchersPayload());
                }
            } catch (err) {
                log(`${logLabel} cover download error: ${err.message}`);
            } finally {
                inFlight = false;
            }
        };
    }

    // SHARED per-launcher descriptor for the three variants of the "missing cover" family (quick-launch download — `RECENT_COVER_FETCHERS`;
    // live favorite filling — `withResolvedAllCovers`; favorite download — `FAVORITE_COVER_FETCHERS`). Fields:
    //   hasParams(f)  → does the entry carry the key needed for the cover (titleId/serial/…)
    //   ensure(list)  → the launcher module's OWN `ensure*Covers` (network download)
    //   resolve(f)    → path of the cover ALREADY on disk (or null) — never goes to the network
    //   configKey     → ONLY for lists booked at launch time: `recentGames.<key>`
    const COVER_LAUNCHERS = [
        {
            kind: 'retroarch',
            logLabel: 'RetroArch',
            hasParams: (f) => f.params && f.params.system && f.name,
            ensure: (list, opts) => ensureRetroarchThumbnails(retroarchConfigRoot(), list, opts),
            resolve: (f) => resolveRetroarchThumbnail(retroarchConfigRoot(), f.params.system, f.name),
        },
        // The registry emulators from the descriptor (lib/launchers/emulator-sources.js `cover`) — in registry order.
        ...EMULATOR_REGISTRY.filter((e) => emulatorSources[e.id] && emulatorSources[e.id].cover)
            .map((e) => ({ kind: e.id, logLabel: emulatorSources[e.id].label, ...emulatorSources[e.id].cover })),
    ];

    // The quick-launch bar's fetchers by `kind` (the `recordRecentGame` callback + the `fetch*Recent` thunks call a specific launcher's).
    const RECENT_COVER_FETCHERS = Object.fromEntries(
        COVER_LAUNCHERS.map((spec) => [spec.kind, createRecentCoverFetcher(spec)]),
    );

    // `favoriteGames`/`recentGames` may land with `cover: null` for a launcher (e.g. the RetroArch ROM list is NOT rendered as a cover grid,
    // the renderer knows no cover path, see `toggleFavoriteFocused()` in `renderer/games-panel/games-panel.js`) — here in the main process
    // (with fs access) we fill it in LIVE in every `get-favorite-games`/`toggle-favorite-game` response, if the file has appeared on disk
    // meanwhile (e.g. because of the quick-launch bar's background download). Not persisted back to the config — a cheap `fs.existsSync`
    // list, recomputed on every read (self-healing).
    function withResolvedCovers(list, { kind, hasParams, resolve }) {
        return list.map((f) => {
            if (f && f.kind === kind && !f.cover && hasParams(f)) {
                const cover = resolve(f);
                if (cover) return { ...f, cover };
            }
            return f;
        });
    }

    // Applies the `resolve` branch of every launcher (COVER_LAUNCHERS) to the list one after another.
    function withResolvedAllCovers(list) {
        return COVER_LAUNCHERS.reduce((acc, spec) => withResolvedCovers(acc, spec), list);
    }

    // Shared factory of the "fire-and-forget download of the favorite list's missing covers" wrappers (complements `withResolvedCovers`).
    // Every launcher gets its own call = its own in-flight guard (closure). `ensure(candidates, opts)` is the launcher's OWN `ensure*Covers`;
    // on success a `running-changed` push so an open Games panel refetches the list.
    function createFavoriteCoverFetcher({
        kind, hasParams, ensure, logLabel,
    }) {
        let inFlight = false;
        return async (list) => {
            if (!prefs.getCoverDownload()) return;
            if (inFlight || !Array.isArray(list)) return;
            const candidates = list.filter((f) => f && f.kind === kind && !f.cover && hasParams(f));
            if (!candidates.length) return;
            inFlight = true;
            try {
                const downloaded = await ensure(candidates, {
                    download: (url, dest) => downloadFile(url, dest),
                    log: (msg) => log(msg),
                });
                if (downloaded > 0) sendToRenderer('running-changed', launchersPayload());
            } catch (err) {
                log(`Favorite ${logLabel} cover download error: ${err.message}`);
            } finally {
                inFlight = false;
            }
        };
    }

    // The fetcher list generated from every launcher's `favorite` branch — each with its own in-flight guard (the closure of
    // `createFavoriteCoverFetcher`).
    const FAVORITE_COVER_FETCHERS = COVER_LAUNCHERS.map((spec) => createFavoriteCoverFetcher(spec));

    // Runs every fetcher (fire-and-forget) — the caller does not care which missing cover belongs to which launcher.
    function ensureAllFavoriteCovers(list) {
        FAVORITE_COVER_FETCHERS.forEach((fetch) => fetch(list));
    }

    return {
        RECENT_COVER_FETCHERS, withResolvedAllCovers, ensureAllFavoriteCovers,
        DERIVED_MODULE_CACHE_INVALIDATORS,
    };
}

module.exports = { createRecentCovers };
