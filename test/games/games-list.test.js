'use strict';

// lib/games/games-list.js — the Steam+Heroic+Lutris merge of the "Games" panel. Pure function;
// the per-`source` id shape + the locale-aware sorting are what matters.

const test = require('node:test');
const assert = require('node:assert/strict');
const { combineGamesList } = require('../../lib/games/games-list.js');

test('combineGamesList — all three sources with their own shape, with a source tag', () => {
    const out = combineGamesList(
        [{ appid: '123', name: 'Alpha', cover: '/c/a.jpg' }],
        [{ runner: 'gog', appName: 'app1', name: 'Beta', cover: null }],
        [{ id: 42, name: 'Gamma' }],
    );
    assert.deepEqual(out, [
        { id: 'steam:123', appid: '123', name: 'Alpha', source: 'steam', cover: '/c/a.jpg' },
        { id: 'heroic:gog:app1', appName: 'app1', name: 'Beta', source: 'gog', cover: null },
        { id: 'lutris:42', lutrisId: 42, name: 'Gamma', source: 'lutris', cover: null },
    ]);
});

test('combineGamesList — sorts by Hungarian locale, accent-sensitively', () => {
    const out = combineGamesList(
        [{ appid: '1', name: 'Zorro' }],
        [{ runner: 'gog', appName: 'a', name: 'Álom' }],
        [{ id: 1, name: 'Béka' }],
    );
    assert.deepEqual(out.map((g) => g.name), ['Álom', 'Béka', 'Zorro']);
});

test('combineGamesList — missing cover -> null', () => {
    const out = combineGamesList([{ appid: '1', name: 'X' }], [], []);
    assert.equal(out[0].cover, null);
});

test('combineGamesList — an empty/missing source list does not throw', () => {
    assert.deepEqual(combineGamesList([], [], []), []);
    assert.deepEqual(combineGamesList(null, undefined, []), []);
});
