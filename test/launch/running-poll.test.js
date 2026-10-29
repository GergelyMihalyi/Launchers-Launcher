'use strict';

// lib/launch/running-poll.js — the "is it running yet" poller's state machine. The actual
// `lib/launch/running.js` discovery does NOT belong here (see test/launch/running.test.js) —
// only the Set-change detection + the "push only when it really changed" rule, and the
// start/stop timer handling.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunningPoll } = require('../../lib/launch/running-poll.js');

function fakeDeps({ sequence = [[]] } = {}) {
    const sent = [];
    const logs = [];
    let call = 0;
    return {
        sent, logs,
        running: {
            detectRunningLaunchers: async () => {
                const ids = sequence[Math.min(call, sequence.length - 1)];
                call += 1;
                return new Map(ids.map((id) => [id, { pid: 1 }]));
            },
        },
        homeDir: '/home/fake',
        getLaunchers: () => [{ id: 'a' }, { id: 'b' }],
        log: (msg) => logs.push(msg),
        sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
        launchersPayload: () => 'PAYLOAD',
    };
}

test('refresh() — from empty to empty (no change): does not push', async () => {
    const deps = fakeDeps({ sequence: [[]] });
    const poll = createRunningPoll(deps);
    await poll.refresh();
    assert.equal(deps.sent.length, 0);
    assert.deepEqual(poll.getRunningIds(), new Set());
});

test('refresh() — the Set actually changes: pushes running-changed with launchersPayload()', async () => {
    const deps = fakeDeps({ sequence: [[], ['a']] });
    const poll = createRunningPoll(deps);
    await poll.refresh();
    await poll.refresh();
    assert.deepEqual([...poll.getRunningIds()], ['a']);
    assert.deepEqual(deps.sent, [{ channel: 'running-changed', payload: 'PAYLOAD' }]);
});

test('refresh() — the same Set (in a different order) does NOT count as a change', async () => {
    const deps = fakeDeps({ sequence: [['a', 'b'], ['b', 'a']] });
    const poll = createRunningPoll(deps);
    await poll.refresh();
    await poll.refresh();
    assert.equal(deps.sent.length, 1); // only the first (from empty to ['a','b']) counts as a change
});

test('refresh({push:false}) — updates the Set, but sends no push', async () => {
    const deps = fakeDeps({ sequence: [['a']] });
    const poll = createRunningPoll(deps);
    await poll.refresh({ push: false });
    assert.deepEqual([...poll.getRunningIds()], ['a']);
    assert.equal(deps.sent.length, 0);
});

test('failure of detectRunningLaunchers: logs, does not throw, the Set stays unchanged', async () => {
    const deps = fakeDeps();
    deps.running.detectRunningLaunchers = async () => { throw new Error('boom'); };
    const poll = createRunningPoll(deps);
    await assert.doesNotReject(() => poll.refresh());
    assert.ok(deps.logs.some((l) => l.includes('boom')));
    assert.deepEqual(poll.getRunningIds(), new Set());
});

test('start()/stop() — immediate refresh + timed repeat, no more calls after stop()', async () => {
    const deps = fakeDeps({ sequence: [[], ['a'], ['a', 'b'], ['a', 'b', 'never']] });
    const poll = createRunningPoll({ ...deps, pollMs: 15 });
    poll.start();
    await new Promise((r) => setTimeout(r, 50)); // a few poll cycles' worth of time
    poll.stop();
    const idsAtStop = [...poll.getRunningIds()];
    await new Promise((r) => setTimeout(r, 40)); // no further change after stop()
    assert.deepEqual([...poll.getRunningIds()], idsAtStop);
});

test('start() called twice does not start two timers — the second does not run another immediate refresh()', async () => {
    let calls = 0;
    const deps = fakeDeps();
    deps.running.detectRunningLaunchers = async () => { calls += 1; return new Map(); };
    const poll = createRunningPoll({ ...deps, pollMs: 100000 }); // the interval must not run during the test
    poll.start();
    poll.start(); // no-op, because `timer` is already set
    await new Promise((r) => setTimeout(r, 10));
    poll.stop();
    assert.equal(calls, 1);
});
