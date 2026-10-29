// @ts-check
'use strict';

// Entry point of the worker thread (started by `lib/scan/scan-pool.js` with `new Worker(__filename)`).
// Message: `{ id, source, args }` → reply: `{ id, ok: true, result }` or `{ id, ok: false, error }`. Requests run one after another (the
// worker is a single thread) — the main process is free meanwhile.
//
// `parentPort` only exists in a worker — a plain `require` (e.g. test/contracts/require-smoke.test.js) is a no-op.

const { parentPort, workerData } = require('worker_threads');
const { runScan } = require('./scan-sources.js');
const { enablePersistence } = require('./scan-meta-cache.js');

if (parentPort) {
    // Persisting the per-file metadata cache — the folder comes from `createScanPool({ persistDir })`; without it (tests) memory mode.
    enablePersistence((workerData && workerData.persistDir) || null);
    const port = parentPort;
    port.on('message', (msg) => {
        const { id, source, args } = msg || {};
        try {
            port.postMessage({ id, ok: true, result: runScan(source, args) });
        } catch (err) {
            port.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
        }
    });
}

module.exports = {};
