'use strict';

// renderer/games-panel/games-panel-search.js — pure helpers of the live search.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SEARCH_MIN_CHARS, normalizeSearchText, searchTokens, searchCharCount, isSearchActive,
    searchRows, pushRecentQuery,
} = require('../../renderer/games-panel/games-panel-search.js');

// --- Live search ---

test('normalizeSearchText — lowercase, accent stripping, punctuation -> space, collapsed spaces', () => {
    assert.equal(normalizeSearchText('Zelda: Link\'s Awakening (USA)'), 'zelda link s awakening usa');
    assert.equal(normalizeSearchText('  Pokémon   ÖKÖR-űr  '), 'pokemon okor ur');
    assert.equal(normalizeSearchText(null), '');
    assert.equal(normalizeSearchText('!!!'), '');
});

test('searchTokens / searchCharCount / isSearchActive — the threshold applies to normalized characters without spaces', () => {
    assert.deepEqual(searchTokens('Mario  Kart'), ['mario', 'kart']);
    assert.deepEqual(searchTokens(''), []);
    assert.equal(SEARCH_MIN_CHARS, 3);
    assert.equal(searchCharCount('a b'), 2);
    assert.equal(isSearchActive('ma'), false);
    assert.equal(isSearchActive('a b'), false); // spaces do not count
    assert.equal(isSearchActive('mar'), true);
    assert.equal(isSearchActive('!!!'), false); // punctuation only
    assert.equal(isSearchActive(null), false);
});

const ROWS = ['Super Mario World', 'Mario Kart 8', 'Primary', 'Smart Ball', 'Zelda: Link\'s Awakening', 'Pokémon Red', 'Mega Man 2', 'F-Zero']
    .map((name) => ({ name }));

test('searchRows — for an inactive search (< 3 characters) the input itself', () => {
    assert.equal(searchRows(ROWS, 'ma'), ROWS);
    assert.equal(searchRows(ROWS, ''), ROWS);
});

test('searchRows — word-start matches first, inner-word matches after; the order is kept on both levels', () => {
    const out = searchRows(ROWS, 'mar').map((r) => r.name);
    assert.deepEqual(out, ['Super Mario World', 'Mario Kart 8', 'Primary', 'Smart Ball']);
    // "Mario Kart 8" (word start) comes before "Primary"/"Smart Ball", by original order
    const idx = (n) => out.indexOf(n);
    assert.ok(idx('Mario Kart 8') < idx('Primary'));
});

test('searchRows — every token must match, regardless of order', () => {
    assert.deepEqual(searchRows(ROWS, 'kart mario').map((r) => r.name), ['Mario Kart 8']);
    assert.deepEqual(searchRows(ROWS, 'mario zelda'), []);
});

test('searchRows — accent- and case-insensitive, punctuation does not matter', () => {
    assert.deepEqual(searchRows(ROWS, 'POKEMON').map((r) => r.name), ['Pokémon Red']);
    assert.deepEqual(searchRows(ROWS, 'pokémon').map((r) => r.name), ['Pokémon Red']);
    assert.deepEqual(searchRows(ROWS, 'link s awake').map((r) => r.name), ['Zelda: Link\'s Awakening']);
});

test('searchRows — typing without spaces also finds a title with spaces/hyphens ("megaman", "fzero")', () => {
    assert.deepEqual(searchRows(ROWS, 'megaman').map((r) => r.name), ['Mega Man 2']);
    assert.deepEqual(searchRows(ROWS, 'fzero').map((r) => r.name), ['F-Zero']);
});

test('searchRows — nameOf for the non-`.name` fields; the key is cached on the object, the spread copy carries it too', () => {
    const games = [{ label: 'Zelda' }, { label: 'Metroid' }];
    assert.deepEqual(searchRows(games, 'zel', (g) => g.label), [games[0]]);
    assert.equal(typeof games[0]._sk, 'string');
    const copy = { ...games[0] };
    assert.equal(copy._sk, games[0]._sk);
});

test('searchRows — no match -> empty array; does not modify the input (order/length)', () => {
    const before = ROWS.map((r) => r.name);
    assert.deepEqual(searchRows(ROWS, 'missingilyencim'), []);
    assert.deepEqual(ROWS.map((r) => r.name), before);
});

test('searchRows — one filtering of a RetroArch-sized list (16 000 items) is fast', () => {
    const big = Array.from({ length: 16000 }, (_, i) => ({ name: `Game ${i} Mario ${i % 7} (USA)` }));
    const t0 = process.hrtime.bigint();
    const out = searchRows(big, 'mario 3');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(out.length > 0);
    assert.ok(ms < 500, `too slow: ${ms} ms`); // a very loose gate (the real measurement is ~1 ms), only a regression guard
});

test('searchRows — abbreviation (the initials of the words) at the end of the list, only for a one-word search', () => {
    const rows = ['Final Fantasy X', 'Ffx Tools', 'The Legend of Zelda', 'Grand Theft Auto V'].map((name) => ({ name }));
    assert.deepEqual(searchRows(rows, 'ffx').map((r) => r.name), ['Ffx Tools', 'Final Fantasy X']);
    assert.deepEqual(searchRows(rows, 'gta').map((r) => r.name), ['Grand Theft Auto V']);
    assert.deepEqual(searchRows(rows, 'tloz').map((r) => r.name), ['The Legend of Zelda']);
    assert.deepEqual(searchRows(rows, 'ffx zzz'), []);
});

test('pushRecentQuery — newest first, without duplicates (accent/case), capped; an inactive one is not added', () => {
    let l = [];
    l = pushRecentQuery(l, 'zelda', 3);
    l = pushRecentQuery(l, 'pokémon', 3);
    l = pushRecentQuery(l, 'ZELDA', 3);
    assert.deepEqual(l, ['ZELDA', 'pokémon']);
    l = pushRecentQuery(l, 'mario', 3);
    l = pushRecentQuery(l, 'kart', 3);
    assert.deepEqual(l, ['kart', 'mario', 'ZELDA']);
    assert.equal(pushRecentQuery(l, 'ab', 3), l);
});
