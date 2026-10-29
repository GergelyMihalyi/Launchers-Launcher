// @ts-check
'use strict';

// The launcher's OWN rebuildable caches (Settings → Games → "Clear cache"): the cover cache (`covers/<source>/…`) + the worker scans'
// file-meta cache (`scan-cache/`); both rebuild by themselves. Does NOT touch the manual cover overrides, the config, the log or the sidecar
// files; the negative cover cache (`cover-misses.json`) is cleared by the caller with `coverMisses.clear()`.
// Async I/O, never throws (error → 0 in the measurement / `ok: false`). Background: docs/dev/games-panel.md#warm-up-and-caches

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { dataHome } = require('../xdg.js');

/** @param {string} [homeDir] */
function gamesCacheDirs(homeDir = os.homedir()) {
    const root = path.join(dataHome(homeDir), 'launchers-launcher');
    return [
        { id: 'covers', path: path.join(root, 'covers') },
        { id: 'scan', path: path.join(root, 'scan-cache') },
    ];
}

// Total size + file count of a folder tree (does not follow symlinks). Missing folder → 0.
/** @param {string} dir @returns {Promise<{ bytes: number, files: number }>} */
async function dirSize(dir) {
    let bytes = 0;
    let files = 0;
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        return { bytes, files };
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const sub = await dirSize(p);
            bytes += sub.bytes;
            files += sub.files;
        } else if (e.isFile()) {
            try {
                bytes += (await fsp.stat(p)).size;
                files += 1;
            } catch (err) { /* deleted meanwhile */ }
        }
    }
    return { bytes, files };
}

/** @param {string} [homeDir] */
async function measureGamesCache(homeDir) {
    const dirs = gamesCacheDirs(homeDir);
    const sizes = await Promise.all(dirs.map((d) => dirSize(d.path)));
    return dirs.map((d, i) => ({ id: d.id, path: d.path, ...sizes[i] }));
}

/** @param {string} [homeDir] @returns {Promise<{ ok: boolean, freedBytes: number, error?: string }>} */
async function clearGamesCache(homeDir) {
    const before = await measureGamesCache(homeDir);
    const freedBytes = before.reduce((n, d) => n + d.bytes, 0);
    try {
        for (const d of before) await fsp.rm(d.path, { recursive: true, force: true });
        return { ok: true, freedBytes };
    } catch (err) {
        return { ok: false, freedBytes: 0, error: err.message };
    }
}

module.exports = { gamesCacheDirs, measureGamesCache, clearGamesCache };
