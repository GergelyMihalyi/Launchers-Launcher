'use strict';

// Mutual consistency of the launcher / game-source tables. The DATA part of the emulator sources
// lives in the shared `launcher-registry.js` (the renderer `EMULATOR_SOURCES` + the two card
// quick-menu tables and the main `GAMES_SOURCE_IDS`/`DERIVED_RECENT_LAUNCHER_IDS`/`NETWORK_COVER_SOURCES`
// derive from it), but the function-heavy tables stayed separate (`GAME_LOADERS`/`GAME_WARMUP_ORDER`/
// `NETWORK_COVER_ENSURE`/the descriptor's `launch`/`COVER_LAUNCHERS`, the startGameLaunch kind map, the
// preload IPC methods) — a missing row would only show at runtime (the cache does not warm up,
// the panel does not open, no cover arrives). This test fails if the tables disagree.
//
// The factory-internal tables (games-ipc.js) are read at source level (the factory cannot be
// constructed without its deps); the registry + the renderer/prefs/usage tables are exported.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const { EMULATOR_REGISTRY, STORE_SOURCE_IDS } = require('../../launcher-registry.js');
const {
    GAME_SOURCES, EMULATOR_SOURCES, LAUNCHER_ID_TO_GAMES_SOURCE, LAUNCHER_GAMES_COUNT_CHECK,
} = require('../../renderer/games-panel/games-panel-sources.js');
const { GAMES_SOURCE_IDS } = require('../../lib/prefs.js');
const { DERIVED_RECENT_LAUNCHER_IDS } = require('../../lib/recent/usage.js');

// Top-level keys of a `const NAME = { ... };` object literal (at the given indent).
function objectKeys(src, name, indent) {
    const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n${' '.repeat(indent - 4)}\\};`));
    assert.ok(m, `${name} not found`);
    return [...m[1].matchAll(new RegExp(`^ {${indent}}(\\w+):`, 'gm'))].map((x) => x[1]);
}

const gamesIpc = read('lib', 'ipc', 'games-ipc.js');
const launchIpc = read('lib', 'ipc', 'launch-ipc.js');
const sourcesSrc = read('renderer', 'games-panel', 'games-panel-sources.js');
const panelSrc = read('renderer', 'games-panel', 'games-panel.js');
const recentCovers = read('lib', 'recent', 'recent-covers.js');
const usageSrc = read('lib', 'recent', 'usage.js');
// Main-side IPC registration: main.js + every `lib/**` module that registers by itself
// (`register*Ipc({ ipcMain, … })`).
const ipcRegSrc = [read('main.js'), ...listJsFiles(path.join(root, 'lib'))
    .map((rel) => read('lib', rel)).filter((src) => src.includes('ipcMain.'))].join('\n');
const preloadSrc = read('preload.js');

// The emulator descriptor (lib/launchers/emulator-sources.js) — with the real library modules and a
// fake context (nothing runs, only the presence of the fields matters).
const { createEmulatorSources } = require('../../lib/launchers/emulator-sources.js');
const emuSources = createEmulatorSources({ config: { get: (k, d) => d }, workerScans: {}, activeRpcs3ConfigRoot: () => '/x' });
const sourceIdsWith = (field) => Object.keys(emuSources).filter((id) => emuSources[id][field]);
// `GAME_LOADERS` = the literal keys (store/retro/custom) + every emulator of the descriptor.
const gameLoaders = [...objectKeys(gamesIpc, 'GAME_LOADERS', 8), ...sourceIdsWith('loader')];
const warmupOrder = [...gamesIpc.match(/const GAME_WARMUP_ORDER = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1]);
const networkCoverEnsure = sourceIdsWith('ensureCovers');
const emulatorLaunches = sourceIdsWith('launch');
// The store-kind map of startGameLaunch (steam/heroic/retroarch/lutris) — the emulators come from
// the registry, over the shared `launch-emulator-game` IPC.
const storeLaunchKinds = objectKeys(panelSrc.replace(/const send = \{/, 'const SEND = {').replace(/\n {4}\}\[kind\] \|\|/, '\n    };'), 'SEND', 8);
const launchKinds = [...storeLaunchKinds, ...EMULATOR_REGISTRY.map((e) => e.id)];
const countCheck = Object.keys(LAUNCHER_GAMES_COUNT_CHECK);
const coverKinds = [...[...recentCovers.matchAll(/^\s+kind: '([^']+)'/gm)].map((m) => m[1]), ...sourceIdsWith('cover')];
// steam/retroarch in usage.js, the derived emulators' via the descriptor's `recent`
assert.match(usageSrc, /const FETCHERS = \{ steam: fetchSteamRecent, retroarch: fetchRetroarchRecent \}/);
const derivedFetchers = ['steam', 'retroarch', ...sourceIdsWith('recent')];

// The registry emulators (the custom ROM source's `custom: true` row is separate).
const emuIds = EMULATOR_SOURCES.filter((s) => !s.custom).map((s) => s.id);
const customSources = EMULATOR_SOURCES.filter((s) => s.custom);
const sorted = (a) => [...a].sort();

test('the source-level parse is not empty (the regexes still match the source)', () => {
    for (const [name, list] of Object.entries({
        gameLoaders, warmupOrder, networkCoverEnsure, emulatorLaunches, storeLaunchKinds, countCheck, coverKinds,
        derivedFetchers,
    })) assert.ok(list.length >= 3, `${name}: only ${list.length} items`);
});

test('GAMES_SOURCE_IDS (prefs) = GAME_SOURCES + EMULATOR_SOURCES + retro', () => {
    const expected = [...GAME_SOURCES.map((s) => s.id), ...emuIds, ...customSources.map((s) => s.id), 'retro'];
    assert.deepEqual(sorted(GAMES_SOURCE_IDS), sorted(expected));
});

test('the store list of the registry = the renderer GAME_SOURCES, EMULATOR_SOURCES = the registry in order', () => {
    assert.deepEqual(STORE_SOURCE_IDS, GAME_SOURCES.map((s) => s.id));
    assert.deepEqual(emuIds, EMULATOR_REGISTRY.map((e) => e.id));
});

// The emulators go over a SHARED, `source`-parameterized IPC — there is no
// per-emulator channel; if someone added one back, a second, unchecked path would open
// next to the whitelisted one.
test('the emulator IPC is shared: list/ensure/launch-emulator-*, no per-emulator channel', () => {
    for (const [ch, method, kind] of [
        ['list-emulator-games', 'listEmulatorGames', 'invoke'],
        ['ensure-emulator-covers', 'ensureEmulatorCovers', 'invoke'],
        ['launch-emulator-game', 'launchEmulatorGame', 'send'],
    ]) {
        assert.ok(preloadSrc.includes(`${method}: '${ch}'`), `preload CH: ${method} → ${ch}`);
        assert.ok(preloadSrc.includes(`${method}: (payload) => ipcRenderer.${kind}(CH.${method}, payload)`),
            `preload api method is missing: ${method}`);
        assert.ok(new RegExp(`ipcMain\\.(handle|on)\\('${ch}'`).test(ipcRegSrc), `main-side IPC handler is missing: ${ch}`);
    }
    for (const e of EMULATOR_REGISTRY) {
        for (const ch of [`list-${e.id}-games`, `ensure-${e.id}-covers`, `launch-${e.id}-game`]) {
            assert.ok(!ipcRegSrc.includes(`'${ch}'`) && !preloadSrc.includes(`'${ch}'`), `per-emulator channel: ${ch}`);
        }
    }
    assert.match(gamesIpc, /function listEmulatorGames\b/);
    assert.match(gamesIpc, /function ensureEmulatorCovers\b/);
    assert.match(launchIpc, /function launchEmulatorGame\b/);
});

test('every emulator source has a GAME_LOADERS step, and every loader is warmed', () => {
    for (const id of emuIds) assert.ok(gameLoaders.includes(id), `missing from GAME_LOADERS: ${id}`);
    assert.deepEqual(sorted(warmupOrder), sorted(gameLoaders), 'GAME_WARMUP_ORDER ≠ keys of GAME_LOADERS');
    assert.equal(new Set(warmupOrder).size, warmupOrder.length, 'duplicate GAME_WARMUP_ORDER item');
});

test('every emulator source is launchable: startGameLaunch kind + main-side handler', () => {
    for (const s of EMULATOR_SOURCES.filter((x) => !x.custom)) {
        const { kind } = s.launch({});
        assert.equal(kind, s.id, `${s.id}: the launch kind differs from the source id`);
        assert.ok(EMULATOR_REGISTRY.some((e) => e.id === kind), `not a registry emulator: ${kind}`);
    }
    for (const s of GAME_SOURCES) {
        const { kind } = s.launch({});
        assert.ok(storeLaunchKinds.includes(kind), `startGameLaunch does not know: ${kind}`);
    }
    // The path-based emulators go through the descriptor's `launch` field; RPCS3 has an explicit
    // handler (title ID + native/flatpak spec).
    assert.deepEqual(sorted(emulatorLaunches), sorted(emuIds.filter((id) => id !== 'rpcs3')));
    assert.match(launchIpc, /function launchRpcs3Game\b/);
});

test('network-cover emulators: registry ↔ NETWORK_COVER_ENSURE ↔ IPC ↔ recent-covers', () => {
    const net = EMULATOR_SOURCES.filter((s) => s.networkCover);
    assert.deepEqual(
        net.map((s) => s.id),
        EMULATOR_REGISTRY.filter((e) => e.networkCover).map((e) => e.id),
    );
    // games-ipc.js builds a descriptor from the registry — but the downloader function is a manual table.
    assert.deepEqual(sorted(net.map((s) => s.id)), sorted(networkCoverEnsure));
    for (const s of net) {
        assert.ok(coverKinds.includes(s.id), `missing from recent-covers COVER_LAUNCHERS: ${s.id}`);
    }
});

test('card quick menu: LAUNCHER_ID_TO_GAMES_SOURCE ↔ LAUNCHER_GAMES_COUNT_CHECK ↔ source ids', () => {
    const targets = Object.values(LAUNCHER_ID_TO_GAMES_SOURCE);
    for (const t of targets) {
        assert.ok(GAMES_SOURCE_IDS.includes(t), `unknown source id: ${t}`);
        assert.ok(countCheck.includes(t), `missing from LAUNCHER_GAMES_COUNT_CHECK: ${t}`);
    }
    for (const id of emuIds) assert.equal(LAUNCHER_ID_TO_GAMES_SOURCE[id], id, `quick menu does not open: ${id}`);
});

test('the derived "recently played" launchers are known launch kinds, and each has a fetcher', () => {
    for (const id of DERIVED_RECENT_LAUNCHER_IDS) {
        assert.ok(launchKinds.includes(id), `DERIVED_RECENT_LAUNCHER_IDS unknown: ${id}`);
    }
    // The registry's `derivedRecent` flag gives the set, but the fetcher is createUsage's
    // manual FETCHERS table — a missing row would be an `undefined()` call at runtime.
    assert.deepEqual(sorted(derivedFetchers), sorted([...DERIVED_RECENT_LAUNCHER_IDS]));
});

// The custom ROM-folder source: ONE `custom` row in the source table, its own loader +
// list/launch IPC + startGameLaunch kind + quick-menu check.
test('custom ROM source: source row ↔ GAME_LOADERS ↔ IPC ↔ startGameLaunch ↔ quick menu', () => {
    assert.deepEqual(customSources.map((s) => [s.id, s.type]), [['custom', 'custom-game']]);
    assert.equal(EMULATOR_SOURCES[EMULATOR_SOURCES.length - 1].custom, true, 'the custom row is at the end of the table');
    assert.ok(GAMES_SOURCE_IDS.includes('custom'));
    assert.ok(gameLoaders.includes('custom') && warmupOrder.includes('custom'));
    assert.equal(customSources[0].launch({ launcherId: 'x', path: '/r.iso' }).kind, 'custom');
    assert.ok(storeLaunchKinds.includes('custom'), 'startGameLaunch does not know: custom');
    assert.ok(countCheck.includes('custom'));
    for (const ch of ['list-custom-games', 'get-custom-game-sources', 'set-custom-game-source', 'launch-custom-game']) {
        assert.ok(new RegExp(`ipcMain\\.(handle|on)\\('${ch}'`).test(ipcRegSrc), `main-side IPC handler is missing: ${ch}`);
        assert.ok(preloadSrc.includes(`'${ch}'`), `preload CH is missing: ${ch}`);
    }
});

// The descriptor has one entry PER EMULATOR — exactly the registry's emulators; the fields agree
// with the registry flags (networkCover ↔ ensureCovers, derivedRecent ↔ recent).
test('emulator descriptor: every registry emulator has an entry + loader, consistent with the flags', () => {
    assert.deepEqual(sorted(Object.keys(emuSources)), sorted(EMULATOR_REGISTRY.map((e) => e.id)));
    for (const e of EMULATOR_REGISTRY) {
        const src = emuSources[e.id];
        assert.equal(typeof src.loader.load, 'function', `${e.id}.loader.load`);
        assert.equal(typeof src.loader.invalidate, 'function', `${e.id}.loader.invalidate`);
        assert.equal(!!e.networkCover, typeof src.ensureCovers === 'function', `${e.id}: networkCover ↔ ensureCovers`);
        assert.equal(!!e.derivedRecent, !!src.recent, `${e.id}: derivedRecent ↔ recent`);
        if (src.recent) assert.equal(typeof src.invalidateModuleCache, 'function', `${e.id}: derived recent without a module-cache invalidation`);
        assert.ok(src.library, `${e.id}.library`);
    }
});

// The ROM-folder emulators (the library has `readGameDirs`) provide `romDirArgs` for the flatpak
// visibility warning (lib/launchers/rom-access.js) — it must not be missed for a new emulator.
test('romDirArgs — the descriptor of every readGameDirs library provides it, and only theirs', () => {
    const withDirs = Object.keys(emuSources).filter((id) => typeof emuSources[id].library.readGameDirs === 'function');
    assert.ok(withDirs.length >= 5, `only ${withDirs.length} readGameDirs libraries`);
    assert.deepEqual(sorted(sourceIdsWith('romDirArgs')), sorted(withDirs));
    for (const id of withDirs) assert.ok(Array.isArray(emuSources[id].romDirArgs()), id);
});
