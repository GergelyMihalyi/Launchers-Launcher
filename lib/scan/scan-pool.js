// @ts-check
'use strict';

// Main-side gate for the heavy library scans: one long-lived worker thread (`scan-worker.js`), `scan(source, args)` returns a Promise —
// the main process does NOT block during the scan. The worker starts lazily and is `unref()`-ed. Error/unexpected exit → pending requests
// are rejected, the next `scan()` starts a new worker; after `MAX_RESPAWNS` consecutive errors it fails IMMEDIATELY for
// `SCAN_WORKER_COOLDOWN_MS` (DELIBERATELY no synchronous main-process fallback: a stuck NFS scan would freeze the UI for minutes;
// in-process only if the `Worker` itself cannot be created). Per-request timeout (`SCAN_JOB_TIMEOUT_MS`): on expiry the worker is
// `terminate()`-d, otherwise the TTL cache would hold a forever-pending Promise. The cache is NOT here: the caller wraps it in
// `createTtlCache`. Background: docs/dev/infrastructure.md#worker-thread-scans

const path = require('path');
const { runScan } = require('./scan-sources.js');
const { enablePersistence } = require('./scan-meta-cache.js');
const { SCAN_JOB_TIMEOUT_MS, SCAN_WORKER_COOLDOWN_MS } = require('../timings.js');

const MAX_RESPAWNS = 3;

/**
 * @param {Object} [deps]
 * @param {import('../types.js').Logger} [deps.log]
 * @param {string} [deps.workerPath]           overridable for tests
 * @param {any} [deps.WorkerCtor]              overridable for tests (`worker_threads.Worker`-shaped)
 * @param {string | null} [deps.persistDir]    disk folder of the per-file metadata cache (`lib/scan/scan-meta-cache.js`)
 *   — `null`/missing → memory only (tests must NOT write the machine's real cache)
 * @param {number} [deps.jobTimeoutMs]         upper bound of one request (overridable for tests)
 * @param {number} [deps.cooldownMs]           pause after `MAX_RESPAWNS` errors (overridable for tests)
 * @param {() => number} [deps.now]            monotonic clock (overridable for tests)
 */
function createScanPool({
    log = () => {}, workerPath = path.join(__dirname, 'scan-worker.js'), WorkerCtor, persistDir = null,
    jobTimeoutMs = SCAN_JOB_TIMEOUT_MS, cooldownMs = SCAN_WORKER_COOLDOWN_MS,
    now = () => performance.now(),
} = {}) {
    /** @type {any} */
    let worker = null;
    let nextId = 1;
    let failures = 0;
    let inProcess = false;
    let cooldownUntil = 0;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any }>} */
    const pending = new Map();

    /** @param {Error} err */
    function failAll(err) {
        for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        pending.clear();
    }

    /** @param {string} reason */
    function dropWorker(reason) {
        worker = null;
        failures++;
        const pause = failures >= MAX_RESPAWNS;
        log(`[scan-pool] worker stopped (${reason})${pause ? ` — ${Math.round(cooldownMs / 1000)} s pause, then a new attempt` : ''}`);
        if (pause) {
            cooldownUntil = now() + cooldownMs;
            failures = 0;
        }
        failAll(new Error(`scan worker stopped: ${reason}`));
    }

    // A request exceeded the limit → the worker (probably stuck in a read) is discarded; the other requests waiting in its queue fail too
    // (they would be stuck behind it anyway).
    function onJobTimeout(w, source) {
        if (worker !== w) return;
        dropWorker(`timeout (${source}, ${Math.round(jobTimeoutMs / 1000)} s)`);
        try { w.terminate(); } catch (err) { /* already stopped */ }
    }

    function ensureWorker() {
        if (worker) return worker;
        const Ctor = WorkerCtor || require('worker_threads').Worker;
        const w = new Ctor(workerPath, { workerData: { persistDir } });
        if (typeof w.unref === 'function') w.unref();
        w.on('message', (/** @type {any} */ msg) => {
            const p = pending.get(msg && msg.id);
            if (!p) return;
            pending.delete(msg.id);
            clearTimeout(p.timer);
            failures = 0; // after a successful round the respawn budget is full again
            if (msg.ok) p.resolve(msg.result);
            else p.reject(new Error(msg.error || 'scan error'));
        });
        w.on('error', (/** @type {any} */ err) => { if (worker === w) dropWorker(err && err.message); });
        w.on('exit', (/** @type {number} */ code) => { if (worker === w) dropWorker(`exit ${code}`); });
        worker = w;
        return w;
    }

    /**
     * @param {string} source a `lib/scan/scan-sources.js` `SCAN_SOURCES` egyik kulcsa
     * @param {any[]} [args]
     * @returns {Promise<any>}
     */
    function scan(source, args = []) {
        if (!inProcess && now() < cooldownUntil) {
            return Promise.reject(new Error(`scan worker paused (repeated error): ${source}`));
        }
        if (!inProcess) {
            try {
                const w = ensureWorker();
                const id = nextId++;
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => onJobTimeout(w, source), jobTimeoutMs);
                    if (timer && typeof timer.unref === 'function') timer.unref();
                    pending.set(id, { resolve, reject, timer });
                    w.postMessage({ id, source, args });
                });
            } catch (err) {
                inProcess = true;
                log(`[scan-pool] worker cannot start (${err && err.message}) — in-process mode`);
            }
        }
        try {
            enablePersistence(persistDir);
            return Promise.resolve(runScan(source, args));
        } catch (err) {
            return Promise.reject(err);
        }
    }

    function terminate() {
        const w = worker;
        worker = null;
        failAll(new Error('scan pool stopped'));
        if (w) w.terminate();
    }

    return { scan, terminate, isInProcess: () => inProcess };
}

module.exports = { createScanPool, MAX_RESPAWNS };
