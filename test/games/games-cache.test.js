'use strict';

// lib/games/games-cache.js — "Clear cache".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeFile } = require('../helpers/fs.js');
const { gamesCacheDirs, measureGamesCache, clearGamesCache } = require('../../lib/games/games-cache.js');

test('gamesCacheDirs — the covers + scan-cache folder under ~/.local/share/launchers-launcher', () => {
    const home = tmpDir('gl-gcache-');
    const dirs = gamesCacheDirs(home);
    assert.deepEqual(dirs.map((d) => d.id), ['covers', 'scan']);
    assert.equal(dirs[0].path, path.join(home, '.local', 'share', 'launchers-launcher', 'covers'));
    assert.equal(dirs[1].path, path.join(home, '.local', 'share', 'launchers-launcher', 'scan-cache'));
});

test('measureGamesCache — recursive size + file count; a missing folder is 0', async () => {
    const home = tmpDir('gl-gcache-');
    const root = path.join(home, '.local', 'share', 'launchers-launcher');
    writeFile(root, 'covers/pcsx2/SLUS-1.png', 'x'.repeat(100));
    writeFile(root, 'covers/cemu/abc.png', 'y'.repeat(50));
    const res = await measureGamesCache(home);
    assert.deepEqual(res.map((d) => [d.id, d.bytes, d.files]), [['covers', 150, 2], ['scan', 0, 0]]);
});

test('clearGamesCache — deletes the two folders, not the neighboring files (config, log, negative cache)', async () => {
    const home = tmpDir('gl-gcache-');
    const root = path.join(home, '.local', 'share', 'launchers-launcher');
    writeFile(root, 'covers/pcsx2/SLUS-1.png', 'x'.repeat(100));
    writeFile(root, 'scan-cache/melonds.json', '{}');
    writeFile(root, 'cover-misses.json', '{}');
    const res = await clearGamesCache(home);
    assert.deepEqual(res, { ok: true, freedBytes: 102 });
    assert.ok(!fs.existsSync(path.join(root, 'covers')));
    assert.ok(!fs.existsSync(path.join(root, 'scan-cache')));
    assert.ok(fs.existsSync(path.join(root, 'cover-misses.json')));
    // Succeeds in an empty state too (idempotent).
    assert.deepEqual(await clearGamesCache(home), { ok: true, freedBytes: 0 });
});
