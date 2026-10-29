// @ts-check
'use strict';

// IPC of "recently played" / favorites / playtime. Channels: `list-games-recent` (the Games panel's ALL bar),
// `get-continue-games` (the header's "▶ Continue" bar), `get-favorite-games` / `toggle-favorite-game` (pinned favorites),
// `get-usage-stats` (playtime stats), `get-game-details` (the game details view). Game lists (Steam/Lutris native playtime)
// are read through the games-ipc `loadGames(id)` — `GAME_LOADERS` stays the SINGLE place of sources (same TTL cache key).

const { createGameDetails } = require('../games/game-details.js');
const { createGameMetadata } = require('../games/game-metadata.js');
const { buildUsageStats, buildGamesSortStats } = require('../recent/usage.js');
const {
    applyCoverOverridesToEntries, listCoverImages, installCoverOverride, removeCoverOverride,
} = require('../launchers/shared/cover-override.js');
const { requireDeps } = require('./require-deps.js');
const { createGamesFirstSeen } = require('../recent/games-first-seen.js');
const { arrayOf, str } = require('../validate.js');

// Maximum item count of the home screen's Continue bar (the bar is full-width under the header).
const CONTINUE_BAR_MAX = 8;

/**
 * @param {Object} deps
 * @param {Object} deps.config
 * @param {(msg: string) => void} deps.log
 * @param {(label: string, fn: () => Promise<any>) => Promise<{ok: boolean, items: any[]}>} deps.safeList
 * @param {{ combinedRecentGames: (n: number) => Promise<any[]> }} deps.recentGamesMerge
 * @param {{ getFavoriteGames: () => any[], toggleFavoriteGame: (entry: any) => { list: any[] } }} deps.usage
 * @param {{ withResolvedAllCovers: (list: any[]) => any[], ensureAllFavoriteCovers: (list: any[]) => void }} deps.recentCovers
 * @param {Record<string, any>} deps.emulatorSources descriptor of the registry emulators (`nativePlay`)
 * @param {(id: string) => any} deps.loadGames the games-ipc source loader (`GAME_LOADERS[id].load()`)
 * @param {() => any[]} deps.getActiveLaunchers the ordered launcher list (stats)
 * @param {{ getGameLaunchOption: (key: string) => string, setGameLaunchOption: (key: string, text: string) => Object }} [deps.prefs] for the launch options
 * @param {Object} deps.findInstalledSteamGames
 * @param {() => string} deps.defaultSteamRoot
 * @param {Object} deps.findInstalledHeroicGames
 * @param {() => string} deps.heroicConfigRoot
 */
function createRecentHandlers(deps) {
    const {
        config, log, safeList, recentGamesMerge, usage, recentCovers, emulatorSources, loadGames, getActiveLaunchers,
        prefs = null,
    } = deps;
    requireDeps(deps, ['config', 'log', 'safeList', 'recentGamesMerge', 'usage', 'recentCovers', 'emulatorSources', 'loadGames', 'getActiveLaunchers', 'findInstalledSteamGames', 'defaultSteamRoot', 'findInstalledHeroicGames', 'heroicConfigRoot'], 'createRecentHandlers');

    // The "recently played" summary bar of the Games panel's root view under the "ALL" filter — from EVERY launcher.
    // Same basis as the header's "▶ Continue" bar (`recentGamesMerge.combinedRecentGames`), just with more items.
    function listGamesRecent() {
        return safeList('Recently played list error', async () => applyCoverOverridesToEntries(
            await recentGamesMerge.combinedRecentGames(10),
        ));
    }

    // Global "Continue" bar — every source's top 3 combined.
    async function getContinueGames() {
        return applyCoverOverridesToEntries(await recentGamesMerge.combinedRecentGames(CONTINUE_BAR_MAX));
    }

    // Favorite covers: resolve + manual override, missing ones downloaded fire-and-forget.
    function favoritesWithCovers(list) {
        const out = applyCoverOverridesToEntries(recentCovers.withResolvedAllCovers(list));
        recentCovers.ensureAllFavoriteCovers(out);
        return out;
    }

    // Pinned favorites — the toggle returns the new state.
    function getFavoriteGames() {
        return favoritesWithCovers(usage.getFavoriteGames());
    }

    function toggleFavoriteGame(entry) {
        const res = usage.toggleFavoriteGame(entry);
        return { ...res, list: favoritesWithCovers(res.list) };
    }

    // Playtime stats.
    function getUsageStats() {
        return buildUsageStats({
            config, launchers: getActiveLaunchers(), log,
            findSteamGames: deps.findInstalledSteamGames, defaultSteamRoot: deps.defaultSteamRoot,
            findHeroicGames: deps.findInstalledHeroicGames, heroicConfigRoot: deps.heroicConfigRoot,
        });
    }

    // Game details view (lib/games/game-details.js): the emulator's / client's OWN playtime bookkeeping per kind.
    // `playtime.dat`/`[PlayTime]`/`persistent_settings.dat` are small text files (one read per details open);
    // Steam/Lutris come from the TTL-cached list.
    const NATIVE_PLAY = {
        // the emulators' OWN bookkeeping from the descriptor (PCSX2/DuckStation `playtime.dat`, PPSSPP
        // `[PlayTime]`, RPCS3 `persistent_settings.dat`)
        ...Object.fromEntries(Object.entries(emulatorSources)
            .filter(([, src]) => src.nativePlay).map(([id, src]) => [id, src.nativePlay])),
        steam: async (p) => {
            const g = (await loadGames('steam')).find((x) => String(x.appid) === String(p.appid));
            return g && g.lastPlayed ? { playtimeMs: null, lastPlayedAt: g.lastPlayed * 1000, label: 'Steam' } : null;
        },
        lutris: async (p) => {
            const g = (await loadGames('lutris')).find((x) => String(x.id) === String(p.id));
            return g && g.lastLaunchedAt ? { playtimeMs: null, lastPlayedAt: g.lastLaunchedAt, label: 'Lutris' } : null;
        },
    };
    const gameMetadata = createGameMetadata({ defaultSteamRoot: deps.defaultSteamRoot, heroicConfigRoot: deps.heroicConfigRoot });
    const gameDetails = createGameDetails({ config, nativePlay: NATIVE_PLAY, log, metadata: (kind, params) => gameMetadata.get(kind, params) });

    async function getGameDetails(entry) {
        try {
            return { ok: true, ...(await gameDetails.getGameDetails(entry)) };
        } catch (err) {
            log(`Game details error: ${err.message}`);
            return { ok: false };
        }
    }

    // "NEW" badge: the panel sends the keys of the non-RetroArch rows; main records the "first seen" time and
    // returns the keys that appeared in the last 7 days and were not launched yet.
    const firstSeen = createGamesFirstSeen(config);
    function noteGamesSeen(keys) {
        try {
            const list = arrayOf(keys, (k) => str(k, 600), 6000);
            return { ok: true, newKeys: firstSeen.noteSeen(list, config.get('usage', {})).newKeys };
        } catch (err) {
            log(`New-games bookkeeping error: ${err.message}`);
            return { ok: false, newKeys: [] };
        }
    }

    // For the Games panel sort: last launch + accumulated playtime per game from the `usage` key (the key = the
    // game row's favorite key). Only non-empty entries.
    function getGamesSortStats() {
        try {
            return { ok: true, items: buildGamesSortStats(config.get('usage', {}), firstSeen.read()) };
        } catch (err) {
            log(`Sort statistics error: ${err.message}`);
            return { ok: false, items: {} };
        }
    }

    // Manual cover picker (from the game details view): the selectable images, installing the chosen image into the
    // override folder (COPY), and deleting the override. The lib only accepts a source path that is a direct image
    // file of the listed folders (`installCoverOverride`).
    async function listCoverImagesHandler() {
        try {
            return { ok: true, items: await listCoverImages() };
        } catch (err) {
            log(`Cover image listing error: ${err.message}`);
            return { ok: false, items: [] };
        }
    }

    async function setCoverOverride(payload) {
        if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid' };
        const res = await installCoverOverride({ key: str(payload.key, 600), srcPath: str(payload.path, 4096) });
        log(res.ok ? `Cover override set: ${payload.key}` : `Cover override error (${payload.key}): ${res.error}`);
        return res;
    }

    async function clearCoverOverride(key) {
        const res = await removeCoverOverride({ key: str(key, 600) });
        log(res.ok ? `Cover override removed: ${key}` : `Cover override removal error (${key}): ${res.error}`);
        return res;
    }

    // Per-game launch options (lib/launch/launch-options.js): `key` = the game key (the renderer's `gameOptionsKey`);
    // `set` rejects unparseable text (`{ ok: false, error }`), empty text deletes.
    function getGameLaunchOption(key) {
        return { ok: !!prefs, text: prefs ? prefs.getGameLaunchOption(key) : '' };
    }

    function setGameLaunchOption(payload) {
        if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid' };
        try {
            if (!prefs) return { ok: false, error: 'unavailable' };
            return prefs.setGameLaunchOption(payload.key, payload.text);
        } catch (err) {
            log(`Launch option save error: ${err.message}`);
            return { ok: false, error: 'save-failed' };
        }
    }

    return {
        listGamesRecent, getContinueGames, getFavoriteGames, toggleFavoriteGame, getUsageStats, getGameDetails, getGamesSortStats,
        getGameLaunchOption, setGameLaunchOption, noteGamesSeen, listCoverImages: listCoverImagesHandler, setCoverOverride, clearCoverOverride,
    };
}

/**
 * @param {Parameters<typeof createRecentHandlers>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerRecentIpc(deps) {
    const { ipcMain } = deps;
    requireDeps(deps, ['ipcMain'], 'registerRecentIpc');
    const h = createRecentHandlers(deps);
    ipcMain.handle('list-games-recent', () => h.listGamesRecent());
    ipcMain.handle('get-continue-games', () => h.getContinueGames());
    ipcMain.handle('get-favorite-games', () => h.getFavoriteGames());
    ipcMain.handle('toggle-favorite-game', (event, entry) => h.toggleFavoriteGame(entry));
    ipcMain.handle('get-usage-stats', () => h.getUsageStats());
    ipcMain.handle('get-games-sort-stats', () => h.getGamesSortStats());
    ipcMain.handle('get-game-launch-option', (event, key) => h.getGameLaunchOption(key));
    ipcMain.handle('set-game-launch-option', (event, payload) => h.setGameLaunchOption(payload));
    ipcMain.handle('list-cover-images', () => h.listCoverImages());
    ipcMain.handle('set-cover-override', (event, payload) => h.setCoverOverride(payload));
    ipcMain.handle('clear-cover-override', (event, key) => h.clearCoverOverride(key));
    ipcMain.handle('note-games-seen', (event, keys) => h.noteGamesSeen(keys));
    ipcMain.handle('get-game-details', (event, entry) => h.getGameDetails(entry));
    return h;
}

module.exports = { createRecentHandlers, registerRecentIpc };
