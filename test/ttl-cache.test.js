'use strict';

// lib/ttl-cache.js — TTL-based memoization for the games-library queries.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../lib/ttl-cache.js');

test('createTtlCache — calls once within the TTL window, then recomputes', async () => {
    let calls = 0;
    const cached = createTtlCache((x) => { calls += 1; return x * 2; }, 40);
    assert.equal(cached(3), 6);
    assert.equal(cached(3), 6);
    assert.equal(calls, 1, 'the 2nd call comes from the cache');
    await new Promise((r) => setTimeout(r, 55));
    assert.equal(cached(3), 6);
    assert.equal(calls, 2, 'it recomputes after the TTL expired');
});

test('createTtlCache — a separate key per argument', () => {
    let calls = 0;
    const cached = createTtlCache((x) => { calls += 1; return x; }, 1000);
    cached('a'); cached('b'); cached('a');
    assert.equal(calls, 2);
});

test('createTtlCache — invalidate() clears immediately', () => {
    let calls = 0;
    const cached = createTtlCache(() => { calls += 1; return calls; }, 1000);
    assert.equal(cached(), 1);
    cached.invalidate();
    assert.equal(cached(), 2);
});

test('createTtlCache — does NOT cache a throw', () => {
    let calls = 0;
    const cached = createTtlCache(() => { calls += 1; if (calls < 3) throw new Error('boom'); return 'ok'; }, 1000);
    assert.throws(() => cached());
    assert.throws(() => cached());
    assert.equal(cached(), 'ok');
    assert.equal(calls, 3);
});

test('GAMES_CACHE_TTL_MS — 10 minutes (because of games-warmup)', () => {
    assert.equal(GAMES_CACHE_TTL_MS, 10 * 60000);
});

test('createTtlCache — does NOT cache a rejected Promise for the whole TTL window', async () => {
    let calls = 0;
    const cached = createTtlCache(async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient error');
        return 'ok';
    }, 60000);
    await assert.rejects(cached());
    await assert.rejects(cached());
    assert.equal(await cached(), 'ok');
    assert.equal(calls, 3, 'the failed calls did not stick in the cache until the TTL expired');
});

test('createTtlCache — caches a successful Promise during the TTL window', async () => {
    let calls = 0;
    const cached = createTtlCache(async () => { calls += 1; return calls; }, 1000);
    assert.equal(await cached(), 1);
    assert.equal(await cached(), 1);
    assert.equal(calls, 1, 'the 2nd call comes from the cache, does not call fn again');
});
