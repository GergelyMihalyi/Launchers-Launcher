'use strict';

// The shared launcher registry (launcher-registry.js) — main AND renderer derive the
// emulator-source tables from it. The mutual consistency of the tables is checked by
// test/contracts/launcher-tables.test.js; here the registry's own contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
    EMULATOR_REGISTRY, STORE_SOURCE_IDS, GAMES_SOURCE_IDS, DERIVED_RECENT_IDS, launchParamsFor,
} = require('../launcher-registry.js');

const byId = (id) => EMULATOR_REGISTRY.find((e) => e.id === id);

test('every entry is complete, the ids are unique', () => {
    const ids = EMULATOR_REGISTRY.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
    assert.ok(ids.length >= 8);
    for (const e of EMULATOR_REGISTRY) {
        assert.match(e.id, /^[a-z0-9]+$/, `${e.id}: the id is the basis of the <id>-game row type and IPC name`);
        for (const f of ['name', 'chip', 'idField', 'subheadKey']) {
            assert.equal(typeof e[f], 'string', `${e.id}.${f}`);
        }
        assert.match(e.subheadKey, /^games\.\w+Subhead$/);
        assert.ok(Array.isArray(e.launchParams) && e.launchParams.length >= 1, `${e.id}.launchParams`);
        if (e.networkCover) {
            assert.equal(typeof e.networkCover.keyField, 'string', `${e.id}.networkCover.keyField`);
        }
    }
});

test('GAMES_SOURCE_IDS = stores + retro + emulators, unique', () => {
    assert.deepEqual(GAMES_SOURCE_IDS, [...STORE_SOURCE_IDS, 'retro', ...EMULATOR_REGISTRY.map((e) => e.id), 'custom']);
    assert.equal(new Set(GAMES_SOURCE_IDS).size, GAMES_SOURCE_IDS.length);
});

test('DERIVED_RECENT_IDS — Steam/RetroArch + the derivedRecent emulators (the earlier fixed set)', () => {
    assert.deepEqual(
        [...DERIVED_RECENT_IDS].sort(),
        ['duckstation', 'pcsx2', 'ppsspp', 'retroarch', 'rpcs3', 'steam'],
    );
});

test('launchParamsFor — the first field raw, the others || null', () => {
    assert.deepEqual(
        launchParamsFor(byId('melonds'), { path: '/r/a.zip', archiveEntry: 'a.nds', gamecode: '' }),
        { path: '/r/a.zip', archiveEntry: 'a.nds', gamecode: null },
    );
    assert.deepEqual(launchParamsFor(byId('ryujinx'), { path: '/r/x.nsp' }), { path: '/r/x.nsp', titleId: null });
    assert.deepEqual(launchParamsFor(byId('rpcs3'), { titleId: 'BLUS30001', path: '/x' }), { titleId: 'BLUS30001' });
    // A missing first field is NOT normalized to null (the main-side validation rejects it).
    assert.deepEqual(launchParamsFor(byId('pcsx2'), {}), { path: undefined, serial: null });
});

test('in a browser (without module) it writes the globals onto window', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'launcher-registry.js'), 'utf8');
    const window = {};
    vm.runInNewContext(src, { window });
    assert.ok(Array.isArray(window.EMULATOR_REGISTRY));
    assert.equal(window.EMULATOR_REGISTRY.length, EMULATOR_REGISTRY.length);
    assert.equal(typeof window.launchParamsFor, 'function');
});
