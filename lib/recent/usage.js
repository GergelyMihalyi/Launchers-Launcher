// @ts-check
'use strict';

// Bookkeeping of the `usage` + `recentGames` config keys + decorating the launcher payload with "runtime metadata" (favorite badge,
// ● RUNNING, quick-launch bar).
//
// Factory: the caller (main.js) injects `config`, the logger and the steam/retroarch "recently played" query thunks (those know the
// lib/*-library modules + the machine-specific paths, this module does not). The `running-changed` IPC push stays with the caller — the
// module only returns data / writes its own cache.

const { pushRecentGame } = require('./recent-games.js');
const { str, primitiveMap, PATH_MAX } = require('../validate.js');

// TTL of the steam/retroarch derived "recently played" cache: decorateLaunchers() is also called by the `running-changed` poller (4 s),
// it must not read the filesystem on every tick. On return from a game the caller forces a refresh with `invalidateDerivedRecent()`.
const DERIVED_RECENT_TTL_MS = 30000;

// Upper sanity bound of a game session. Above it (a stuck `bringToFront`, time measured across suspend/resume, a clock change) it is not
// booked — not credible data.
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

// Upper limit of favorite games pinnable in the games panel — a "★ Favorites" filter grid, not an endless list.
const MAX_FAVORITE_GAMES = 24;

// A favorite entry coming from the renderer goes into the config → filtered by type + size (with the shared lib/validate.js): `key` is a
// non-empty string, `params` only holds primitive values.
const FAV_TEXT_MAX = 300;

// Merges several `recentGames`-shaped lists: dedup on `key` (AFTER sorting, the freshest instance stays), descending by `lastLaunchedAt`,
// cut to `max`. Called by `globalRecentGames()`; main merges the async Lutris list with it too. Module-level.
function mergeRecentGameLists(lists, max = 3) {
    const all = lists.flat().filter((e) => e && e.key)
        .sort((a, b) => (Date.parse(b.lastLaunchedAt) || 0) - (Date.parse(a.lastLaunchedAt) || 0));
    const seen = new Set();
    const merged = [];
    for (const e of all) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
        merged.push(e);
    }
    return merged.slice(0, Math.max(0, max));
}

// The "recently played" launchers whose source is derived from their own data at READ time (no launch-time bookkeeping):
// Steam/RetroArch + the registry's `derivedRecent` emulators (PCSX2, RPCS3, PPSSPP, DuckStation — from their own playtime files).
const DERIVED_RECENT_LAUNCHER_IDS = new Set(require('../../launcher-registry.js').DERIVED_RECENT_IDS);

// By the `spawnGame()` appId convention: launching a static launcher card is the launcherId itself (`'pcsx2'`), a game-level launch is
// `<launcherId>-game-<id>` (`'pcsx2-game-42'`), and RetroArch uses a shared `'retroarch-game'` literal (no ROM-level appId). Unknown/
// non-derived appId (e.g. Heroic/Ryujinx/Cemu/custom launcher) -> `null`. Module-level (not part of the factory, like
// `mergeRecentGameLists`) — main calls it too, to invalidate the module caches of its own `findInstalledGamesCached()` for the RIGHT
// launcher (see the `invalidateRecent` callback).
function derivedSourceForAppId(appId) {
    if (!appId) return null;
    if (appId === 'retroarch-game') return 'retroarch';
    for (const id of DERIVED_RECENT_LAUNCHER_IDS) {
        if (appId === id || appId.startsWith(`${id}-game-`)) return id;
    }
    return null;
}

/**
 * Query of a derived "recently played" source. ONLY a source in `backgroundSources` (refreshed in the background,
 * stale-while-revalidate) may return a Promise.
 * @typedef {() => (import('../types.js').RecentGameEntry[] | Promise<import('../types.js').RecentGameEntry[]>)} RecentFetcher
 */

/**
 * @param {Object} deps
 * @param {typeof import('../config.js')} deps.config
 * @param {import('../types.js').Logger} [deps.log]
 * @param {RecentFetcher} deps.fetchSteamRecent
 * @param {RecentFetcher} deps.fetchRetroarchRecent
 * @param {Record<string, RecentFetcher>} [deps.emulatorFetchers] queries of the `derivedRecent` registry emulators by id (main
 *   builds them from the `recent.fetch`es of lib/launchers/emulator-sources.js; missing → empty list)
 * @param {string[]} [deps.backgroundSources] derived source ids refreshed in the background (stale-while-revalidate)
 * @param {number} [deps.refreshDelayMs] delay of the background refresh (the first paint must not compete with it)
 * @param {() => void} [deps.onDerivedChanged] a background refresh actually changed a list
 */
function createUsage({
    config, log = () => {}, fetchSteamRecent, fetchRetroarchRecent, emulatorFetchers = {},
    backgroundSources = [], refreshDelayMs = 0, onDerivedChanged = () => {},
}) {
    const backgroundSet = new Set(backgroundSources);
    // A SEPARATE `at` timestamp per source (not a shared one) — so invalidating one source (`invalidateDerivedRecent(id)`) does not force
    // a synchronous rescan of the other 5 too
    /** @type {Record<string, RecentFetcher>} */
    const FETCHERS = { steam: fetchSteamRecent, retroarch: fetchRetroarchRecent };
    for (const id of DERIVED_RECENT_LAUNCHER_IDS) {
        if (!FETCHERS[id]) FETCHERS[id] = emulatorFetchers[id] || (() => []);
    }
    const derived = {};
    for (const id of DERIVED_RECENT_LAUNCHER_IDS) derived[id] = { at: 0, list: [] };

    // `appIdOrLauncherId`: either a raw `spawnGame()` appId (the caller does not know exactly which derived source it belongs to — e.g. the
    // launch controller's `bringToFront()`), or directly a launcherId from `DERIVED_RECENT_LAUNCHER_IDS` (the cover download wrappers know it
    // already). WITHOUT an argument (compatibility with the old "clear everything" callers) clears ALL sources.
    function invalidateDerivedRecent(appIdOrLauncherId) {
        if (appIdOrLauncherId === undefined) {
            for (const id of DERIVED_RECENT_LAUNCHER_IDS) derived[id].at = 0;
            return;
        }
        const source = derivedSourceForAppId(appIdOrLauncherId);
        if (source) derived[source].at = 0;
    }

    // Stale-while-revalidate: for the `backgroundSources` (the expensive ones built on a full library scan) an expired cache is NOT
    // refreshed synchronously; the old (empty at startup) list is returned and the refresh runs in the background after `refreshDelayMs`
    // (the fetch may be a Promise); on an actual change ONE `onDerivedChanged()` (main pushes `running-changed`).
    const pendingRefresh = new Set();
    let refreshTimer = null;
    let refreshing = false;

    function scheduleRefresh(launcherId) {
        pendingRefresh.add(launcherId);
        if (refreshing || refreshTimer) return;
        refreshTimer = setTimeout(runRefresh, refreshDelayMs);
    }

    async function runRefresh() {
        refreshTimer = null;
        refreshing = true;
        let changed = false;
        try {
            while (pendingRefresh.size) {
                const [id] = pendingRefresh;
                pendingRefresh.delete(id);
                const entry = derived[id];
                const fetch = FETCHERS[id] || (() => []);
                let list;
                try { list = await fetch(); } catch (err) { list = []; }
                if (!Array.isArray(list)) list = [];
                entry.at = Date.now();
                if (JSON.stringify(list) !== JSON.stringify(entry.list)) changed = true;
                entry.list = list;
                await new Promise((resolve) => setImmediate(resolve)); // let the IPC queue drain
            }
        } finally {
            refreshing = false;
        }
        if (changed) {
            try { onDerivedChanged(); } catch (err) { log(`Derived recent refresh signal error: ${err.message}`); }
        }
    }

    function derivedRecentGames(launcherId) {
        const entry = derived[launcherId];
        if (!entry) return [];
        const now = Date.now();
        if (now - entry.at > DERIVED_RECENT_TTL_MS) {
            if (backgroundSet.has(launcherId)) {
                // Do not reschedule on every call during the pending period — `at` is set to the real time at the end of the refresh anyway.
                entry.at = now;
                scheduleRefresh(launcherId);
                return entry.list;
            }
            const fetch = FETCHERS[launcherId] || (() => []);
            try { entry.list = fetch(); } catch (err) { entry.list = []; }
            entry.at = now;
        }
        return entry.list;
    }

    // Global "Continue" (the latest games of ALL sources): the derived sources (`DERIVED_RECENT_LAUNCHER_IDS`, from the TTL cache) + EVERY
    // stored `recentGames` key (generic, so a new launcher needs no separate wiring here), deduped on `key`, descending by `lastLaunchedAt`,
    // cut to `max`. Lutris (async, mirrored) is merged in later by main.
    function globalRecentGames(max = 3) {
        const derived = [...DERIVED_RECENT_LAUNCHER_IDS].map((id) => derivedRecentGames(id));
        const recent = config.get('recentGames', {});
        const stored = Object.keys(recent)
            .filter((id) => !DERIVED_RECENT_LAUNCHER_IDS.has(id) && Array.isArray(recent[id]))
            .map((id) => recent[id]);
        return mergeRecentGameLists([...derived, ...stored], max);
    }

    // Adds to every launcher object: `usage` (from the config key), `running` (from the caller's `runningIds` Set), `recentGames`
    // (steam/retroarch/pcsx2/rpcs3/ppsspp/duckstation: derived; others: the stored `recentGames`, max 3). There is no separate get-usage /
    // get-recent IPC — this is the `get-launchers` + `launchers-changed` + `running-changed` payload.
    function decorateLaunchers(launchers, runningIds) {
        const usage = config.get('usage', {});
        const recent = config.get('recentGames', {});
        return launchers.map((l) => ({
            ...l,
            usage: usage[l.id] || null,
            running: runningIds.has(l.id),
            recentGames: DERIVED_RECENT_LAUNCHER_IDS.has(l.id)
                ? derivedRecentGames(l.id)
                : (Array.isArray(recent[l.id]) ? recent[l.id] : []).slice(0, 3),
        }));
    }

    // Today's (by local date) total playtime of the sessions launched from the launcher — the measure of the playtime reminder.
    // `playtimeToday` = `{ date: 'YYYY-MM-DD', ms }`; restarts on a new day. Best effort.
    const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    function todayPlaytimeMs() {
        const rec = config.get('playtimeToday', null);
        return rec && rec.date === localDate() && Number.isFinite(rec.ms) ? rec.ms : 0;
    }

    function addTodayPlaytime(ms) {
        try {
            config.set('playtimeToday', { date: localDate(), ms: todayPlaytimeMs() + ms });
        } catch (err) {
            log(`Today's playtime logging failed: ${err.message}`);
        }
    }

    // Successful launch / switch -> `usage[appId].count++` + timestamp. Best effort (a disk error must not block the launch);
    // `config.patch` leaves the other ids untouched.
    function recordUsage(appId) {
        try {
            const prev = config.get('usage', {})[appId];
            // `config.patch('usage', …)` replaces the whole `usage[appId]` entry — without the `...prev` spread the next launch would drop the
            // playtime fields.
            config.patch('usage', {
                [appId]: { ...prev, count: (prev?.count || 0) + 1, lastLaunchedAt: new Date().toISOString() },
            });
        } catch (err) {
            log(`Usage logging failed: ${err.message}`);
        }
    }

    // The length of a closed game session (called by the launch controller's `bringToFront()`). An additive extension of the `usage[appId]`
    // schema: `totalMs` accumulates, `lastSessionMs` is the latest. Best effort; `count`/`lastLaunchedAt` untouched.
    // Returns the new total playtime (ms) — for the renderer's session summary toast; `null` for an invalid/unsaved length.
    function recordUsageDuration(appId, ms) {
        const dur = Number(ms);
        if (!appId || !Number.isFinite(dur) || dur <= 0 || dur > MAX_SESSION_MS) return null;
        addTodayPlaytime(dur);
        try {
            const prev = config.get('usage', {})[appId] || {};
            const totalMs = (prev.totalMs || 0) + dur;
            config.patch('usage', {
                [appId]: {
                    ...prev,
                    totalMs,
                    lastSessionMs: dur,
                },
            });
            return totalMs;
        } catch (err) {
            log(`Usage duration logging failed: ${err.message}`);
            return null;
        }
    }

    // Adds a game launch to the `recentGames` MRU list of the given launcher. Any launcherId is accepted EXCEPT those in
    // `DERIVED_RECENT_LAUNCHER_IDS` (their "recently played" is derived from their OWN data at read time, see `derivedRecentGames` — not
    // booked at launch time). A new launcher needs no change here. Returns whether it actually wrote — the caller decides on the
    // `running-changed` push based on it.
    function recordRecentGame(meta) {
        if (!meta || !meta.launcherId || DERIVED_RECENT_LAUNCHER_IDS.has(meta.launcherId) || !meta.key) return false;
        try {
            const all = config.get('recentGames', {});
            const entry = {
                key: meta.key,
                name: meta.name || meta.key,
                cover: meta.cover || null,
                kind: meta.kind || null,
                params: meta.params || {},
                lastLaunchedAt: new Date().toISOString(),
            };
            config.patch('recentGames', { [meta.launcherId]: pushRecentGame(all[meta.launcherId], entry) });
            return true;
        } catch (err) {
            log(`Recent-game logging failed: ${err.message}`);
            return false;
        }
    }

    // --- Pinned favorite games ---
    // The `favoriteGames` config key is a plain array of `{ key, name, cover, kind, params }` entries — the `key` format matches `recentGames`
    // (`steam-game-<appid>` / `heroic-game-<appName>` / `retroarch:<system>:<label>`).

    function getFavoriteGames() {
        const list = config.get('favoriteGames', []);
        return Array.isArray(list) ? list.filter((e) => e && e.key) : [];
    }

    // Pin/unpin: if `key` is already pinned, unpins it; otherwise puts it at the front. Returns the new state (`favorited`) + the fresh list —
    // the caller sends that to the renderer.
    function toggleFavoriteGame(entry) {
        const cur = getFavoriteGames();
        const key = entry && str(entry.key, FAV_TEXT_MAX);
        if (!key) return { favorited: false, list: cur };
        const has = cur.some((e) => e.key === key);
        let list;
        if (has) {
            list = cur.filter((e) => e.key !== key);
        } else {
            const clean = {
                key,
                name: str(entry.name, FAV_TEXT_MAX) || key,
                cover: str(entry.cover, PATH_MAX),
                kind: str(entry.kind, 40),
                params: primitiveMap(entry.params),
            };
            list = [clean, ...cur].slice(0, MAX_FAVORITE_GAMES);
        }
        try {
            config.set('favoriteGames', list);
        } catch (err) {
            log(`Favorite game save failed: ${err.message}`);
        }
        return { favorited: !has, list };
    }

    return {
        decorateLaunchers, recordUsage, recordUsageDuration, todayPlaytimeMs, recordRecentGame,
        derivedRecentGames, globalRecentGames, invalidateDerivedRecent,
        getFavoriteGames, toggleFavoriteGame,
    };
}

// Playtime stats for the "Statistics" subview. Resolves every entry of the `usage` config key into a displayable row: the static launcher
// ids from the `launchers` list, the `steam-game-*`/`heroic-game-*` ids from the steam/heroic library lists (passed by the caller),
// fallback the raw key. Read-only — no reset. Module-level (NOT part of the `createUsage` factory) — `launchers` is an array mutated in the
// caller, it must be passed fresh on every call, not captured in a construction-time closure.
/**
 * @param {Object} deps
 * @param {typeof import('../config.js')} deps.config
 * @param {import('../types.js').Launcher[]} deps.launchers
 * @param {import('../types.js').Logger} [deps.log]
 * @param {(root: string) => {appid: string|number, name: string}[]} deps.findSteamGames
 * @param {() => string} deps.defaultSteamRoot
 * @param {(root: string) => {appName: string, name: string}[]} deps.findHeroicGames
 * @param {() => string} deps.heroicConfigRoot
 */
function buildUsageStats({
    config, launchers, log = () => {}, findSteamGames, defaultSteamRoot, findHeroicGames, heroicConfigRoot,
}) {
    const usageMap = config.get('usage', {});
    const steamNames = new Map();
    const heroicNames = new Map();
    try {
        for (const g of findSteamGames(defaultSteamRoot())) steamNames.set(String(g.appid), g.name);
    } catch (err) { log(`Statistics: Steam name resolution error: ${err.message}`); }
    try {
        for (const g of findHeroicGames(heroicConfigRoot())) heroicNames.set(g.appName, g.name);
    } catch (err) { log(`Statistics: Heroic name resolution error: ${err.message}`); }

    const rows = [];
    for (const [key, u] of Object.entries(usageMap)) {
        if (!u || typeof u !== 'object') continue;
        let kind = 'unknown';
        let name = key;
        const launcher = launchers.find((l) => l.id === key);
        if (launcher) {
            kind = 'launcher';
            name = launcher.name;
        } else if (key === 'retroarch-game') {
            kind = 'retroarch';
            name = null;
        } else if (key.startsWith('steam-game-')) {
            const id = key.slice('steam-game-'.length);
            kind = 'steam';
            name = steamNames.get(id) || `Steam ${id}`;
        } else if (key.startsWith('heroic-game-')) {
            const appName = key.slice('heroic-game-'.length);
            kind = 'heroic';
            name = heroicNames.get(appName) || appName;
        }
        rows.push({
            key, kind, name,
            count: u.count || 0,
            totalMs: u.totalMs || 0,
            lastSessionMs: u.lastSessionMs || 0,
            lastLaunchedAt: u.lastLaunchedAt || null,
        });
    }
    return rows;
}

/**
 * Sort data of the Games panel: ONLY the game-level entries of the `usage` map (`<source>-game-<id>`; launcher-level ones with a
 * "<launcher-id>" key are not games), per key `{ at: last launch in ms, totalMs, added: first seen in ms }`. Invalid/empty entries
 * are skipped.
 * @param {Record<string, any>} usageMap @param {Record<string, number>} [firstSeen]
 * @returns {Record<string, { at: number, totalMs: number, added: number }>}
 */
function buildGamesSortStats(usageMap, firstSeen = {}) {
    /** @type {Record<string, { at: number, totalMs: number, added: number }>} */
    const out = {};
    if (usageMap && typeof usageMap === 'object') {
        for (const [key, u] of Object.entries(usageMap)) {
            if (!key.includes('-game-') || !u || typeof u !== 'object') continue;
            const at = typeof u.lastLaunchedAt === 'string' ? Date.parse(u.lastLaunchedAt) : NaN;
            const totalMs = Number(u.totalMs) || 0;
            if (!(at > 0) && !(totalMs > 0)) continue;
            out[key] = { at: at > 0 ? at : 0, totalMs, added: 0 };
        }
    }
    // "Recently added": the launcher's "first seen" record (only a value > 0 counts; 0 = seen in the baseline).
    for (const [key, ts] of Object.entries(firstSeen || {})) {
        if (!(ts > 0)) continue;
        if (out[key]) out[key].added = ts;
        else out[key] = { at: 0, totalMs: 0, added: ts };
    }
    return out;
}

module.exports = {
    buildGamesSortStats,
    createUsage, DERIVED_RECENT_TTL_MS, MAX_SESSION_MS, MAX_FAVORITE_GAMES,
    mergeRecentGameLists, derivedSourceForAppId, DERIVED_RECENT_LAUNCHER_IDS,
    buildUsageStats,
};
