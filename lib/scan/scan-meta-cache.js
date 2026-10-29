// @ts-check
'use strict';

// Per-file, signature-based (`mtimeMs` + `size`) metadata cache for the library scans, with OPTIONAL persistence: the expensive header
// extraction of an unchanged ROM/zip/disc image (melonDS zip inflate, PPSSPP `.cso`, DuckStation ISO9660 — seconds cold on NFS) survives a
// restart, only one `stat` per file. Flow: `begin()` → per file `lookup(path, stat)` OR extraction + `store(...)` → `commit()` (replaces the
// PREVIOUS generation with the one just seen, writes it with an atomic temp+rename if it changed).
// ⚠️ Writing to disk is OFF BY DEFAULT — only `enablePersistence(dir)` turns it on (`scan-worker.js` from `workerData.persistDir`, the
// in-process fallback of `scan-pool.js`), so unit tests never write the machine's real cache. Values are JSON-compatible (no Buffer).
// Background: docs/dev/infrastructure.md#worker-thread-scans

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../fs-atomic.js');
const { dataHome } = require('../xdg.js');

/** @type {string | null} */
let persistDir = null;

function defaultScanCacheDir(homeDir = os.homedir()) {
    return path.join(dataHome(homeDir), 'launchers-launcher', 'scan-cache');
}

/** @param {string | null} dir `null` → back to memory mode */
function enablePersistence(dir) {
    persistDir = dir;
}

/**
 * @typedef {{ mtimeMs: number, size: number }} FileSig
 * @typedef {{ m: number, s: number, v: any }} CacheEntry
 */

/**
 * @param {string} name     name of the cache file (`<dir>/<name>.json`) — unique per source
 * @param {number} version  version of the stored value's SCHEMA — bumping it drops the old file
 */
function createFileMetaCache(name, version) {
    /** @type {Map<string, CacheEntry> | null} */
    let prev = null;
    /** @type {Map<string, CacheEntry>} */
    let next = new Map();
    let dirty = false;

    function filePath() {
        return persistDir ? path.join(persistDir, `${name}.json`) : null;
    }

    /** @returns {Map<string, CacheEntry>} */
    function loaded() {
        if (prev) return prev;
        prev = new Map();
        const file = filePath();
        if (!file) return prev;
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (raw && raw.version === version && raw.entries && typeof raw.entries === 'object') {
                for (const [k, e] of Object.entries(raw.entries)) {
                    if (e && typeof e.m === 'number' && typeof e.s === 'number') prev.set(k, e);
                }
            }
        } catch (err) {
            // missing / corrupt file → empty cache (the scan rebuilds it)
        }
        return prev;
    }

    function begin() {
        loaded();
        next = new Map();
        dirty = false;
    }

    /**
     * @param {string} key
     * @param {FileSig | null | undefined} stat
     * @returns {any} the stored value, or `undefined` if missing / stale
     */
    function lookup(key, stat) {
        if (!stat) return undefined;
        const e = loaded().get(key);
        if (!e || e.m !== stat.mtimeMs || e.s !== stat.size) return undefined;
        next.set(key, e);
        return e.v;
    }

    /**
     * @param {string} key
     * @param {FileSig | null | undefined} stat
     * @param {any} value
     */
    function store(key, stat, value) {
        if (!stat) return;
        next.set(key, { m: stat.mtimeMs, s: stat.size, v: value });
        dirty = true;
    }

    function commit() {
        const old = loaded();
        if (next.size !== old.size) dirty = true;
        prev = next;
        next = new Map();
        const file = filePath();
        if (!dirty || !file) { dirty = false; return; }
        dirty = false;
        try {
            writeFileAtomic(file, JSON.stringify({ version, entries: Object.fromEntries(prev) }));
        } catch (err) {
            // best effort — the memory cache still lives
        }
    }

    /** Tests only: drops the memory state (the next call reloads it from disk). */
    function reset() {
        prev = null;
        next = new Map();
        dirty = false;
    }

    return { begin, lookup, store, commit, reset };
}

/** @param {string} p @returns {FileSig | null} */
function statSig(p) {
    try {
        const st = fs.statSync(p);
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
        return null;
    }
}

module.exports = { createFileMetaCache, enablePersistence, defaultScanCacheDir, statSig };
