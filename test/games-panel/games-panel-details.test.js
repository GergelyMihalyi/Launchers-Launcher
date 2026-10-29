'use strict';

// renderer/games-panel/games-panel-details.js — pure helpers of the game details view.

const test = require('node:test');
const assert = require('node:assert/strict');
const { gameDetailsFacts } = require('../../renderer/games-panel/games-panel-details.js');
const { formatBytes } = require('../../renderer/util.js');

const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);

test('formatBytes — 1024-based steps, one decimal below 10, with a comma', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1,5 KB');
    assert.equal(formatBytes(4.2 * 1024 ** 3), '4,2 GB');
    assert.equal(formatBytes(700 * 1024 ** 2), '700 MB');
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes(undefined), '');
});

test('gameDetailsFacts — the native playtime takes precedence, the last game is the later one', () => {
    const facts = gameDetailsFacts({
        ok: true,
        launcher: { count: 2, totalMs: 60000, lastLaunchedAt: '2026-09-20T10:00:00.000Z' },
        native: { playtimeMs: 7200000, lastPlayedAt: Date.parse('2026-09-22T10:00:00.000Z'), label: 'PCSX2' },
        file: { path: '/x.iso', exists: true, isDir: false, sizeBytes: 2048 },
        cover: { override: null, suggestion: '/h/covers/pcsx2/SCUS-97472.png' },
    }, t);
    const byLabel = Object.fromEntries(facts.map((f) => [f.label, f]));
    assert.equal(byLabel['games.detailsPlaytime'].value, '2h 0m');
    assert.match(byLabel['games.detailsPlaytime'].note, /PCSX2/);
    assert.equal(byLabel['games.detailsLastPlayed'].value, '2026. 09. 22.');
    assert.equal(byLabel['games.detailsLaunchCount'].value, '2×');
    assert.equal(byLabel['games.detailsFile'].note, '2 KB');
    assert.equal(byLabel['games.detailsCoverOverride'].note, 'games.detailsCoverHow');
});

test('gameDetailsFacts — without native data the launcher bookkeeping; missing file; active override', () => {
    const facts = gameDetailsFacts({
        ok: true,
        launcher: { count: 1, totalMs: 90 * 60000, lastLaunchedAt: null },
        native: null,
        file: { path: '/missing.iso', exists: false, isDir: false, sizeBytes: null },
        cover: { override: '/h/covers/steam/1.png', suggestion: '/h/covers/steam/1.png' },
    }, t);
    const byLabel = Object.fromEntries(facts.map((f) => [f.label, f]));
    assert.equal(byLabel['games.detailsPlaytime'].value, '1h 30m');
    assert.equal(byLabel['games.detailsPlaytime'].note, 'games.detailsByLauncher');
    assert.equal(byLabel['games.detailsLastPlayed'], undefined);
    assert.equal(byLabel['games.detailsFile'].note, 'games.detailsFileMissing');
    assert.equal(byLabel['games.detailsCoverOverride'].note, 'games.detailsCoverActive');
});

test('gameDetailsFacts — bad / missing response → empty', () => {
    assert.deepEqual(gameDetailsFacts(null, t), []);
    assert.deepEqual(gameDetailsFacts({ ok: false }, t), []);
    assert.deepEqual(gameDetailsFacts({ ok: true }, t), []);
});
