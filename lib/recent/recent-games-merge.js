// @ts-check
'use strict';

// Merges the "recently played" list of Lutris (an async CLI source) with the synchronous `globalRecentGames()` of `usage.js` + resolves
// the active (native/flatpak) config root of RPCS3. The Lutris CLI call takes ~0.6-0.7 s — it does not fit the SYNC API of
// `lib/recent/usage.js`, so this module gets the `usage` object (the result of `createUsage()`) via DI instead of extending `usage.js`.
// No `BrowserWindow` reference.

/**
 * @param {Object} deps
 * @param {() => import('../types.js').Launcher[]} deps.getLaunchers the fresh value of the `launchers` array mutated in `main.js`
 * @param {Object} deps.lutrisLibrary
 * @param {Object} deps.rpcs3Library
 * @param {{ globalRecentGames: (max: number) => any[] }} deps.usage the result of `createUsage()`
 * @param {(lists: any[][], max?: number) => any[]} deps.mergeRecentGameLists
 * @param {typeof import('../config.js')} deps.config
 * @param {import('../types.js').Logger} deps.log
 * @param {(channel: string, payload: any) => void} deps.sendToRenderer
 * @param {() => any} deps.launchersPayload
 */
function createRecentGamesMerge({
    getLaunchers, lutrisLibrary, rpcs3Library, usage, mergeRecentGameLists,
    config, log, sendToRenderer, launchersPayload,
}) {
    // Returns the added `lutris` launcher object (`null` if not added — `lutrisLibrary` then runs nothing).
    function lutrisLauncherEntry() {
        return getLaunchers().find((l) => l.id === 'lutris') || null;
    }

    // RPCS3's config root by the added launcher's `cmd` (native AppImage OR flatpak): flatpak → the usual `flatpakConfigRoot`; otherwise
    // (native, OR not added — native fallback, as in `rpcs3LaunchSpec`) → `~/.config/rpcs3`.
    function activeRpcs3ConfigRoot() {
        const entry = getLaunchers().find((l) => l.id === 'rpcs3');
        return (entry && entry.cmd === 'flatpak') ? rpcs3Library.rpcs3FlatpakConfigRoot() : rpcs3Library.rpcs3ConfigRoot();
    }

    async function lutrisRecentGames(max) {
        const games = await lutrisLibrary.findInstalledGamesCached(lutrisLauncherEntry());
        return lutrisLibrary.findRecentlyPlayed(games, max);
    }

    // Merges `usage.globalRecentGames()` (steam/retroarch/pcsx2/rpcs3/ppsspp/duckstation derived + EVERY stored recentGames source) with the
    // async Lutris list — called by both the `get-continue-games` and `list-games-recent` handlers, just with a different `max` (3 for the
    // header's "▶ Continue" bar, 10 for the games panel's "Recently played" summary).
    async function combinedRecentGames(max) {
        const lutrisRecent = await lutrisRecentGames(max);
        return mergeRecentGameLists([usage.globalRecentGames(max), lutrisRecent], max);
    }

    // Mirrors Lutris's "recently played" top 3 into the `recentGames.lutris` key — read by the SYNC path of `decorateLaunchers()`. The CLI call
    // is async, so it refreshes fire-and-forget (at startup + from the `invalidateRecent` callback), and only writes + pushes
    // `running-changed` on an ACTUAL change; one run at a time (`lutrisRecentMirrorInFlight`). Background: docs/dev/launchers/lutris.md
    let lutrisRecentMirrorInFlight = false;
    async function refreshLutrisRecentMirror() {
        if (lutrisRecentMirrorInFlight) return;
        lutrisRecentMirrorInFlight = true;
        try {
            const list = await lutrisRecentGames(3);
            const prevList = config.get('recentGames', {}).lutris;
            if (JSON.stringify(list) !== JSON.stringify(Array.isArray(prevList) ? prevList : [])) {
                config.patch('recentGames', { lutris: list });
                sendToRenderer('running-changed', launchersPayload());
            }
        } catch (err) {
            log(`Lutris recent mirroring error: ${err.message}`);
        } finally {
            lutrisRecentMirrorInFlight = false;
        }
    }

    return {
        lutrisLauncherEntry, activeRpcs3ConfigRoot, lutrisRecentGames,
        combinedRecentGames, refreshLutrisRecentMirror,
    };
}

module.exports = { createRecentGamesMerge };
