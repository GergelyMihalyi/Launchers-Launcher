'use strict';

// renderer/games-panel/games-panel-sources.js — consistency of the source tables (GAME_SOURCES /
// EMULATOR_SOURCES / SOURCE_FILTER_LABELS / LAUNCHER_ID_TO_GAMES_SOURCE) + the
// row key / conversion helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GAME_SOURCES, SOURCE_FILTER_LABELS, EMULATOR_SOURCES, EMULATOR_SOURCE_BY_ID,
    EMULATOR_SOURCE_BY_TYPE, LAUNCHER_ID_TO_GAMES_SOURCE, HEROIC_SOURCE_PRIORITY, pickHeroicSource,
    gameRowKey, gameListRowFromApi,
} = require('../../renderer/games-panel/games-panel-sources.js');

test('GAME_SOURCES — every entry has id/label/launch, and launch gives a valid shape', () => {
    assert.ok(GAME_SOURCES.length >= 2);
    for (const s of GAME_SOURCES) {
        assert.equal(typeof s.id, 'string');
        assert.equal(typeof s.label, 'string');
        assert.equal(typeof s.launch, 'function');
        const spec = s.launch({ appid: '42', appName: 'Game', name: 'Game', lutrisId: 7 });
        assert.ok(['steam', 'heroic', 'retroarch', 'lutris'].includes(spec.kind));
        assert.equal(typeof spec.params, 'object');
        if (spec.kind === 'heroic') assert.equal(spec.params.runner, s.id);
    }
});

test('SOURCE_FILTER_LABELS — covers "all"/"retro" + every GAME_SOURCES / EMULATOR_SOURCES id', () => {
    assert.equal(SOURCE_FILTER_LABELS.all, 'MIND');
    assert.equal(SOURCE_FILTER_LABELS.retro, 'RETRO');
    for (const s of GAME_SOURCES) assert.equal(SOURCE_FILTER_LABELS[s.id], s.label);
    for (const s of EMULATOR_SOURCES) assert.equal(SOURCE_FILTER_LABELS[s.id], s.label);
});

test('gameRowKey — gives the key format of recentGames (roadmap 4.4)', () => {
    assert.equal(gameRowKey({ source: 'steam', appid: '620' }), 'steam-game-620');
    assert.equal(gameRowKey({ source: 'gog', appName: 'Hades' }), 'heroic-game-Hades');
    assert.equal(gameRowKey({ source: 'legendary', appName: 'Fortnite' }), 'heroic-game-Fortnite');
    assert.equal(gameRowKey({ source: 'nile', appName: 'X' }), 'heroic-game-X');
    assert.equal(gameRowKey({ source: 'lutris', lutrisId: 7 }), 'lutris-game-7');
    assert.equal(gameRowKey({ source: 'unknown' }), null);
});

// Regression: the field filtering of `gamesPanelRows` forgot `lutrisId` —
// so launching Lutris games failed with a "Missing Lutris game id" error (the GAME_SOURCES
// `launch(row)` relies on `row.lutrisId`).
function sourceLaunch(sourceId, row) {
    return GAME_SOURCES.find((s) => s.id === sourceId).launch(row);
}

test('gameListRowFromApi — does not drop a SINGLE field of list-games (source-specific ids)', () => {
    const steamRow = gameListRowFromApi({ name: 'Portal 2', source: 'steam', appid: '620', cover: '/c.jpg' });
    assert.equal(sourceLaunch('steam', steamRow).params.appid, '620');

    const lutrisRow = gameListRowFromApi({ name: 'Hearthstone', source: 'lutris', lutrisId: 2, cover: null });
    assert.equal(lutrisRow.lutrisId, 2);
    assert.equal(sourceLaunch('lutris', lutrisRow).params.id, 2);

    const heroicRow = gameListRowFromApi({ name: 'Hades', source: 'gog', appName: 'hades_app', cover: null });
    assert.equal(sourceLaunch('gog', heroicRow).params.appName, 'hades_app');
});

// The "Open games" quick-menu row of the launcher card (renderer/home/card-menu.js
// openGamesPanelForLauncher) reads this table — every entry must point only to a source id
// that the games-panel filter model actually knows.
test('LAUNCHER_ID_TO_GAMES_SOURCE — every value is a valid source filter ("retro" or a GAME_SOURCES id or a list-type launcher)', () => {
    const { EMULATOR_REGISTRY } = require('../../launcher-registry.js');
    const knownFilters = new Set(['retro', ...EMULATOR_REGISTRY.map((e) => e.id)]);
    for (const s of GAME_SOURCES) knownFilters.add(s.id);
    assert.ok(Object.keys(LAUNCHER_ID_TO_GAMES_SOURCE).length > 0);
    for (const [launcherId, source] of Object.entries(LAUNCHER_ID_TO_GAMES_SOURCE)) {
        assert.equal(typeof launcherId, 'string');
        assert.ok(knownFilters.has(source), `${launcherId} -> ${source} is not a known games-panel source`);
    }
    // Heroic is INTENTIONALLY not in the table (there is no single 'heroic' source id, see pickHeroicSource).
    assert.equal(LAUNCHER_ID_TO_GAMES_SOURCE.heroic, undefined);
});

test('pickHeroicSource — the first non-empty store in GOG -> Epic -> Amazon order, null for an empty list', () => {
    assert.equal(HEROIC_SOURCE_PRIORITY.join(','), 'gog,legendary,nile');
    const rows = [
        { type: 'game', source: 'legendary' },
        { type: 'game', source: 'nile' },
    ];
    assert.equal(pickHeroicSource(rows), 'legendary'); // no gog -> the next in line
    assert.equal(pickHeroicSource([...rows, { type: 'game', source: 'gog' }]), 'gog');
    assert.equal(pickHeroicSource([]), null);
    assert.equal(pickHeroicSource([{ type: 'retro-system', source: 'gog' }]), null); // wrong type -> does not count
});

test('EMULATOR_SOURCES — every entry has id/type/label/keyPrefix/idField/subheadKey/launch, and launch gives a valid shape', () => {
    assert.ok(EMULATOR_SOURCES.length >= 8);
    for (const s of EMULATOR_SOURCES) {
        assert.equal(typeof s.id, 'string');
        assert.equal(typeof s.type, 'string');
        assert.equal(typeof s.label, 'string');
        assert.equal(typeof s.keyPrefix, 'string');
        assert.equal(typeof s.idField, 'string');
        assert.equal(typeof s.subheadKey, 'string');
        assert.equal(typeof s.launch, 'function');
        const row = {
            id: 'abc', path: '/rom', titleId: 'T1', serial: 'S1', discId: 'D1', gameId: 'G1',
            archiveEntry: null, gamecode: 'GC1',
        };
        const spec = s.launch(row);
        assert.equal(typeof spec.kind, 'string');
        assert.equal(typeof spec.params, 'object');
        assert.equal(EMULATOR_SOURCE_BY_ID[s.id], s);
        assert.equal(EMULATOR_SOURCE_BY_TYPE[s.type], s);
    }
});

test('EMULATOR_SOURCES — no static grid field (grid/list depends on the gamesViewMode switch, see phase G)', () => {
    for (const s of EMULATOR_SOURCES) assert.equal('grid' in s, false, `${s.id} still carries a static grid field`);
});

test('EMULATOR_SOURCES — the network-downloading launchers (ryujinx/pcsx2/dolphin/duckstation) '
    + 'carry networkCover:true, the locally decoded ones (cemu/rpcs3/ppsspp/melonds) do not', () => {
    const withNetwork = ['ryujinx', 'pcsx2', 'dolphin', 'duckstation'];
    const localOnly = ['cemu', 'rpcs3', 'ppsspp', 'melonds'];
    for (const s of EMULATOR_SOURCES) {
        if (withNetwork.includes(s.id)) {
            assert.equal(s.networkCover, true, `${s.id} missing networkCover`);
        } else if (localOnly.includes(s.id)) {
            assert.equal(s.networkCover, undefined, `${s.id} is not networked, but has a networkCover`);
        }
    }
});

// Custom ROM-folder source: the rows of `list-custom-games` → `custom-game` rows.
test('customGameRowsFromApi — badge = the launcher name in uppercase, a game of a launcher that is no longer added is dropped', () => {
    const { customGameRowsFromApi, EMULATOR_SOURCE_BY_TYPE } = require('../../renderer/games-panel/games-panel-sources.js');
    const rows = customGameRowsFromApi([
        { id: 'p:1', launcherId: 'custom-citron', name: 'Zelda', path: '/r/z.nsp', cover: null },
        { id: 'p:2', launcherId: 'torolt', name: 'X', path: '/r/x.nsp', cover: null },
    ], [{ id: 'custom-citron', name: 'Citron' }]);
    assert.deepEqual(rows, [{ type: 'custom-game', id: 'p:1', launcherId: 'custom-citron', name: 'Zelda', path: '/r/z.nsp', cover: null, badge: 'CITRON' }]);
    const src = EMULATOR_SOURCE_BY_TYPE['custom-game'];
    assert.deepEqual(src.launch(rows[0]), { kind: 'custom', params: { launcherId: 'custom-citron', path: '/r/z.nsp' } });
    assert.equal(`${src.keyPrefix}-${rows[0][src.idField]}`, 'custom-game-p:1', 'the favorite key = the recent key of main');
    assert.deepEqual(customGameRowsFromApi(null, []), []);
});
