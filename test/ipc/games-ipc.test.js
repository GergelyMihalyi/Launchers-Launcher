'use strict';

// lib/ipc/games-ipc.js — the mapping of the targeted cache warmup on return (appId → source).
// The rest of the handler factory is covered by the launcher library modules' own tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { warmupSourcesForAppId, WARMUP_CLIENT_SOURCES } = require('../../lib/ipc/games-ipc.js');

const LOADERS = [
    'steam', 'heroic', 'lutris', 'retroSystems', 'retroAll', 'ryujinx', 'pcsx2', 'cemu',
    'rpcs3', 'ppsspp', 'dolphin', 'melonds', 'duckstation',
];
const sorted = (a) => [...a].sort();

test('warmupSourcesForAppId — the Steam/Heroic/Lutris client is ALWAYS included', () => {
    assert.deepEqual(sorted(warmupSourcesForAppId(null, LOADERS)), sorted(WARMUP_CLIENT_SOURCES));
    assert.deepEqual(sorted(warmupSourcesForAppId('egyeni-launcher', LOADERS)), sorted(WARMUP_CLIENT_SOURCES));
});

test('warmupSourcesForAppId — both game and card launch give the launcher source', () => {
    assert.ok(warmupSourcesForAppId('melonds-game-p:0123456789abcdef', LOADERS).includes('melonds'));
    assert.ok(warmupSourcesForAppId('pcsx2', LOADERS).includes('pcsx2'));
    assert.ok(!warmupSourcesForAppId('pcsx2', LOADERS).includes('melonds'));
    assert.deepEqual(sorted(warmupSourcesForAppId('steam-game-620', LOADERS)), sorted(WARMUP_CLIENT_SOURCES));
});

test('warmupSourcesForAppId — RetroArch: the system summary AND the full ROM set', () => {
    for (const appId of ['retroarch-game', 'retroarch']) {
        const out = warmupSourcesForAppId(appId, LOADERS);
        assert.ok(out.includes('retroSystems') && out.includes('retroAll'), appId);
    }
});

test('warmupSourcesForAppId — returns only an existing loader key', () => {
    assert.deepEqual(warmupSourcesForAppId('cemu-game-1', ['cemu']), ['cemu']);
});

// --- Manual cover override at the handler boundary ---
const path = require('node:path');
const { withTempHome, writeFile } = require('../helpers/fs.js');
const { createGamesHandlers, registerGamesIpc } = require('../../lib/ipc/games-ipc.js');
const { fakeIpcMain } = require('../helpers/ipc.js');
const { createGameSourcesHandlers } = require('../../lib/ipc/game-sources-ipc.js');
const { createEmulatorSources } = require('../../lib/launchers/emulator-sources.js');

function cached(fn) {
    const f = (...args) => fn(...args);
    f.invalidate = () => {};
    return f;
}

function fakeHandlers({ recent = [], extra = {}, config = { get: (k, d) => d }, factory = createGamesHandlers } = {}) {
    const emu = (rootName, rows) => ({ findInstalledGamesCached: cached(() => rows), [rootName]: () => '/x' });
    const worker = (rows) => cached(async () => rows);
    const scans = {
        retroAll: null, ppsspp: worker([]), melonds: worker([]), duckstation: worker([]),
        ryujinx: worker([]), cemu: worker([]), dolphin: worker([]),
        pcsx2: worker([{ id: 'SCUS-97472', name: 'SotC', cover: null }]),
    };
    const retroAll = [
        { system: 'Sony - PlayStation', games: [{ label: 'Tekken 3', path: '/r/t3.cue', cover: null }] },
        { system: 'Sega - Mega Drive - Genesis', games: [{ label: 'Sonic', path: '/r/s.md', cover: '/c/s.png' }] },
    ];
    scans.retroAll = worker(retroAll);
    return factory({
        config,
        log: () => {},
        sendToRenderer: () => {},
        prefs: { getCoverDownload: () => true },
        downloadFile: async () => false,
        safeList: async (label, fn) => ({ ok: true, items: await fn() }),
        findInstalledSteamGames: cached(() => [{ appid: '620', name: 'Portal 2', cover: '/steam/620.jpg' }]),
        defaultSteamRoot: () => '/steam',
        findInstalledHeroicGames: cached(() => [{ appName: 'Hades', runner: 'gog', name: 'Hades', cover: null }]),
        heroicConfigRoot: () => '/heroic',
        lutrisLibrary: { findInstalledGamesCached: cached(async () => []) },
        findRetroarchSystemCounts: cached(() => []),
        findRetroarchGamesForSystem: cached(() => [{ label: 'Tekken 3', path: '/r/t3.cue', cover: null }]),
        ensureRetroarchThumbnails: async () => 0,
        retroarchConfigRoot: () => '/ra',
        recentGamesMerge: {
            lutrisLauncherEntry: () => null,
            activeRpcs3ConfigRoot: () => '/rpcs3',
            combinedRecentGames: async () => recent,
        },
        workerScans: scans,
        emulatorSources: createEmulatorSources({
            config, workerScans: scans, activeRpcs3ConfigRoot: () => '/rpcs3',
            libs: {
                ryujinx: emu('ryujinxConfigRoot', []),
                pcsx2: emu('pcsx2ConfigRoot', [{ id: 'SCUS-97472', name: 'SotC', cover: null }]),
                cemu: emu('cemuConfigRoot', []),
                rpcs3: { findInstalledGamesCached: cached(() => [{ titleId: 'BLUS30001', name: 'X', cover: null }]) },
                ppsspp: { ppssppConfigRoot: () => '/x' },
                dolphin: emu('dolphinConfigRoot', []),
                melonds: { melondsConfigRoot: () => '/x' },
                duckstation: { duckstationConfigRoot: () => '/x' },
            },
        }),
        ...extra,
    });
}

test('manual cover override: the Games lists and RetroArch from the covers/ folder', async () => {
    await withTempHome(async (home) => {
        const root = path.join(home, 'Pictures', 'launchers-launcher', 'covers');
        const steam = writeFile(root, 'steam/620.png', 'x');
        const heroic = writeFile(root, 'heroic/Hades.jpg', 'x');
        const pcsx2 = writeFile(root, 'pcsx2/SCUS-97472.png', 'x');
        const rpcs3 = writeFile(root, 'rpcs3/BLUS30001.png', 'x');
        const tekken = writeFile(root, 'retroarch/Sony - PlayStation/Tekken 3.png', 'x');
        const h = fakeHandlers();

        const games = (await h.listGames()).items;
        assert.equal(games.find((g) => g.source === 'steam').cover, steam);
        assert.equal(games.find((g) => g.source === 'gog').cover, heroic);
        assert.equal((await h.listEmulatorGames({ source: 'pcsx2' })).items[0].cover, pcsx2);
        assert.equal((await h.listEmulatorGames({ source: 'rpcs3' })).items[0].cover, rpcs3, 'RPCS3: the titleId is the identifier');
        assert.equal((await h.listRetroarchGames('Sony - PlayStation')).items[0].cover, tekken);
        const all = (await h.listRetroarchAllGames()).items;
        assert.equal(all[0].games[0].cover, tekken);
        assert.equal(all[1].games[0].cover, '/c/s.png', 'a system that is not overridden is unchanged');
    });
});

test('manual cover override: without a covers/ folder the covers are unchanged', async () => {
    await withTempHome(async () => {
        const h = fakeHandlers();
        assert.equal((await h.listGames()).items.find((g) => g.source === 'steam').cover, '/steam/620.jpg');
        assert.equal((await h.listEmulatorGames({ source: 'pcsx2' })).items[0].cover, null);
    });
});

// The shared `list-emulator-games` / `ensure-emulator-covers` IPC: whitelist.
test('listEmulatorGames / ensureEmulatorCovers — unknown source: ok:false, no loader call', async () => {
    const h = fakeHandlers();
    for (const payload of [{ source: 'nope' }, { source: '__proto__' }, { source: 'steam' }, {}, null]) {
        assert.deepEqual(await h.listEmulatorGames(payload), { ok: false, items: [] });
        assert.deepEqual(await h.ensureEmulatorCovers(payload), { ok: false, items: [] });
    }
    // local-cover (non-network) source: no downloader
    assert.deepEqual(await h.ensureEmulatorCovers({ source: 'cemu', ids: ['x'] }), { ok: false, items: [] });
});

// Custom ROM-folder source: setting (for an existing launcher, normalized) + list.
// SETTING the source is in lib/ipc/game-sources-ipc.js, the list is here — the two connect
// through the games handlers' `invalidateGameSource` (fresh scan after a change).
test('setCustomGameSource (game-sources-ipc) / listCustomGames — save, reject, delete; the cache is cleared', async () => {
    const { tmpDir } = require('../helpers/fs.js');
    const root = tmpDir();
    writeFile(root, 'Game_One.iso', 'x');
    const store = {};
    const config = { get: (k, d) => (k in store ? structuredClone(store[k]) : d), set: (k, v) => { store[k] = structuredClone(v); } };
    const games = fakeHandlers({ config });
    const h = {
        listCustomGames: games.listCustomGames,
        ...createGameSourcesHandlers({
            config, log: () => {}, sendToRenderer: () => {}, emulatorSources: {},
            invalidateGameSource: games.invalidateGameSource, getLaunchers: () => [{ id: 'custom-x' }],
            workerScans: {},
        }),
    };
    assert.equal(h.setCustomGameSource({ launcherId: 'missing', dirs: [root], exts: ['.iso'] }).ok, false);
    assert.equal(h.setCustomGameSource({ launcherId: 'custom-x', dirs: [], exts: ['.iso'] }).ok, false);
    const res = h.setCustomGameSource({ launcherId: 'custom-x', dirs: [root], exts: ['ISO'], argsTemplate: '' });
    assert.equal(res.ok, true);
    assert.deepEqual(store.customGameSources, [{ launcherId: 'custom-x', dirs: [root], exts: ['.iso'], argsTemplate: '{rom}' }]);
    const list = await h.listCustomGames();
    assert.deepEqual(list.items.map((g) => [g.launcherId, g.name]), [['custom-x', 'Game One']]);
    assert.equal(h.setCustomGameSource({ launcherId: 'custom-x', remove: true }).ok, true);
    assert.deepEqual(store.customGameSources, []);
    assert.deepEqual((await h.listCustomGames()).items, [], 'after the delete the cache gives no old list either');
});

test('clearGamesCache — deletes the cover cache, clears the negative + derived cache (C7)', async () => {
    await withTempHome(async (home) => {
        const root = path.join(home, '.local', 'share', 'launchers-launcher');
        writeFile(root, 'covers/pcsx2/SCUS-97472.png', 'xyz');
        const calls = [];
        const h = fakeHandlers({
            extra: {
                coverMisses: { clear: () => calls.push('misses') },
                invalidateDerivedRecent: () => calls.push('recent'),
            },
        });
        const info = await h.getGamesCacheInfo();
        assert.equal(info.ok, true);
        assert.equal(info.items.find((d) => d.id === 'covers').bytes, 3);
        const res = await h.clearGamesCache();
        assert.deepEqual(res, { ok: true, freedBytes: 3 });
        assert.deepEqual(calls, ['misses', 'recent']);
        assert.equal((await h.getGamesCacheInfo()).items.find((d) => d.id === 'covers').bytes, 0);
    });
});

// --- registerGamesIpc: the channels + the body of the manual "Refresh" ---
function registered() {
    const ipcMain = fakeIpcMain();
    const calls = [];
    const h = fakeHandlers({
        factory: registerGamesIpc,
        extra: {
            ipcMain,
            pushLauncherState: () => calls.push('push'),
            usage: { invalidateDerivedRecent: () => calls.push('invalidate') },
        },
    });
    return { ipcMain, calls, h };
}

test('registerGamesIpc — returns the handlers, and registers the "Games" channels', () => {
    const { ipcMain, h } = registered();
    assert.equal(typeof h.scheduleGamesWarmup, 'function');
    assert.equal(typeof h.loadGames, 'function');
    for (const ch of ['list-games', 'list-emulator-games', 'ensure-emulator-covers', 'refresh-games', 'list-custom-games']) {
        assert.ok(ipcMain.channels().includes(ch), ch);
    }
    // the channels of the extracted domains are NOT here (recent-ipc, game-sources-ipc)
    for (const ch of ['get-favorite-games', 'get-usage-stats', 'browse-dir', 'set-melonds-rom-dirs']) {
        assert.ok(!ipcMain.channels().includes(ch), ch);
    }
});

test('registerGamesIpc — refresh-games: rescans, clears the derived recent, pushes', async () => {
    const { ipcMain, calls } = registered();
    await ipcMain.invoke('refresh-games');
    assert.deepEqual(calls, ['invalidate', 'push']);
});

test('loadGames — gives the source of GAME_LOADERS (the native playtime of recent-ipc goes through this)', () => {
    assert.equal(fakeHandlers().loadGames('steam')[0].appid, '620');
});

// The three "Games" IPC domains in one call (lib/ipc/ipc-groups.js) — recent-ipc gets the games
// `loadGames`, game-sources gets `invalidateGameSource`.
test('registerGamesDomainIpc — games + recent + game-sources channels, with the wiring between them', async () => {
    const { registerGamesDomainIpc } = require('../../lib/ipc/ipc-groups.js');
    const ipcMain = fakeIpcMain();
    const out = fakeHandlers({
        factory: registerGamesDomainIpc,
        extra: {
            ipcMain, pushLauncherState: () => {}, getActiveLaunchers: () => [], getLaunchers: () => [],
            usage: { invalidateDerivedRecent: () => {}, getFavoriteGames: () => [], toggleFavoriteGame: () => ({ list: [] }) },
            recentCovers: { withResolvedAllCovers: (l) => l, ensureAllFavoriteCovers: () => {} },
        },
    });
    for (const ch of ['list-games', 'get-favorite-games', 'get-game-details', 'browse-dir', 'set-custom-game-source']) {
        assert.ok(ipcMain.channels().includes(ch), ch);
    }
    assert.equal(typeof out.games.scheduleGamesWarmup, 'function');
    assert.equal(typeof out.gameSources.getCustomGameSources, 'function');
    const details = await ipcMain.invoke('get-game-details', { kind: 'steam', key: 'steam-game-620', params: { appid: '620' } });
    assert.equal(details.ok, true);
});
