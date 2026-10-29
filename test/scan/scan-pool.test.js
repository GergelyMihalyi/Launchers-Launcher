'use strict';

// lib/scan/scan-pool.js + lib/scan/scan-worker.js + lib/scan/scan-sources.js — the heavy library scans in a
// worker thread. A real `worker_threads` Worker (with an empty temp config root), plus a fake Worker
// for the error/fallback branches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir } = require('../helpers/fs.js');
const { EventEmitter } = require('events');
const { createScanPool, MAX_RESPAWNS } = require('../../lib/scan/scan-pool.js');
const { SCAN_SOURCES, runScan } = require('../../lib/scan/scan-sources.js');

test('SCAN_SOURCES — the 4 heavy sources are functions', () => {
    for (const id of ['melonds', 'ppsspp', 'duckstation', 'retroAll']) {
        assert.equal(typeof SCAN_SOURCES[id], 'function', id);
    }
    assert.throws(() => runScan('no-such', []), /unknown scan source/);
});

test('real worker — empty config root → empty list, unknown source → rejection', async () => {
    const pool = createScanPool();
    try {
        const dir = tmpDir();
        assert.deepEqual(await pool.scan('ppsspp', [dir]), []);
        assert.deepEqual(await pool.scan('duckstation', [dir]), []);
        assert.deepEqual(await pool.scan('melonds', [dir, []]), []);
        // the emulators walking ROM folders run in the worker too
        assert.deepEqual(await pool.scan('pcsx2', [dir]), []);
        assert.deepEqual(await pool.scan('dolphin', [dir, dir]), []);
        assert.deepEqual(await pool.scan('cemu', [dir, dir]), []);
        assert.deepEqual(await pool.scan('ryujinx', [dir]), []);
        await assert.rejects(pool.scan('no-such', []), /unknown scan source/);
        assert.equal(pool.isInProcess(), false);
    } finally {
        pool.terminate();
    }
});

test('real worker — concurrent requests are all answered (id pairing)', async () => {
    const pool = createScanPool();
    try {
        const dir = tmpDir();
        const results = await Promise.all([
            pool.scan('ppsspp', [dir]), pool.scan('duckstation', [dir]), pool.scan('retroAll', [dir]),
        ]);
        assert.equal(results.length, 3);
        for (const r of results) assert.ok(Array.isArray(r));
    } finally {
        pool.terminate();
    }
});

class FakeWorker extends EventEmitter {
    constructor() { super(); FakeWorker.instances.push(this); this.posted = []; }
    postMessage(msg) { this.posted.push(msg); }
    unref() {}
    terminate() { this.terminated = true; }
}
FakeWorker.instances = [];

// A stuck (never answering) worker must not leave a request pending forever.
test('timeout → the pending AND the queued request behind it both end with an error, the worker stops, the next one gets a new one', async () => {
    FakeWorker.instances = [];
    const logs = [];
    const pool = createScanPool({ WorkerCtor: FakeWorker, jobTimeoutMs: 20, log: (m) => logs.push(m) });
    const stuck = pool.scan('melonds', ['/nfs']);
    const queued = pool.scan('ppsspp', ['/x']);
    // the pool's timer is `unref`-ed (it does not keep the process alive) — a ref-ed one holds it for the test
    const keepAlive = setTimeout(() => {}, 5000);
    try {
        await assert.rejects(stuck, /timeout \(melonds/);
        await assert.rejects(queued, /timeout/);
    } finally {
        clearTimeout(keepAlive);
    }
    assert.equal(FakeWorker.instances[0].terminated, true);
    assert.match(logs.join('\n'), /timeout/);
    const p = pool.scan('ppsspp', ['/x']);
    assert.equal(FakeWorker.instances.length, 2);
    const w = FakeWorker.instances[1];
    w.emit('message', { id: w.posted[0].id, ok: true, result: ['ok'] });
    assert.deepEqual(await p, ['ok']);
});

test('worker exit → the pending request is rejected, the next scan starts a new worker', async () => {
    FakeWorker.instances = [];
    const pool = createScanPool({ WorkerCtor: FakeWorker });
    const p = pool.scan('ppsspp', ['/x']);
    FakeWorker.instances[0].emit('exit', 1);
    await assert.rejects(p, /stopped/);
    const p2 = pool.scan('ppsspp', ['/x']);
    assert.equal(FakeWorker.instances.length, 2);
    const w = FakeWorker.instances[1];
    w.emit('message', { id: w.posted[0].id, ok: true, result: [1, 2] });
    assert.deepEqual(await p2, [1, 2]);
});

// After repeated worker errors NO synchronous (main-process) run,
// but a pause (requests fail at once), then a fresh worker attempt.
test(`pauses after ${MAX_RESPAWNS} consecutive worker failures (no sync fallback), then tries again`, async () => {
    FakeWorker.instances = [];
    let t = 1000;
    const pool = createScanPool({ WorkerCtor: FakeWorker, cooldownMs: 500, now: () => t });
    for (let i = 0; i < MAX_RESPAWNS; i++) {
        const p = pool.scan('ppsspp', ['/x']);
        FakeWorker.instances[i].emit('error', new Error('boom'));
        await assert.rejects(p);
    }
    assert.equal(pool.isInProcess(), false);
    await assert.rejects(pool.scan('ppsspp', [tmpDir()]), /paused/);
    assert.equal(FakeWorker.instances.length, MAX_RESPAWNS, 'no worker starts during the pause');
    t += 501;
    const p = pool.scan('ppsspp', ['/x']);
    assert.equal(FakeWorker.instances.length, MAX_RESPAWNS + 1, 'a fresh worker after the pause');
    const w = FakeWorker.instances[MAX_RESPAWNS];
    w.emit('message', { id: w.posted[0].id, ok: true, result: [] });
    assert.deepEqual(await p, []);
});

test('the Worker cannot be created → immediately in-process', async () => {
    const pool = createScanPool({ WorkerCtor: function Broken() { throw new Error('no worker'); } });
    assert.deepEqual(await pool.scan('duckstation', [tmpDir()]), []);
    assert.equal(pool.isInProcess(), true);
});
