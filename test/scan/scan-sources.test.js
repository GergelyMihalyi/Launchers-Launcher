'use strict';

// lib/scan/scan-sources.js — the table of heavy library scans runnable in a worker thread. Both the
// worker and the in-process fallback call `runScan`; main.js's `workerScans` refers to the table by
// source name, a typo'd name would only show at runtime (in the "Games" panel).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, writeFile, listJsFiles } = require('../helpers/fs.js');
const { SCAN_SOURCES, runScan } = require('../../lib/scan/scan-sources.js');

const root = path.join(__dirname, '..', '..');

test('SCAN_SOURCES — the heavy (ROM-folder-walking) sources, all functions', () => {
    // subset check: the new-emulator generator adds a new key
    for (const id of ['cemu', 'dolphin', 'duckstation', 'melonds', 'pcsx2', 'ppsspp', 'retroAll', 'romDirs', 'ryujinx']) {
        assert.ok(id in SCAN_SOURCES, id);
    }
    for (const [id, fn] of Object.entries(SCAN_SOURCES)) assert.equal(typeof fn, 'function', id);
});

// main.js builds `workerScans` from the keys of `SCAN_SOURCES` — instead of manually listed
// `scanPool.scan('x')` calls. What can go wrong: a consumer (`workerLoader('x')`,
// `workerScans.x`) refers to a source that is not in the table.
test('main.js builds workerScans from SCAN_SOURCES, and every consumer key exists', () => {
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(mainSrc, /Object\.keys\(SCAN_SOURCES\)/, 'the workerScans of main.js is not built from SCAN_SOURCES');
    assert.doesNotMatch(mainSrc, /scanPool\.scan\('/, 'manually listed scanPool.scan(\'x\') — add it to SCAN_SOURCES');
    const libDir = path.join(root, 'lib');
    const used = [];
    for (const rel of listJsFiles(libDir)) {
        const src = fs.readFileSync(path.join(libDir, rel), 'utf8');
        for (const m of src.matchAll(/workerLoader\('([^']+)'|workerScans\.([A-Za-z]+)\(/g)) used.push(`${rel}: ${m[1] || m[2]}`);
    }
    assert.ok(used.length > 0, 'no workerLoader / workerScans reference — was the pattern lost?');
    const unknown = used.filter((u) => !(u.split(': ')[1] in SCAN_SOURCES));
    assert.deepEqual(unknown, [], `unknown worker-scan source: ${unknown.join(', ')}`);
});

test('runScan — unknown source: throws (the worker returns this as an error message)', () => {
    assert.throws(() => runScan('no-such', []), /unknown scan source: no-such/);
});

test('runScan — for an empty/nonexistent root every source gives an empty list, does not throw', () => {
    const empty = tmpDir('gl-scan-src-');
    assert.deepEqual(runScan('melonds', [empty, []]), []);
    assert.deepEqual(runScan('ppsspp', [empty]), []);
    assert.deepEqual(runScan('duckstation', [empty]), []);
    assert.deepEqual(runScan('retroAll', [empty]), []);
    assert.deepEqual(runScan('romDirs', ['pcsx2', empty]), []);
});

test('runScan — a real scan on a playlist fixture (retroAll: grouped by system)', () => {
    const raRoot = tmpDir('gl-scan-src-ra-');
    writeFile(raRoot, 'playlists/Nintendo - NES.lpl', JSON.stringify({
        items: [{ path: '/roms/nes/mario.nes', label: 'Super Mario Bros.' }],
    }));
    const groups = runScan('retroAll', [raRoot]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].system, 'Nintendo - NES');
    assert.deepEqual(groups[0].games.map((g) => g.label), ['Super Mario Bros.']);
});

test('runScan — spreads the args array, calls without an argument for non-array args', (t) => {
    SCAN_SOURCES.__probe = (...args) => args;
    t.after(() => { delete SCAN_SOURCES.__probe; });
    assert.deepEqual(runScan('__probe', ['/a', ['/b']]), ['/a', ['/b']]);
    assert.deepEqual(runScan('__probe', null), []);
    assert.deepEqual(runScan('__probe', undefined), []);
});
