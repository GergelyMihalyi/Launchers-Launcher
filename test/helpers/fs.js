'use strict';

// Shared file-system helpers for the tests. NOT a test file (`npm test` only runs `*.test.js`,
// see package.json) — the tests use it via `require('./helpers/fs.js')` (from a subfolder
// `../helpers/fs.js`).
//
// Every folder created with `tmpDir()` is deleted when the process exits — no test may
// leave a `gl-*` folder behind in /tmp.

const fs = require('fs');
const os = require('os');
const path = require('path');

const created = [];
let cleanupRegistered = false;

function registerCleanup() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.once('exit', () => {
        for (const dir of created) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        }
    });
}

/** A new, empty temp folder `<os.tmpdir()>/<prefix>XXXXXX`, deleted automatically at process exit. */
function tmpDir(prefix = 'gl-test-') {
    registerCleanup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    return dir;
}

/**
 * Runs `fn(home)` under a fresh, empty temp `HOME`, then restores the previous one
 * (for an async `fn`, after the Promise settles). On Linux `os.homedir()` reads `HOME`,
 * so the call-time `os.homedir()` of the lib modules sees the temp folder too.
 */
function withTempHome(fn, prefix = 'gl-home-') {
    const home = tmpDir(prefix);
    const prev = process.env.HOME;
    const restore = () => { process.env.HOME = prev; };
    process.env.HOME = home;
    let result;
    try {
        result = fn(home);
    } catch (err) {
        restore();
        throw err;
    }
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
}

/**
 * `XDG_CONFIG_HOME` to a temp folder — must be called BEFORE `require`-ing `lib/config.js`.
 * `reset()` deletes the config folder (a clean slate between tests).
 */
function useTempConfigHome(prefix = 'gl-xdg-') {
    const dir = tmpDir(prefix);
    process.env.XDG_CONFIG_HOME = dir;
    return {
        dir,
        reset() { fs.rmSync(path.join(dir, 'launchers-launcher'), { recursive: true, force: true }); },
    };
}

/**
 * Simulates a config.json broken BY HAND: writes the key to the file without a type check
 * (`config.set` already rejects a known key with the wrong type). Temp + rename: because of the new
 * inode the stat-signature cache of `lib/config.js` surely rereads.
 * @param {string} configFile the `require('lib/config.js').CONFIG_FILE`
 */
function writeRawConfigKey(configFile, key, value) {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (err) { /* not there yet */ }
    all[key] = value;
    mkdirp(path.dirname(configFile));
    const tmp = `${configFile}.raw-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, configFile);
}

function mkdirp(p) {
    fs.mkdirSync(p, { recursive: true });
    return p;
}

/** Writes `data` under `dir/rel`, creating the intermediate folders; returns the full path. */
function writeFile(dir, rel, data) {
    const abs = path.join(dir, rel);
    mkdirp(path.dirname(abs));
    fs.writeFileSync(abs, data);
    return abs;
}

/** Every `.js` file under `dir`, recursively, with a `/` path relative to `dir`. */
function listJsFiles(dir, base = '') {
    const out = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const abs = path.join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        if (fs.statSync(abs).isDirectory()) out.push(...listJsFiles(abs, rel));
        else if (name.endsWith('.js')) out.push(rel);
    }
    return out;
}

module.exports = { tmpDir, withTempHome, useTempConfigHome, writeRawConfigKey, mkdirp, writeFile, listJsFiles };
