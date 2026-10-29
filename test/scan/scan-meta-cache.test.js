'use strict';

// lib/scan/scan-meta-cache.js — per-file (mtime+size) metadata cache with optional persistence to disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');
const { createFileMetaCache, enablePersistence, defaultScanCacheDir, statSig } = require('../../lib/scan/scan-meta-cache.js');

test.afterEach(() => enablePersistence(null));

test('lookup — a signature match is needed (mtime AND size), the hit moves into the next generation', () => {
    const c = createFileMetaCache('t1', 1);
    c.begin();
    c.store('/a', { mtimeMs: 1, size: 10 }, { x: 1 });
    c.store('/b', { mtimeMs: 1, size: 10 }, { x: 2 });
    c.commit();
    c.begin();
    assert.deepEqual(c.lookup('/a', { mtimeMs: 1, size: 10 }), { x: 1 });
    assert.equal(c.lookup('/a', { mtimeMs: 2, size: 10 }), undefined);
    assert.equal(c.lookup('/b', { mtimeMs: 1, size: 11 }), undefined);
    assert.equal(c.lookup('/c', { mtimeMs: 1, size: 10 }), undefined);
    assert.equal(c.lookup('/a', null), undefined);
    c.commit();
    // /b was not seen (or did not match) → dropped
    c.begin();
    assert.equal(c.lookup('/b', { mtimeMs: 1, size: 10 }), undefined);
    assert.deepEqual(c.lookup('/a', { mtimeMs: 1, size: 10 }), { x: 1 });
});

test('memory mode (no enablePersistence) → does not write to disk', () => {
    const dir = tmpDir();
    const c = createFileMetaCache('mem', 1);
    c.begin();
    c.store('/a', { mtimeMs: 1, size: 1 }, 1);
    c.commit();
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('persistence — commit writes it out, a NEW instance (restart) reads it back', () => {
    const dir = tmpDir();
    enablePersistence(dir);
    const c1 = createFileMetaCache('p', 3);
    c1.begin();
    c1.store('/rom.zip', { mtimeMs: 5, size: 7 }, { games: [{ id: 'g' }] });
    c1.commit();
    assert.ok(fs.existsSync(path.join(dir, 'p.json')));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

    const c2 = createFileMetaCache('p', 3);
    c2.begin();
    assert.deepEqual(c2.lookup('/rom.zip', { mtimeMs: 5, size: 7 }), { games: [{ id: 'g' }] });
});

test('persistence — different schema version / corrupt file → empty cache, does not throw', () => {
    const dir = tmpDir();
    enablePersistence(dir);
    const c1 = createFileMetaCache('v', 1);
    c1.begin();
    c1.store('/a', { mtimeMs: 1, size: 1 }, 1);
    c1.commit();
    const c2 = createFileMetaCache('v', 2);
    c2.begin();
    assert.equal(c2.lookup('/a', { mtimeMs: 1, size: 1 }), undefined);

    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    const c3 = createFileMetaCache('broken', 1);
    c3.begin();
    assert.equal(c3.lookup('/a', { mtimeMs: 1, size: 1 }), undefined);
});

test('unchanged scan → does not rewrite the file', () => {
    const dir = tmpDir();
    enablePersistence(dir);
    const c = createFileMetaCache('same', 1);
    c.begin();
    c.store('/a', { mtimeMs: 1, size: 1 }, 1);
    c.commit();
    const file = path.join(dir, 'same.json');
    fs.writeFileSync(file, fs.readFileSync(file)); // content unchanged, but mark it:
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    marker.marker = true;
    fs.writeFileSync(file, JSON.stringify(marker));
    c.begin();
    c.lookup('/a', { mtimeMs: 1, size: 1 });
    c.commit();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).marker, true, 'was not rewritten');
});

test('defaultScanCacheDir / statSig', () => {
    assert.equal(defaultScanCacheDir('/h'), path.join('/h', '.local', 'share', 'launchers-launcher', 'scan-cache'));
    const dir = tmpDir();
    const f = path.join(dir, 'x');
    fs.writeFileSync(f, 'abc');
    assert.equal(statSig(f).size, 3);
    assert.equal(statSig(path.join(dir, 'missing')), null);
});
