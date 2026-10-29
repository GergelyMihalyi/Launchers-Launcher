'use strict';

// lib/gpu-fallback.js — automatic GPU fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempConfigHome } = require('./helpers/fs.js');

const { reset } = useTempConfigHome('gl-gpu-');
const gpu = require('../lib/gpu-fallback.js');

test('gpuSignature — Electron version + the largest mtime of the existing DRI folders', () => {
    const stats = { '/a': { mtimeMs: 100.7 }, '/b': { mtimeMs: 250.2 } };
    const statFn = (p) => { if (!stats[p]) throw new Error('ENOENT'); return stats[p]; };
    assert.equal(gpu.gpuSignature({ electronVersion: '44.4.5', driDirs: ['/a', '/missing', '/b'], statFn }), 'electron 44.4.5 · dri 250');
    assert.equal(gpu.gpuSignature({ electronVersion: '44.4.5', driDirs: ['/missing'], statFn }), 'electron 44.4.5 · dri 0');
});

test('decideGpu — env overrides, same signature → auto-disable, different → delete + retry', () => {
    const stored = { signature: 'S1', status: 'disabled_software' };
    assert.deepEqual(gpu.decideGpu({ stored: null, signature: 'S1' }), { disable: false, reason: null, clear: false });
    assert.deepEqual(gpu.decideGpu({ stored, signature: 'S1' }), { disable: true, reason: 'auto', clear: false });
    assert.deepEqual(gpu.decideGpu({ stored, signature: 'S2' }), { disable: false, reason: null, clear: true });
    assert.deepEqual(gpu.decideGpu({ stored: null, signature: 'S1', env: '1' }), { disable: true, reason: 'env', clear: false });
    assert.deepEqual(gpu.decideGpu({ stored, signature: 'S1', env: '0' }), { disable: false, reason: null, clear: true });
    assert.deepEqual(gpu.decideGpu({ stored: 'junk', signature: 'S1' }), { disable: false, reason: null, clear: false });
});

test('gpuFailed — anything that is not enabled…', () => {
    assert.equal(gpu.gpuFailed('enabled'), false);
    assert.equal(gpu.gpuFailed('enabled_on'), false);
    assert.equal(gpu.gpuFailed('disabled_software'), true);
    assert.equal(gpu.gpuFailed('unavailable_software'), true);
    assert.equal(gpu.gpuFailed(undefined), false);
});

test('record / read / clear — the gpuFallback config key', () => {
    reset();
    assert.equal(gpu.readGpuFallback(), null);
    gpu.recordGpuFallback('S1', 'disabled_software');
    const v = gpu.readGpuFallback();
    assert.equal(v.signature, 'S1');
    assert.equal(v.status, 'disabled_software');
    assert.match(v.at, /^\d{4}-\d{2}-\d{2}T/);
    gpu.clearGpuFallback();
    assert.equal(gpu.readGpuFallback(), null);
    reset();
});

// --- decideAtStartup / checkAfterLoad ---
const { fakeLog } = require('./helpers/ipc.js');

test('decideAtStartup — safe mode / env / auto → OFF + log line; normal → on, silently', () => {
    reset();
    let log = fakeLog();
    assert.deepEqual(gpu.decideAtStartup({ safe: false, electronVersion: '44', env: undefined, log }).disabled, false);
    assert.deepEqual(log.lines, []);
    log = fakeLog();
    const safe = gpu.decideAtStartup({ safe: true, electronVersion: '44', env: undefined, log });
    assert.equal(safe.disabled, true);
    assert.equal(safe.reason, 'safe');
    assert.match(log.lines[0], /safe mode/);
    log = fakeLog();
    assert.equal(gpu.decideAtStartup({ safe: false, electronVersion: '44', env: '1', log }).reason, 'env');
    assert.match(log.lines[0], /LAUNCHERS_LAUNCHER_DISABLE_GPU=1/);
});

test('checkAfterLoad — failed GPU → records it, auto-OFF at the next start; stale signature → deletes it', () => {
    reset();
    const decision = gpu.decideAtStartup({ safe: false, electronVersion: '44', env: undefined, log: fakeLog() });
    assert.equal(gpu.checkAfterLoad({ decision, status: 'enabled', log: fakeLog() }), false);
    const log = fakeLog();
    assert.equal(gpu.checkAfterLoad({ decision, status: 'disabled_software', log }), true);
    assert.match(log.lines[0], /^WARN \[gpu\]/);
    const next = gpu.decideAtStartup({ safe: false, electronVersion: '44', env: undefined, log: fakeLog() });
    assert.deepEqual([next.disabled, next.reason], [true, 'auto']);
    // With the GPU turned OFF there is nothing to check.
    assert.equal(gpu.checkAfterLoad({ decision: next, status: 'disabled_software', log: fakeLog() }), false);
    const upgraded = gpu.decideAtStartup({ safe: false, electronVersion: '45', env: undefined, log: fakeLog() });
    assert.equal(upgraded.disabled, false);
    assert.equal(gpu.readGpuFallback(), null);
});
