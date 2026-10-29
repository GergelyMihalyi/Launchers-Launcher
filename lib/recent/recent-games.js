// @ts-check
'use strict';

// The per-launcher MRU list of "recently launched games". The carousel shows up to 3 items of it in a mini quick-launch bar under the
// FOCUSED launcher card. Pure helper — main keeps the `recentGames` config key ({ "<launcherId>": [entry, ...] }, lib/config.js); the
// `entry` shape:
//   { key, name, cover, kind, params, lastLaunchedAt }
// where `kind` ∈ 'steam' | 'heroic' | 'retroarch', and `params` is needed to re-invoke the launch IPC
// (steam: { appid }; heroic: { appName, runner }; retroarch: { system, path }).

const MAX_RECENT = 6; // we store this many; the renderer shows 3

// By the CONTRACT of the `findRecentlyPlayed()`-style derived-source helpers (steam/retroarch/pcsx2/rpcs3/ppsspp/duckstation/
// lutris-library.js) the final `lastLaunchedAt` is always an ISO 8601 STRING, not the internal ms-epoch number —
// `mergeRecentGameLists()` in `lib/recent/usage.js` sorts with `Date.parse(entry.lastLaunchedAt)`, which gives NaN for a raw number.
// Every such helper calls THIS instead of using the raw ms.
function msToLaunchedAt(ms) {
    return new Date(ms).toISOString();
}

// A new launch goes to the front of the list: deduped on `key` (the earlier instance drops out, so it does not duplicate and moves to
// the front with the freshest timestamp), finally cut to MAX_RECENT. `list` may be anything (missing key → undefined) — always returns
// an array.
function pushRecentGame(list, entry, max = MAX_RECENT) {
    const base = Array.isArray(list) ? list : [];
    if (!entry || !entry.key) return base.slice(0, max);
    const rest = base.filter((e) => e && e.key !== entry.key);
    return [entry, ...rest].slice(0, max);
}

// The SHARED core of the "recently played" list building repeated in the launcher modules: filter (timestamp > 0) → sort desc →
// slice(max) → map to the recentGames shape. `timeMs(g)` is a RAW ms epoch (the unit is the caller's job — Steam's `LastPlayed` is in
// seconds, `*1000` there); the helper does the `msToLaunchedAt()` conversion so a new module cannot forget it (the raw ms number gave
// `NaN` in `Date.parse()`). Background: docs/dev/config-keys.md#games
function buildRecentEntries(games, {
    timeMs, max = 3, key, kind, params,
}) {
    return (Array.isArray(games) ? games : [])
        .map((g) => ({ g, ms: timeMs(g) }))
        .filter((e) => e.ms > 0)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, Math.max(0, max))
        .map(({ g, ms }) => ({
            key: key(g),
            name: g.name,
            cover: g.cover || null,
            kind,
            params: params(g),
            lastLaunchedAt: msToLaunchedAt(ms),
        }));
}

module.exports = {
    pushRecentGame, MAX_RECENT, msToLaunchedAt, buildRecentEntries,
};
