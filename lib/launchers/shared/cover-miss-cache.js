// @ts-check
'use strict';

// Negative cache for network cover downloads: a PERMANENT miss of a cover that does not exist on the server (404 / 410) is remembered
// for `ttlMs` (7 days), until then the download returns `false` WITHOUT a network request. DELIBERATELY only 404/410: offline / timeout /
// 5xx (`status` 0 or ≥ 500) is transient — otherwise a short network outage would disable covers for a week. Small JSON
// (`{ "<url>": <epoch ms> }`), written with `fs-atomic`, delayed; main passes this one's `download` in place of `download(url, dest)`.

const fs = require('fs');
const { writeFileAtomic } = require('../../fs-atomic.js');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;
const MISS_STATUSES = new Set([404, 410]);

/**
 * @param {Object} opts
 * @param {string|null} opts.file  path of the persistent JSON (`null` = memory only)
 * @param {(url: string, dest: string) => Promise<{ ok: boolean, status: number }>} opts.download
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.maxEntries]
 * @param {() => number} [opts.now]
 * @param {number} [opts.flushDelayMs]
 * @param {(msg: string) => void} [opts.log]
 */
function createCoverMissCache({
    file, download, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES,
    now = Date.now, flushDelayMs = 1000, log = () => {},
}) {
    /** @type {Map<string, number>|null} */
    let misses = null;
    let flushTimer = null;
    let skipped = 0;

    function load() {
        if (misses) return misses;
        misses = new Map();
        if (!file) return misses;
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const t = now();
            for (const [url, at] of Object.entries(raw || {})) {
                if (typeof at === 'number' && t - at < ttlMs) misses.set(url, at);
            }
        } catch (err) { /* missing / corrupt → empty */ }
        return misses;
    }

    function scheduleFlush() {
        if (!file || flushTimer) return;
        flushTimer = setTimeout(flush, flushDelayMs);
        if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }

    function flush() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (!file || !misses) return;
        // The oldest ones drop out above the cap (the Map keeps insertion order).
        while (misses.size > maxEntries) misses.delete(misses.keys().next().value);
        try {
            writeFileAtomic(file, JSON.stringify(Object.fromEntries(misses)));
        } catch (err) {
            log(`Cover miss-cache write error: ${err.message}`);
        }
    }

    function isMiss(url) {
        const at = load().get(url);
        if (at === undefined) return false;
        if (now() - at >= ttlMs) { misses.delete(url); scheduleFlush(); return false; }
        return true;
    }

    // Replacement for `download(url, dest)`: a known miss → `false` immediately (no request).
    async function cachedDownload(url, dest) {
        if (isMiss(url)) { skipped += 1; return false; }
        let r;
        try { r = await download(url, dest); } catch (err) { return false; }
        if (r && r.ok) {
            if (load().delete(url)) scheduleFlush();
            return true;
        }
        if (r && MISS_STATUSES.has(r.status)) {
            const m = load();
            m.delete(url); // the fresh entry goes to the end of the Map (the cap drops the oldest)
            m.set(url, now());
            scheduleFlush();
        }
        return false;
    }

    // Settings → System → "Clear cache": the in-memory Map is cleared too (otherwise the next flush would write the
    // deleted file back).
    function clear() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        misses = new Map();
        if (file) {
            try { fs.rmSync(file, { force: true }); } catch (err) { log(`Cover miss-cache delete error: ${err.message}`); }
        }
    }

    return {
        download: cachedDownload, isMiss, flush, clear,
        stats: () => ({ entries: load().size, skipped }),
    };
}

module.exports = { createCoverMissCache, DEFAULT_TTL_MS, MISS_STATUSES };
