'use strict';

// lib/games/game-details.js — the data of the Games panel's details view.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withTempHome, writeFile, tmpDir } = require('../helpers/fs.js');
const { createGameDetails, fileInfo, launcherPlay } = require('../../lib/games/game-details.js');

test('fileInfo — file with size, folder without size, missing / no path', () => {
    const dir = tmpDir();
    const f = writeFile(dir, 'game.iso', Buffer.alloc(1234));
    assert.deepEqual(fileInfo(f), { path: f, exists: true, isDir: false, sizeBytes: 1234 });
    assert.deepEqual(fileInfo(dir), { path: dir, exists: true, isDir: true, sizeBytes: null });
    assert.equal(fileInfo(path.join(dir, 'missing.iso')).exists, false);
    assert.equal(fileInfo(undefined), null);
    assert.equal(fileInfo(''), null);
});

test('launcherPlay — the usage entry by key; RetroArch (not ROM-level) → null', () => {
    const usage = {
        'pcsx2-game-SCUS-97472': { count: 3, totalMs: 5400000, lastLaunchedAt: '2026-09-20T10:00:00.000Z' },
        'retroarch-game': { count: 9, totalMs: 1 },
    };
    assert.deepEqual(launcherPlay(usage, 'pcsx2-game-SCUS-97472'), {
        count: 3, totalMs: 5400000, lastLaunchedAt: '2026-09-20T10:00:00.000Z',
    });
    assert.equal(launcherPlay(usage, 'retroarch:NES:Metroid'), null);
    assert.equal(launcherPlay(usage, 'steam-game-1'), null);
    assert.equal(launcherPlay(usage, undefined), null);
});

test('getGameDetails — launcher + native playtime + file + cover override', async () => {
    await withTempHome(async (home) => {
        const rom = writeFile(home, 'roms/sotc.iso', Buffer.alloc(10));
        const override = writeFile(home, 'Pictures/launchers-launcher/covers/pcsx2/SCUS-97472.png', 'x');
        const calls = [];
        const details = createGameDetails({
            config: { get: (k, d) => (k === 'usage' ? { 'pcsx2-game-SCUS-97472': { count: 1, totalMs: 60000 } } : d) },
            nativePlay: {
                pcsx2: (p) => { calls.push(p); return { playtimeMs: 7200000, lastPlayedAt: 1758000000000, label: 'PCSX2' }; },
            },
        });
        const res = await details.getGameDetails({
            key: 'pcsx2-game-SCUS-97472', kind: 'pcsx2', params: { path: rom, serial: 'SCUS-97472' },
        });
        assert.deepEqual(calls, [{ path: rom, serial: 'SCUS-97472' }]);
        assert.equal(res.launcher.count, 1);
        assert.equal(res.native.label, 'PCSX2');
        assert.equal(res.file.sizeBytes, 10);
        assert.equal(res.cover.override, override);
        assert.equal(res.cover.suggestion, override);
    });
});

test('getGameDetails — unknown kind / throwing source / missing fields: does not throw, empty fields', async () => {
    await withTempHome(async (home) => {
        const logs = [];
        const details = createGameDetails({
            config: { get: () => { throw new Error('config error'); } },
            nativePlay: { steam: async () => { throw new Error('steam error'); } },
            log: (m) => logs.push(m),
        });
        const res = await details.getGameDetails({ key: 'steam-game-620', kind: 'steam', params: { appid: '620' } });
        assert.equal(res.native, null);
        assert.equal(res.launcher, null);
        assert.equal(res.file, null);
        assert.equal(res.cover.override, null);
        assert.equal(res.cover.suggestion, path.join(home, 'Pictures/launchers-launcher/covers/steam/620.png'));
        assert.equal(logs.length, 2);
        const empty = await details.getGameDetails(null);
        assert.deepEqual(empty.cover, { override: null, suggestion: null });
        // The prototype chain is not a kind: `constructor` / `toString` are not called as a source.
        assert.equal((await details.getGameDetails({ kind: 'toString', key: 'x-game-1' })).native, null);
    });
});

test('getGameDetails — the result of the metadata dep in the `metadata` field; null on error, the other fields stay', async () => {
    const { createGameDetails } = require('../../lib/games/game-details.js');
    const ok = createGameDetails({ config: { get: (k, d) => d }, metadata: async (kind, params) => ({ developer: `${kind}:${params.appName}` }) });
    assert.deepEqual((await ok.getGameDetails({ key: 'heroic-game-a1', kind: 'heroic', params: { appName: 'a1' } })).metadata, { developer: 'heroic:a1' });
    const bad = createGameDetails({ config: { get: (k, d) => d }, metadata: async () => { throw new Error('boom'); } });
    const res = await bad.getGameDetails({ key: 'heroic-game-a1', kind: 'heroic', params: {} });
    assert.equal(res.metadata, null);
    assert.ok('cover' in res && 'launcher' in res);
});
