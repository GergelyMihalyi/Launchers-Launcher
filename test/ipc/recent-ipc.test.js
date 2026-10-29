'use strict';

// lib/ipc/recent-ipc.js — favorites / Continue / "recently played" / statistics / game details.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withTempHome, writeFile } = require('../helpers/fs.js');
const { fakeIpcMain } = require('../helpers/ipc.js');
const { registerRecentIpc } = require('../../lib/ipc/recent-ipc.js');

function registered({ recent = [], loadGames = () => [], emulatorSources = {}, usageMap = {} } = {}) {
    const ipcMain = fakeIpcMain();
    const calls = [];
    let favorites = [{ source: 'steam', id: '620', name: 'Portal 2', cover: null }];
    const h = registerRecentIpc({
        ipcMain,
        config: { get: (k, d) => (k === 'usage' ? usageMap : d) },
        log: () => {},
        safeList: async (label, fn) => ({ ok: true, items: await fn() }),
        recentGamesMerge: { combinedRecentGames: async (n) => recent.slice(0, n) },
        usage: {
            getFavoriteGames: () => favorites,
            toggleFavoriteGame: (entry) => { favorites = [...favorites, entry]; return { favorite: true, list: favorites }; },
        },
        recentCovers: {
            withResolvedAllCovers: (list) => list.map((g) => ({ ...g, resolved: true })),
            ensureAllFavoriteCovers: () => calls.push('ensure-covers'),
        },
        emulatorSources,
        loadGames,
        getActiveLaunchers: () => [],
        findInstalledSteamGames: () => [],
        defaultSteamRoot: () => '/steam',
        findInstalledHeroicGames: () => [],
        heroicConfigRoot: () => '/heroic',
    });
    return { ipcMain, calls, h };
}

test('registerRecentIpc — the favorites/Continue/statistics/details channels', () => {
    const { ipcMain } = registered();
    assert.deepEqual(ipcMain.channels().sort(), [
        'clear-cover-override', 'get-continue-games', 'get-favorite-games', 'get-game-details', 'get-game-launch-option', 'get-games-sort-stats', 'get-usage-stats',
        'list-cover-images', 'list-games-recent', 'note-games-seen', 'set-cover-override', 'set-game-launch-option', 'toggle-favorite-game',
    ]);
});

test('favorites: resolved cover + downloading the missing ones, the toggle gives the new list', () => {
    const { ipcMain, calls } = registered();
    assert.equal(ipcMain.invoke('get-favorite-games')[0].resolved, true);
    const res = ipcMain.invoke('toggle-favorite-game', { source: 'heroic', id: 'Hades', name: 'Hades' });
    assert.equal(res.favorite, true);
    assert.equal(res.list.length, 2);
    assert.ok(res.list.every((g) => g.resolved));
    assert.deepEqual(calls, ['ensure-covers', 'ensure-covers']);
});

test('list-games-recent / get-continue-games — 10 and 3 items, with manual cover override', async () => {
    await withTempHome(async (home) => {
        const pcsx2 = writeFile(path.join(home, 'Pictures', 'launchers-launcher', 'covers'), 'pcsx2/SCUS-97472.png', 'x');
        const recent = Array.from({ length: 12 }, (_, i) => ({ key: i ? `x-${i}` : 'pcsx2-game-SCUS-97472', cover: null }));
        const { h } = registered({ recent });
        const list = (await h.listGamesRecent()).items;
        assert.equal(list.length, 10);
        assert.equal(list[0].cover, pcsx2);
        assert.equal((await h.getContinueGames()).length, 8);
    });
});

test('get-game-details — the native playtime through loadGames of games-ipc (Steam)', async () => {
    const { h } = registered({ loadGames: (id) => (id === 'steam' ? [{ appid: '620', lastPlayed: 1700000000 }] : []) });
    const res = await h.getGameDetails({ kind: 'steam', key: 'steam-game-620', name: 'Portal 2', params: { appid: '620' } });
    assert.equal(res.ok, true);
    assert.deepEqual(res.native, { playtimeMs: null, lastPlayedAt: 1700000000000, label: 'Steam' });
});

test('get-games-sort-stats — only game-level, measurable usage entries, in ms', async () => {
    const { h } = registered({
        usageMap: {
            steam: { count: 3, lastLaunchedAt: '2026-01-01T00:00:00.000Z', totalMs: 5 },
            'steam-game-620': { count: 1, lastLaunchedAt: '2026-01-02T00:00:00.000Z', totalMs: 60000 },
            'ryujinx-game-x': { count: 1, totalMs: 1000 },
            'pcsx2-game-y': { count: 0 },
        },
    });
    const res = await h.getGamesSortStats();
    assert.equal(res.ok, true);
    assert.deepEqual(res.items, {
        'steam-game-620': { at: Date.parse('2026-01-02T00:00:00.000Z'), totalMs: 60000, added: 0 },
        'ryujinx-game-x': { at: 0, totalMs: 1000, added: 0 },
    });
});
