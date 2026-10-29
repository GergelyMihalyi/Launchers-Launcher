'use strict';

// lib/recent/recent-games.js — pure helper of the per-launcher "recently launched games" MRU list.
// The carousel shows at most 3 items of it under the focused launcher card.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pushRecentGame, MAX_RECENT, buildRecentEntries } = require('../../lib/recent/recent-games.js');

const g = (key, name) => ({ key, name, kind: 'steam', params: {}, lastLaunchedAt: '2026-09-07T00:00:00Z' });

test('pushRecentGame — the new item goes to the start of the list', () => {
    const out = pushRecentGame([g('a', 'A'), g('b', 'B')], g('c', 'C'));
    assert.deepEqual(out.map((e) => e.key), ['c', 'a', 'b']);
});

test('pushRecentGame — dedups on `key` (the old instance drops out, the fresh one goes first)', () => {
    const out = pushRecentGame([g('a', 'A'), g('b', 'B'), g('c', 'C')], g('b', 'B again'));
    assert.deepEqual(out.map((e) => e.key), ['b', 'a', 'c']);
    assert.equal(out[0].name, 'B again');
});

test('pushRecentGame — the list is cut to MAX_RECENT', () => {
    let list = [];
    for (let i = 0; i < MAX_RECENT + 3; i++) list = pushRecentGame(list, g(`k${i}`, `K${i}`));
    assert.equal(list.length, MAX_RECENT);
    assert.equal(list[0].key, `k${MAX_RECENT + 2}`); // the latest launch first
});

test('pushRecentGame — missing/bad list -> returns an array, an entry without `key` -> unchanged (cut) list', () => {
    assert.deepEqual(pushRecentGame(undefined, g('a', 'A')).map((e) => e.key), ['a']);
    assert.deepEqual(pushRecentGame(null, null), []);
    assert.deepEqual(pushRecentGame([g('a', 'A')], { name: 'no key' }).map((e) => e.key), ['a']);
});

test('pushRecentGame — custom `max` override', () => {
    const out = pushRecentGame([g('a'), g('b'), g('c')], g('d'), 2);
    assert.deepEqual(out.map((e) => e.key), ['d', 'a']);
});

// buildRecentEntries — the shared core of the "recently played" list building repeated in 6 launcher
// modules (steam/pcsx2/rpcs3/duckstation/ppsspp/lutris).
// Critical: it ALWAYS gives an ISO 8601 string as `lastLaunchedAt` (it does the `msToLaunchedAt`
// conversion itself) — this structurally rules out the production bug where the raw ms-epoch
// number gave NaN in `Date.parse()` for some callers.
test('buildRecentEntries — filter(timestamp>0) → sort desc → slice(max) → recentGames shape', () => {
    const games = [
        { id: 1, name: 'Never played', ts: 0, cover: null },
        { id: 2, name: 'Old', ts: 1000, cover: null },
        { id: 3, name: 'New', ts: 3000, cover: '/c/uj.jpg' },
        { id: 4, name: 'Medium', ts: 2000, cover: null },
    ];
    const recent = buildRecentEntries(games, {
        timeMs: (g_) => g_.ts,
        max: 2,
        key: (g_) => `test-game-${g_.id}`,
        kind: 'test',
        params: (g_) => ({ id: g_.id }),
    });
    assert.deepEqual(recent.map((e) => e.key), ['test-game-3', 'test-game-4']);
    assert.deepEqual(recent[0], {
        key: 'test-game-3', name: 'New', cover: '/c/uj.jpg', kind: 'test',
        params: { id: 3 }, lastLaunchedAt: new Date(3000).toISOString(),
    });
    // "Never played" (ts=0) never gets in, and "Old" drops out at the max:2 cut
    assert.equal(recent.some((e) => e.key === 'test-game-1'), false);
    assert.equal(recent.some((e) => e.key === 'test-game-2'), false);
});

test('buildRecentEntries — lastLaunchedAt is ALWAYS a valid ISO 8601 string (Date.parse does not give NaN)', () => {
    const recent = buildRecentEntries([{ id: 1, ts: 1700000000000 }], {
        timeMs: (g_) => g_.ts, key: (g_) => `k${g_.id}`, kind: 'x', params: () => ({}),
    });
    assert.equal(recent[0].lastLaunchedAt, new Date(1700000000000).toISOString());
    assert.equal(Number.isNaN(Date.parse(recent[0].lastLaunchedAt)), false);
});

test('buildRecentEntries — missing cover -> null; missing/bad games -> empty list, does not throw', () => {
    const recent = buildRecentEntries([{ id: 1, ts: 5000 }], {
        timeMs: (g_) => g_.ts, key: (g_) => `k${g_.id}`, kind: 'x', params: () => ({}),
    });
    assert.equal(recent[0].cover, null);
    assert.deepEqual(buildRecentEntries(undefined, { timeMs: () => 1, key: () => 'k', kind: 'x', params: () => ({}) }), []);
    assert.deepEqual(buildRecentEntries(null, { timeMs: () => 1, key: () => 'k', kind: 'x', params: () => ({}) }), []);
});

test('buildRecentEntries — the unit conversion (e.g. the seconds of Steam LastPlayed) is the caller\'s responsibility through timeMs', () => {
    const seconds = 2000;
    const recent = buildRecentEntries([{ id: 1, lastPlayedSeconds: seconds }], {
        timeMs: (g_) => g_.lastPlayedSeconds * 1000, key: () => 'steam-game-1', kind: 'steam', params: () => ({ appid: '1' }),
    });
    assert.equal(recent[0].lastLaunchedAt, new Date(seconds * 1000).toISOString());
});
