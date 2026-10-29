'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, withTempHome } = require('../../helpers/fs.js');

const {
    coverCacheDir, coverPath, resolveCachedCover, writeCoverAtomic, sanitizeCoverId,
    ensureCoversForEntries,
} = require('../../../lib/launchers/shared/cover-cache.js');

test('coverCacheDir / coverPath — gives the ~/.local/share/launchers-launcher/covers/<launcherId>/<id>.<ext> pattern', () => {
    withTempHome((home) => {
        assert.equal(
            coverCacheDir('pcsx2'),
            path.join(home, '.local', 'share', 'launchers-launcher', 'covers', 'pcsx2'),
        );
        assert.equal(coverPath('pcsx2', 'SCUS-97472', 'jpg'), path.join(coverCacheDir('pcsx2'), 'SCUS-97472.jpg'));
    });
});

test('resolveCachedCover — missing id -> null, nonexistent file -> null, never throws', () => {
    withTempHome(() => {
        assert.equal(resolveCachedCover('cemu', null, 'png'), null);
        assert.equal(resolveCachedCover('cemu', 'X', 'png'), null);
    });
});

test('resolveCachedCover — gives the full path for an existing file', () => {
    withTempHome(() => {
        const dest = coverPath('dolphin', 'GALE01', 'png');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'x');
        assert.equal(resolveCachedCover('dolphin', 'GALE01', 'png'), dest);
    });
});

test('writeCoverAtomic — mkdir + temp+rename, the result is readable, leaves no temp file', () => {
    withTempHome(() => {
        const dest = coverPath('ryujinx', '0100000000010000', 'jpg');
        const result = writeCoverAtomic(dest, Buffer.from('jpeg-bytes'));
        assert.equal(result, dest);
        assert.equal(fs.readFileSync(dest, 'utf8'), 'jpeg-bytes');
        const leftovers = fs.readdirSync(path.dirname(dest)).filter((f) => f.includes('.tmp-'));
        assert.deepEqual(leftovers, []);
    });
});

test('writeCoverAtomic — null on an invalid target path, does not throw', () => {
    const result = writeCoverAtomic('', null);
    assert.equal(result, null);
});

test('sanitizeCoverId — only [A-Za-z0-9_-] stays, everything else is replaced with an underscore', () => {
    assert.equal(sanitizeCoverId('SCUS-97472'), 'SCUS-97472');
    assert.equal(sanitizeCoverId('0100000000010000'), '0100000000010000');
    assert.equal(sanitizeCoverId('../../etc/passwd'), '______etc_passwd');
    assert.equal(sanitizeCoverId('..'), '__');
});

test('coverPath — a crafted (path-traversal attempting) id never leaves the cache directory', () => {
    withTempHome(() => {
        const cacheDir = coverCacheDir('dolphin');
        const malicious = '../../../../etc/passwd';
        const dest = coverPath('dolphin', malicious, 'png');
        assert.equal(path.dirname(dest), cacheDir, 'the file stays in the cache directory, does not leave it');
        const rel = path.relative(cacheDir, dest);
        assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), 'the result is UNDER cacheDir');
    });
});

// ensureCoversForEntries — the shared network download loop of the 5 launcher modules
// (ryujinx/pcsx2/dolphin/duckstation ensure*Covers + retroarch ensureRecentThumbnails).
// The per-launcher `ensureXCovers` wrappers call it — this test covers the loop itself,
// regardless of which launcher calls it.
function fixedCfg(overrides = {}) {
    return {
        hasKey: (e) => !!(e && e.key),
        destPath: (e) => `/cache/${e.key}.jpg`,
        buildUrl: (e) => `https://example.test/${e.key}`,
        logKey: (e) => e.key,
        logLabel: 'Test',
        ...overrides,
    };
}

test('ensureCoversForEntries — downloads only the entry without a cover that matches hasKey, cover in place', async () => {
    const calls = [];
    const entries = [
        { key: 'a', cover: '/already/there.jpg' },
        { key: 'b', cover: null },
        { cover: null }, // hasKey false (no key)
    ];
    const download = async (url, dest) => { calls.push({ url, dest }); return true; };

    const n = await ensureCoversForEntries(entries, { ...fixedCfg(), download });

    assert.equal(n, 1);
    assert.deepEqual(calls, [{ url: 'https://example.test/b', dest: '/cache/b.jpg' }]);
    assert.equal(entries[1].cover, '/cache/b.jpg');
    assert.equal(entries[0].cover, '/already/there.jpg');
    assert.equal(entries[2].cover, null);
});

test('ensureCoversForEntries — sets a file already on disk without downloading', async () => {
    const dir = tmpDir('gl-ensure-onDisk-');
    const dest = path.join(dir, 'b.jpg');
    fs.writeFileSync(dest, 'x');
    const entries = [{ key: 'b', cover: null }];
    let downloadCalled = false;

    const n = await ensureCoversForEntries(entries, {
        ...fixedCfg({ destPath: () => dest }),
        download: async () => { downloadCalled = true; return true; },
    });

    assert.equal(n, 0);
    assert.equal(downloadCalled, false);
    assert.equal(entries[0].cover, dest);
});

test('ensureCoversForEntries — on a failed download the cover stays null, does not throw', async () => {
    const entries = [{ key: 'x', cover: null }];
    const n = await ensureCoversForEntries(entries, { ...fixedCfg(), download: async () => false });
    assert.equal(n, 0);
    assert.equal(entries[0].cover, null);
});

test('ensureCoversForEntries — a throw of download() is logged, not rethrown', async () => {
    const logs = [];
    const entries = [{ key: 'boom', cover: null }];
    const n = await ensureCoversForEntries(entries, {
        ...fixedCfg(),
        download: async () => { throw new Error('network error'); },
        log: (msg) => logs.push(msg),
    });
    assert.equal(n, 0);
    assert.equal(entries[0].cover, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Test cover download error \(boom\): network error$/);
});

test('ensureCoversForEntries — missing download / non-array entries -> 0, does not throw', async () => {
    assert.equal(await ensureCoversForEntries([{ key: 'a', cover: null }], fixedCfg()), 0);
    assert.equal(await ensureCoversForEntries(null, { ...fixedCfg(), download: async () => true }), 0);
});
