// @ts-check
'use strict';

// "Recently played" refresh around a game/launcher session:
//   - `recordRecentGame(meta)`: the recent booked at launch time + if a game of a network-cover emulator (the descriptor's
//     `cover.configKey`: Ryujinx/Dolphin) just landed on the bar, a fire-and-forget download of the missing cover — without a branch
//     per emulator name;
//   - `afterSession(appId)`: after the session closes, the TARGETED cache invalidation + the return warmup.

const { derivedSourceForAppId } = require('./usage.js');

/**
 * @param {Object} deps
 * @param {{ recordRecentGame: (meta: any) => boolean, invalidateDerivedRecent: (appId?: string|null) => void }} deps.usage
 * @param {{ RECENT_COVER_FETCHERS: Record<string, (list?: any) => any>,
 *   DERIVED_MODULE_CACHE_INVALIDATORS: Record<string, () => void> }} deps.recentCovers
 * @param {Record<string, any>} deps.emulatorSources the descriptor (lib/launchers/emulator-sources.js)
 * @param {{ findInstalledGamesCached: { invalidate: () => void } }} deps.lutrisLibrary
 * @param {{ refreshLutrisRecentMirror: () => any }} deps.recentGamesMerge
 * @param {(appId: string|null) => void} deps.scheduleReturnWarmup targeted warmup of the Games panel
 *   (a no-op in safe mode — the caller decides)
 */
function createSessionRefresh({ usage, recentCovers, emulatorSources, lutrisLibrary, recentGamesMerge, scheduleReturnWarmup }) {
    function recordRecentGame(meta) {
        const wrote = usage.recordRecentGame(meta);
        const src = wrote && meta ? emulatorSources[meta.launcherId] : null;
        if (src && src.cover && src.cover.configKey) recentCovers.RECENT_COVER_FETCHERS[meta.launcherId]();
        return wrote;
    }

    // `appId` = the closed session's (`null` if it never actually started — spawn error/watchdog).
    function afterSession(appId) {
        // Only the affected derived source is cleared (lib/recent/usage.js), not all of them.
        usage.invalidateDerivedRecent(appId);
        // `findRecentlyPlayed()` calls the module's own `findInstalledGamesCached()` — that must be cleared too, otherwise the fresh data would
        // lag because of the module cache's TTL.
        const derivedSource = derivedSourceForAppId(appId);
        const invalidateModule = derivedSource && recentCovers.DERIVED_MODULE_CACHE_INVALIDATORS[derivedSource];
        if (invalidateModule) invalidateModule();
        // The Lutris CLI query's own TTL cache: otherwise the "▶ Continue"/"Recently played" bar would not reflect the fresh `lastplayed` until
        // the TTL expires.
        lutrisLibrary.findInstalledGamesCached.invalidate();
        // Content installed meanwhile should be fresh AND warm at the next panel open — TARGETED (only the closed launcher's source + the
        // Steam/Heroic/Lutris client caches are cleared).
        scheduleReturnWarmup(appId);
        recentGamesMerge.refreshLutrisRecentMirror(); // fire-and-forget — the card bar should refresh too
    }

    return { recordRecentGame, afterSession };
}

module.exports = { createSessionRefresh };
