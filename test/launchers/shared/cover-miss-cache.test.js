'use strict';

// lib/launchers/shared/cover-miss-cache.js — the negative cache of 404 covers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../../helpers/fs.js');
const { createCoverMissCache } = require('../../../lib/launchers/shared/cover-miss-cache.js');

function fakeDownload(statusByUrl) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        const status = statusByUrl[url] ?? 200;
        return { ok: status === 200, status };
    };
    return { fn, calls };
}

test('404 → remembers it, the next request is false WITHOUT network', async () => {
    const dl = fakeDownload({ 'u/404': 404 });
    const c = createCoverMissCache({ file: null, download: dl.fn });
    assert.equal(await c.download('u/404', '/d'), false);
    assert.equal(await c.download('u/404', '/d'), false);
    assert.deepEqual(dl.calls, ['u/404']);
    assert.deepEqual(c.stats(), { entries: 1, skipped: 1 });
});

test('a transient error (offline = 0, 5xx) does NOT get into the cache', async () => {
    const dl = fakeDownload({ 'u/off': 0, 'u/500': 503 });
    const c = createCoverMissCache({ file: null, download: dl.fn });
    await c.download('u/off', '/d'); await c.download('u/off', '/d');
    await c.download('u/500', '/d'); await c.download('u/500', '/d');
    assert.equal(dl.calls.length, 4);
    assert.equal(c.stats().entries, 0);
});

test('the entry expires after the TTL (tries again)', async () => {
    let t = 1000;
    const dl = fakeDownload({ 'u/404': 404 });
    const c = createCoverMissCache({ file: null, download: dl.fn, ttlMs: 100, now: () => t });
    await c.download('u/404', '/d');
    t += 50; await c.download('u/404', '/d');
    t += 60; await c.download('u/404', '/d');
    assert.equal(dl.calls.length, 2);
});

test('a successful download clears the earlier miss; a throw of the downloader → false, does not cache', async () => {
    let status = 404;
    const calls = [];
    const c = createCoverMissCache({
        file: null, ttlMs: 0, // expires at once → retries
        download: async (url) => { calls.push(url); if (status === 'throw') throw new Error('x'); return { ok: status === 200, status }; },
    });
    await c.download('u', '/d');
    status = 200;
    assert.equal(await c.download('u', '/d'), true);
    assert.equal(c.stats().entries, 0);
    status = 'throw';
    assert.equal(await c.download('u', '/d'), false);
    assert.equal(c.stats().entries, 0);
});

test('persistence: flush → a new instance loads it; does not load an expired entry; corrupt file → empty', async () => {
    const dir = tmpDir('gl-miss-');
    const file = path.join(dir, 'cover-misses.json');
    let t = 10_000;
    const a = createCoverMissCache({ file, download: fakeDownload({ x: 404, y: 410 }).fn, now: () => t, ttlMs: 1000 });
    await a.download('x', '/d'); await a.download('y', '/d');
    a.flush();
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['x', 'y']);

    const dl = fakeDownload({});
    const b = createCoverMissCache({ file, download: dl.fn, now: () => t + 500, ttlMs: 1000 });
    assert.equal(await b.download('x', '/d'), false);
    assert.deepEqual(dl.calls, []);
    const c = createCoverMissCache({ file, download: dl.fn, now: () => t + 5000, ttlMs: 1000 });
    assert.equal(c.stats().entries, 0);

    fs.writeFileSync(file, '{not json');
    assert.equal(createCoverMissCache({ file, download: dl.fn }).stats().entries, 0);
});

test('maxEntries ceiling: the oldest drops out on write', async () => {
    const dir = tmpDir('gl-miss-');
    const file = path.join(dir, 'm.json');
    let t = 0;
    const c = createCoverMissCache({ file, download: async () => ({ ok: false, status: 404 }), maxEntries: 2, now: () => ++t });
    for (const u of ['a', 'b', 'c']) await c.download(u, '/d');
    c.flush();
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['b', 'c']);
});

test('clear — both memory and file are cleared, the next request goes to the network again', async () => {
    const dir = tmpDir('gl-miss-');
    const file = path.join(dir, 'cover-misses.json');
    const dl = fakeDownload({ x: 404 });
    const c = createCoverMissCache({ file, download: dl.fn });
    await c.download('x', '/d');
    c.flush();
    assert.ok(fs.existsSync(file));
    c.clear();
    assert.ok(!fs.existsSync(file));
    assert.equal(c.stats().entries, 0);
    await c.download('x', '/d');
    assert.deepEqual(dl.calls, ['x', 'x']);
});
