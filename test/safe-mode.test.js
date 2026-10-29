'use strict';

// lib/safe-mode.js — counting consecutive unfinished startups.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { withTempHome } = require('./helpers/fs.js');
const safeMode = require('../lib/safe-mode.js');

const { nextAttempts, SAFE_THRESHOLD, WINDOW_MS } = safeMode;

test('nextAttempts — first start: not safe, count 1', () => {
    const r = nextAttempts(null, 1000);
    assert.deepEqual(r, { safe: false, reason: null, prevCount: 0, state: { count: 1, firstAt: 1000 } });
});

test('nextAttempts — safe after the threshold number of unfinished starts', () => {
    const r = nextAttempts({ count: SAFE_THRESHOLD, firstAt: 1000 }, 2000);
    assert.equal(r.safe, true);
    assert.equal(r.reason, 'crashes');
    assert.deepEqual(r.state, { count: SAFE_THRESHOLD + 1, firstAt: 1000 });
    assert.equal(nextAttempts({ count: SAFE_THRESHOLD - 1, firstAt: 1000 }, 2000).safe, false);
});

test('nextAttempts — out-of-window / corrupt history is reset', () => {
    assert.equal(nextAttempts({ count: 9, firstAt: 0 }, WINDOW_MS + 1).prevCount, 0);
    assert.equal(nextAttempts({ count: 'x' }, 5).prevCount, 0);
    assert.equal(nextAttempts([], 5).prevCount, 0);
});

test('nextAttempts — LAUNCHERS_LAUNCHER_SAFE=1 forces it', () => {
    const r = nextAttempts(null, 1, { env: { LAUNCHERS_LAUNCHER_SAFE: '1' } });
    assert.equal(r.safe, true);
    assert.equal(r.reason, 'env');
});

test('beginStartup / markHealthy — counts on disk, a healthy start closes it', () => withTempHome(() => {
    const env = {};
    for (let i = 0; i < SAFE_THRESHOLD; i++) assert.equal(safeMode.beginStartup({ now: 100 + i, env }).safe, false);
    assert.equal(safeMode.beginStartup({ now: 200, env }).safe, true);
    safeMode.markHealthy();
    assert.equal(fs.existsSync(safeMode.attemptsPath()), false);
    assert.equal(safeMode.beginStartup({ now: 300, env }).safe, false);
    safeMode.markHealthy();
    safeMode.markHealthy(); // idempotent
}));

test('forceNext — the next start is safe, with its own reason (renderer)', () => withTempHome(() => {
    safeMode.forceNext('renderer', { now: 1000 });
    const r = safeMode.beginStartup({ now: 2000, env: {} });
    assert.equal(r.safe, true);
    assert.equal(r.reason, 'renderer');
    // The safe-mode reason from plain counting stays 'crashes'.
    assert.equal(nextAttempts({ count: SAFE_THRESHOLD, firstAt: 1000 }, 2000).reason, 'crashes');
    // The env override takes precedence.
    assert.equal(nextAttempts({ count: SAFE_THRESHOLD, firstAt: 1000, reason: 'renderer' }, 2000, { env: { LAUNCHERS_LAUNCHER_SAFE: '1' } }).reason, 'env');
    safeMode.markHealthy();
}));

test('createRendererCrashGuard — reloads up to the limit, then gives up; a crash outside the window does not count', () => {
    const { RENDERER_CRASH_LIMIT: limit, RENDERER_CRASH_WINDOW_MS: windowMs } = safeMode;
    const g = safeMode.createRendererCrashGuard();
    for (let i = 1; i < limit; i++) assert.equal(g.record(i), 'reload');
    assert.equal(g.record(limit), 'give-up');

    const g2 = safeMode.createRendererCrashGuard({ limit: 2, windowMs: 100 });
    assert.equal(g2.record(0), 'reload');
    assert.equal(g2.record(150), 'reload'); // the first one has already dropped out of the window
    assert.equal(g2.count(), 1);
    assert.equal(g2.record(200), 'give-up');
    assert.ok(windowMs > 0);
});
