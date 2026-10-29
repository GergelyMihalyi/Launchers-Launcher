'use strict';

// lib/recent/games-first-seen.js — "NEW" badge + "recently added".

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGamesFirstSeen, NEW_DAYS, BASELINE_MS } = require('../../lib/recent/games-first-seen.js');

const DAY = 24 * 60 * 60 * 1000;

function setup(startMs = 1_000_000_000_000) {
    const store = {};
    let t = startMs;
    const fs = createGamesFirstSeen({
        get: (k, d) => (k in store ? structuredClone(store[k]) : d),
        set: (k, v) => { store[k] = structuredClone(v); },
    }, () => t);
    return { fs, store, advance: (ms) => { t += ms; }, now: () => t };
}

test('a game seen in the first (baseline) window is not new (0); a later one is, for 7 days', () => {
    const { fs, store, advance } = setup();
    assert.deepEqual(fs.noteSeen(['a', 'b']).newKeys, []);
    assert.deepEqual(store.gamesFirstSeen, { a: 0, b: 0 });
    advance(BASELINE_MS + 1000);
    assert.deepEqual(fs.noteSeen(['a', 'b', 'c']).newKeys, ['c']);
    assert.ok(store.gamesFirstSeen.c > 0);
    advance((NEW_DAYS - 1) * DAY);
    assert.deepEqual(fs.noteSeen(['c']).newKeys, ['c']);
    advance(2 * DAY);
    assert.deepEqual(fs.noteSeen(['c']).newKeys, []); // the 7 days have passed
});

test('a launched game is no longer new (usage.count > 0)', () => {
    const { fs, advance } = setup();
    fs.noteSeen(['a']);
    advance(BASELINE_MS + 1000);
    assert.deepEqual(fs.noteSeen(['x'], {}).newKeys, ['x']);
    assert.deepEqual(fs.noteSeen(['x'], { x: { count: 1 } }).newKeys, []);
});

test('invalid keys are dropped; the registry is size-limited (the oldest ts > 0 drops out)', () => {
    const { fs, store, advance } = setup();
    fs.noteSeen(['base']);
    advance(BASELINE_MS + 1000);
    fs.noteSeen(['', 5, null, 'ok']);
    assert.deepEqual(Object.keys(store.gamesFirstSeen).sort(), ['base', 'ok']);
    const many = Array.from({ length: 5100 }, (_, i) => `k${i}`);
    for (let i = 0; i < many.length; i += 500) { advance(1000); fs.noteSeen(many.slice(i, i + 500)); }
    assert.ok(Object.keys(store.gamesFirstSeen).length <= 5000);
    assert.equal(store.gamesFirstSeen.base, 0); // the baseline (0) entry stays
});
