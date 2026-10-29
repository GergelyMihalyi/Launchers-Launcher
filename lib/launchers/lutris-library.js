// @ts-check
'use strict';

// Lutris library discovery: the CLI (`lutris --list-games --installed --json`) returns the installed list, lastplayed and Lutris's own
// cover path in ONE call — no SQLite reads, no own "last played" bookkeeping (games started from Lutris's own UI are caught too).
// ~0.6–0.7 s per call. Background: docs/dev/launchers/lutris.md

const fs = require('fs');
const { execFileAsync } = require('../exec.js');
const { catalogAppId } = require('../flatpak.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { buildRecentEntries } = require('../recent/recent-games.js');
// The call itself takes ~0.6-0.7 s on the machine (Lutris starts, queries, exits) — explicit timeout (value in lib/timings.js).
const { LUTRIS_LIST_TIMEOUT_MS } = require('../timings.js');

// Decides from the `cmd`/`args` of the actually added Lutris launcher (`customLaunchers` `lutris` entry) whether to call it natively
// (`lutris --list-games ...`) or as a flatpak (`flatpak run net.lutris.Lutris --list-games ...`) — like `steamLaunchSpec()` in
// `lib/ipc/launch-ipc.js`, with the shared `catalogAppId` helper.
function lutrisListSpec(lutrisLauncher) {
    const listArgs = ['--list-games', '--installed', '--json'];
    if (lutrisLauncher && lutrisLauncher.cmd === 'flatpak') {
        return { cmd: 'flatpak', args: ['run', catalogAppId(lutrisLauncher), ...listArgs] };
    }
    return { cmd: (lutrisLauncher && lutrisLauncher.cmd) || 'lutris', args: listArgs };
}

// Lutris's `"YYYY-MM-DD HH:MM:SS"` `lastplayed` field -> ms epoch, or 0 (missing/never played/unparseable). `Date.parse` does not reliably
// recognize the space separator on every engine, so it is replaced with `T` (a near-ISO-8601 form).
function parseLutrisTimestamp(s) {
    if (!s || typeof s !== 'string') return 0;
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
}

// `lutris --list-games --installed --json` output -> a clean entry list. `coverPath` is only taken if it points to an existing file.
// Broken/non-array JSON -> empty list, does not throw.
function parseLutrisGamesJson(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((g) => g && (typeof g.id === 'number' || typeof g.id === 'string') && g.name)
        .map((g) => ({
            id: g.id,
            slug: typeof g.slug === 'string' ? g.slug : '',
            name: g.name,
            lastLaunchedAt: parseLutrisTimestamp(g.lastplayed),
            cover: (typeof g.coverPath === 'string' && fs.existsSync(g.coverPath)) ? g.coverPath : null,
        }));
}

// `lutrisLauncher` is the launcher object added from `customLaunchers` (or `null` if the user did not add Lutris) — passed by the
// caller, the module does not know the config. Not added / the CLI call fails (not installed, timeout) -> empty list, does not throw.
async function findInstalledGames(lutrisLauncher) {
    if (!lutrisLauncher) return [];
    const spec = lutrisListSpec(lutrisLauncher);
    try {
        const { stdout } = await execFileAsync(spec.cmd, spec.args, { timeout: LUTRIS_LIST_TIMEOUT_MS });
        return parseLutrisGamesJson(stdout);
    } catch (err) {
        return [];
    }
}

// TTL-cached variant for the `list-games`/"recently played" IPCs (the call itself takes ~0.6-0.7 s, we do not want to rerun it on
// every panel open/poll).
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

// "Recently played" — from the ALREADY queried `findInstalledGames()` result (no extra I/O, the call above already gave `lastplayed`);
// the caller passes the list (the CLI is not called again).
function findRecentlyPlayed(games, max = 3) {
    return buildRecentEntries(games, {
        timeMs: (g) => g.lastLaunchedAt,
        max,
        key: (g) => `lutris-game-${g.id}`,
        kind: 'lutris',
        params: (g) => ({ id: g.id }),
    });
}

module.exports = {
    lutrisListSpec,
    parseLutrisTimestamp,
    parseLutrisGamesJson,
    findInstalledGames,
    findInstalledGamesCached,
    findRecentlyPlayed,
};
