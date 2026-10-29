'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGamesWarmup } = require('../../lib/games/games-warmup.js');

// Instant "sleep", so the tests do not wait real time; the requested pauses are recorded.
function fastSleep(record) {
    return (ms) => { record.push(ms); return Promise.resolve(); };
}

test('createGamesWarmup — the sync steps run in the given order, with a pause between them', async () => {
    const order = [];
    const sleeps = [];
    const w = createGamesWarmup({
        steps: [
            { id: 'a', run: () => order.push('a') },
            { id: 'b', run: () => order.push('b') },
            { id: 'c', run: () => order.push('c') },
        ],
        gapMs: 25,
        sleep: fastSleep(sleeps),
    });
    await w.run('startup');
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.deepEqual(sleeps, [25, 25], '1 pause between each two steps, none before the first and after the last');
});

test('createGamesWarmup — the async step starts FIRST, but it is awaited at the end', async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const w = createGamesWarmup({
        steps: [
            { id: 'sync1', run: () => order.push('sync1') },
            { id: 'lutris', async: true, run: async () => { order.push('lutris-start'); await gate; order.push('lutris-end'); } },
            { id: 'sync2', run: () => order.push('sync2') },
        ],
        sleep: fastSleep([]),
    });
    const p = w.run();
    // The synchronous steps run to completion before the asynchronous one settles.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ['lutris-start', 'sync1', 'sync2']);
    assert.equal(w.getState().running, true, 'the async step is still running');
    release();
    await p;
    assert.deepEqual(order, ['lutris-start', 'sync1', 'sync2', 'lutris-end']);
    assert.equal(w.getState().running, false);
});

test('createGamesWarmup — the failure of one step (sync throw / rejected Promise) does not stop the others', async () => {
    const order = [];
    const logs = [];
    const w = createGamesWarmup({
        steps: [
            { id: 'bad-sync', run: () => { throw new Error('sync'); } },
            { id: 'bad-async', async: true, run: async () => { throw new Error('async'); } },
            { id: 'ok', run: () => order.push('ok') },
        ],
        log: (m) => logs.push(m),
        sleep: fastSleep([]),
    });
    await w.run();
    assert.deepEqual(order, ['ok']);
    assert.ok(logs.some((l) => l.includes('bad-sync error: sync')));
    assert.ok(logs.some((l) => l.includes('bad-async error: async')));
    assert.deepEqual(w.getState(), { running: false, done: 3, total: 3 }, 'the failed steps count as "done" too');
});

test('createGamesWarmup — with invalidate:true the step runs as an invalidate() → run() pair', async () => {
    const calls = [];
    const w = createGamesWarmup({
        steps: [
            { id: 'a', invalidate: () => calls.push('inv-a'), run: () => calls.push('run-a') },
            { id: 'b', invalidate: () => calls.push('inv-b'), run: () => calls.push('run-b') },
        ],
        sleep: fastSleep([]),
    });
    await w.run('return', { invalidate: true });
    assert.deepEqual(calls, ['inv-a', 'run-a', 'inv-b', 'run-b'], 'there is no point where every cache is empty at once');
});

test('createGamesWarmup — without invalidate, invalidate() is not called', async () => {
    let invalidated = 0;
    const w = createGamesWarmup({
        steps: [{ id: 'a', invalidate: () => { invalidated += 1; }, run: () => {} }],
        sleep: fastSleep([]),
    });
    await w.run('startup');
    assert.equal(invalidated, 0);
});

test('createGamesWarmup — no parallel run starts while running (it gets the same Promise)', async () => {
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const w = createGamesWarmup({
        steps: [{ id: 'slow', run: async () => { runs += 1; await gate; } }],
        sleep: fastSleep([]),
    });
    const p1 = w.run('a');
    const p2 = w.run('b');
    assert.equal(p1, p2);
    release();
    await p1;
    assert.equal(runs, 1);
});

test('createGamesWarmup — an invalidate:true request during a run books a catch-up round', async () => {
    let runs = 0;
    const invalidations = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const w = createGamesWarmup({
        steps: [{
            id: 'a',
            invalidate: () => invalidations.push(true),
            run: async () => { runs += 1; if (runs === 1) await gate; },
        }],
        sleep: fastSleep([]),
    });
    const p = w.run('startup');
    w.run('return', { invalidate: true });
    release();
    await p;
    assert.equal(runs, 2, 'the first round + a catch-up round');
    assert.equal(invalidations.length, 1, 'the catch-up round invalidates, the first (without invalidate) does not');
});

test('createGamesWarmup — the state reports: start, done++ per step, end', async () => {
    const states = [];
    const w = createGamesWarmup({
        steps: [{ id: 'a', run: () => {} }, { id: 'b', run: () => {} }],
        onState: (s) => states.push(s),
        sleep: fastSleep([]),
    });
    assert.deepEqual(w.getState(), { running: false, done: 0, total: 2 });
    await w.run();
    assert.deepEqual(states, [
        { running: true, done: 0, total: 2 },
        { running: true, done: 1, total: 2 },
        { running: true, done: 2, total: 2 },
        { running: false, done: 2, total: 2 },
    ]);
});

test('createGamesWarmup — an onState that throws does not stop the warmup', async () => {
    const order = [];
    const w = createGamesWarmup({
        steps: [{ id: 'a', run: () => order.push('a') }, { id: 'b', run: () => order.push('b') }],
        onState: () => { throw new Error('push error'); },
        sleep: fastSleep([]),
    });
    await w.run();
    assert.deepEqual(order, ['a', 'b']);
});

test('createGamesWarmup — the log line contains the reason and the per-step time', async () => {
    const logs = [];
    let t = 0;
    const w = createGamesWarmup({
        steps: [{ id: 'steam', run: () => {} }],
        log: (m) => logs.push(m),
        now: () => (t += 10),
        sleep: fastSleep([]),
    });
    await w.run('startup');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[warmup\] startup: steam \d+ms — total \d+ms$/);
});

test('createGamesWarmup — an empty step list finishes too', async () => {
    const w = createGamesWarmup({ steps: [], sleep: fastSleep([]) });
    await w.run();
    assert.deepEqual(w.getState(), { running: false, done: 0, total: 0 });
});

test('createGamesWarmup — rejects a step without `run` at construction time', () => {
    assert.throws(() => createGamesWarmup({ steps: [{ id: 'x', load: () => {} }] }), /invalid step \(x\)/);
    assert.throws(() => createGamesWarmup({ steps: [{ run: () => {} }] }), /invalid step/);
});

test('createGamesWarmup — targeted invalidate (id list): only the cache of the given steps is cleared, but every step runs', async () => {
    const events = [];
    const step = (id) => ({ id, run: () => events.push(`run:${id}`), invalidate: () => events.push(`inv:${id}`) });
    const w = createGamesWarmup({ steps: [step('steam'), step('cemu'), step('melonds')], sleep: fastSleep([]) });
    await w.run('return', { invalidate: ['steam', 'melonds'] });
    assert.deepEqual(events, ['inv:steam', 'run:steam', 'run:cemu', 'inv:melonds', 'run:melonds']);
});

test('createGamesWarmup — targeted requests during a run add up in the catch-up round; `true` swallows everything', async () => {
    const invalidated = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    let first = true;
    const w = createGamesWarmup({
        steps: [
            { id: 'a', run: async () => { if (first) { first = false; await gate; } }, invalidate: () => invalidated.push('a') },
            { id: 'b', run: () => {}, invalidate: () => invalidated.push('b') },
            { id: 'c', run: () => {}, invalidate: () => invalidated.push('c') },
        ],
        sleep: fastSleep([]),
    });
    const p = w.run('startup');
    w.run('return', { invalidate: ['a'] });
    w.run('return', { invalidate: new Set(['c']) });
    release();
    await p;
    assert.deepEqual(invalidated.sort(), ['a', 'c'], 'the catch-up round invalidates the a+c union, not b');

    invalidated.length = 0;
    first = true;
    let release2;
    const gate2 = new Promise((r) => { release2 = r; });
    const w2 = createGamesWarmup({
        steps: [
            { id: 'a', run: async () => { if (first) { first = false; await gate2; } }, invalidate: () => invalidated.push('a') },
            { id: 'b', run: () => {}, invalidate: () => invalidated.push('b') },
        ],
        sleep: fastSleep([]),
    });
    const p2 = w2.run('startup');
    w2.run('return', { invalidate: ['a'] });
    w2.run('manual', { invalidate: true });
    release2();
    await p2;
    assert.deepEqual(invalidated.sort(), ['a', 'b'], '`true` (manual refresh) invalidates every step');
});

test('createGamesWarmup — an empty id list does not book a catch-up round', async () => {
    let runs = 0;
    const w = createGamesWarmup({ steps: [{ id: 'a', run: () => { runs += 1; } }], sleep: fastSleep([]) });
    await w.run('return', { invalidate: [] });
    assert.equal(runs, 1);
});

// A step that never settles must not hold up the end of the warmup.
test('createGamesWarmup — a stuck (never fulfilling) step is closed with a timeout, the others run', async () => {
    const ran = [];
    const logs = [];
    const w = createGamesWarmup({
        steps: [
            { id: 'stuck', run: () => new Promise(() => {}), async: true },
            { id: 'b', run: () => { ran.push('b'); } },
        ],
        log: (m) => logs.push(m),
        sleep: async () => {},
        stepTimeoutMs: 20,
    });
    await w.run('test');
    assert.deepEqual(ran, ['b']);
    assert.match(logs.join('\n'), /stuck error: \[warmup\] stuck timeout/);
    assert.equal(w.getState().running, false);
});
