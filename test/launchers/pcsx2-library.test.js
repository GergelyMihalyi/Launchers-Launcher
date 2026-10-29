'use strict';

// lib/launchers/pcsx2-library.js — PCSX2 (PS2) disc-image discovery.
// The `.iso` serial extraction (SYSTEM.CNF, no crypto) is covered on a synthetic, minimal
// ISO9660 image (`buildPs2Iso` -> `buildFakeIso` in `test/helpers/fixtures.js`) — it follows the
// structure of a "Shadow of the Colossus.ISO" found on the machine (PVD -> root-directory extent ->
// SYSTEM.CNF entry).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, withTempHome, writeFile } = require('../helpers/fs.js');
const { buildFakeIso, serialToBootLine } = require('../helpers/fixtures.js');
const {
    readGameDirs, extractSerialFromIso, pcsx2GameLabel, pcsx2GameId, findInstalledGames, findInstalledGamesCached, findRecentlyPlayed,
    pcsx2CoverPath, resolvePcsx2Cover, ps2CoverUrl, ensurePcsx2Covers,
    pcsx2GameArgs,
} = require('../../lib/launchers/pcsx2-library.js');

// A PS2 disc image: a SYSTEM.CNF (with the BOOT2 line) in the root only.
function buildPs2Iso({ cnfText, noMagic = false, noSystemCnf = false } = {}) {
    return buildFakeIso(noSystemCnf ? {} : { 'SYSTEM.CNF': cnfText }, { noMagic });
}

function writeTempIso(buf) {
    return writeFile(tmpDir('gl-pcsx2-iso-'), 'game.iso', buf);
}

test('readGameDirs — only the folders that actually exist, deduped', () => {
    const configRoot = tmpDir('gl-pcsx2-cfg-');
    const romsDir = tmpDir('gl-pcsx2-roms-');
    fs.mkdirSync(path.join(configRoot, 'inis'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'inis', 'PCSX2.ini'), [
        '[GameList]',
        `RecursivePaths = ${romsDir}`,
        `RecursivePaths = ${romsDir}`, // duplicate -> dedup
        'RecursivePaths = /does/not/exist/somewhere',
        '',
    ].join('\n'));
    assert.deepEqual(readGameDirs(configRoot), [romsDir]);
});

test('readGameDirs — an empty list for a missing ini, does not throw', () => {
    const configRoot = tmpDir('gl-pcsx2-cfg-');
    assert.deepEqual(readGameDirs(configRoot), []);
});

test('extractSerialFromIso — the format seen on the machine (SYSTEM.CNF, no crypto)', () => {
    const p = writeTempIso(buildPs2Iso({ cnfText: serialToBootLine('SCUS-97472', { ps2: true }) }));
    assert.equal(extractSerialFromIso(p), 'SCUS-97472');
});

test('extractSerialFromIso — no CD001 magic -> null', () => {
    const p = writeTempIso(buildPs2Iso({ cnfText: serialToBootLine('SCUS-97472', { ps2: true }), noMagic: true }));
    assert.equal(extractSerialFromIso(p), null);
});

test('extractSerialFromIso — no SYSTEM.CNF entry in the root directory -> null', () => {
    const p = writeTempIso(buildPs2Iso({ noSystemCnf: true }));
    assert.equal(extractSerialFromIso(p), null);
});

test('extractSerialFromIso — SYSTEM.CNF is present, but no BOOT2 line -> null', () => {
    const p = writeTempIso(buildPs2Iso({ cnfText: 'VER = 1.00\r\n' }));
    assert.equal(extractSerialFromIso(p), null);
});

test('extractSerialFromIso — nonexistent file -> null, does not throw', () => {
    assert.equal(extractSerialFromIso('/does/not/exist/game.iso'), null);
});

test('pcsx2GameLabel — extension stripped, _/. -> space', () => {
    assert.equal(pcsx2GameLabel('Shadow_of_the_Colossus.iso'), 'Shadow of the Colossus');
    assert.equal(pcsx2GameLabel('God.of.War.II.bin'), 'God of War II');
});

test('pcsx2GameId — the serial if present; otherwise a stable path-hash substitute', () => {
    assert.equal(pcsx2GameId('SCUS-97472', '/roms/x.iso'), 'SCUS-97472');
    const id = pcsx2GameId(null, '/roms/no-serial.cue');
    assert.match(id, /^p:[0-9a-f]{16}$/);
    assert.equal(pcsx2GameId(null, '/roms/no-serial.cue'), id); // deterministic (same path)
});

test('findInstalledGames — walking the [GameList] folders, .iso with serial + playtime, other formats with a file-name based title', () => {
    const configRoot = tmpDir('gl-pcsx2-cfg-');
    const romsDir = tmpDir('gl-pcsx2-roms-');
    const fakeHome = tmpDir('gl-pcsx2-home-'); // no flatpak install -> GameIndex not found
    fs.mkdirSync(path.join(configRoot, 'inis'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'inis', 'PCSX2.ini'), `[GameList]\nRecursivePaths = ${romsDir}\n`);
    fs.writeFileSync(path.join(configRoot, 'inis', 'playtime.dat'), 'ZZZZ-99999  120  1700000000\n');

    fs.writeFileSync(path.join(romsDir, 'Game One.iso'), buildPs2Iso({ cnfText: serialToBootLine('ZZZZ-99999', { ps2: true }) }));
    fs.writeFileSync(path.join(romsDir, 'Game Two.cue'), 'FILE "Game Two.bin" BINARY\n'); // non-ISO format
    fs.writeFileSync(path.join(romsDir, 'readme.txt'), 'not a disc image'); // skipped

    const games = findInstalledGames(configRoot, fakeHome);
    const names = games.map((g) => g.name).sort();
    assert.deepEqual(names, ['Game One', 'Game Two']);

    const one = games.find((g) => g.name === 'Game One');
    assert.equal(one.serial, 'ZZZZ-99999');
    assert.equal(one.id, 'ZZZZ-99999');
    assert.equal(one.lastPlayedAt, 1700000000000);

    const two = games.find((g) => g.name === 'Game Two');
    assert.equal(two.serial, null);
    assert.equal(two.lastPlayedAt, null);
    assert.match(two.id, /^p:[0-9a-f]{16}$/);
});

test('findInstalledGames — empty list for an empty/missing [GameList]', () => {
    const configRoot = tmpDir('gl-pcsx2-cfg-');
    assert.deepEqual(findInstalledGames(configRoot, configRoot), []);
});

test('findInstalledGamesCached — exported, a function', () => {
    assert.equal(typeof findInstalledGamesCached, 'function');
});

test('findRecentlyPlayed — descending by lastPlayedAt, cut to max, recentGames shape', () => {
    const configRoot = tmpDir('gl-pcsx2-cfg-');
    const romsDir = tmpDir('gl-pcsx2-roms-');
    const fakeHome = tmpDir('gl-pcsx2-home-');
    fs.mkdirSync(path.join(configRoot, 'inis'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'inis', 'PCSX2.ini'), `[GameList]\nRecursivePaths = ${romsDir}\n`);
    fs.writeFileSync(path.join(configRoot, 'inis', 'playtime.dat'), [
        'AAAA-11111  10  1600000000',
        'BBBB-22222  20  1700000000',
    ].join('\n'));
    fs.writeFileSync(path.join(romsDir, 'Old.iso'), buildPs2Iso({ cnfText: serialToBootLine('AAAA-11111', { ps2: true }) }));
    fs.writeFileSync(path.join(romsDir, 'New.iso'), buildPs2Iso({ cnfText: serialToBootLine('BBBB-22222', { ps2: true }) }));
    fs.writeFileSync(path.join(romsDir, 'NeverPlayed.iso'), buildPs2Iso({ cnfText: serialToBootLine('CCCC-33333', { ps2: true }) }));

    const recent = findRecentlyPlayed(configRoot, fakeHome, 5);
    assert.deepEqual(recent.map((r) => r.key), ['pcsx2-game-BBBB-22222', 'pcsx2-game-AAAA-11111']);
    assert.equal(recent[0].kind, 'pcsx2');
    assert.deepEqual(recent[0].params, { path: path.join(romsDir, 'New.iso'), serial: 'BBBB-22222' });
    // Must be an ISO 8601 STRING, NOT the raw ms-epoch number — mergeRecentGameLists() in
    // lib/recent/usage.js calls Date.parse() on it (this was the production bug, see the
    // analogous duckstation-library.js fix).
    assert.equal(recent[0].lastLaunchedAt, new Date(1700000000000).toISOString());
    assert.equal(Number.isNaN(Date.parse(recent[0].lastLaunchedAt)), false);

    assert.equal(findRecentlyPlayed(configRoot, fakeHome, 1).length, 1);
});

test('findRecentlyPlayed — with an explicit homeDir it shares the SAME cache as findInstalledGamesCached (no double scanning)', () => {
    const configRoot = tmpDir('gl-pcsx2-cfg-');
    const romsDir = tmpDir('gl-pcsx2-roms-');
    const fakeHome = tmpDir('gl-pcsx2-home-');
    fs.mkdirSync(path.join(configRoot, 'inis'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'inis', 'PCSX2.ini'), `[GameList]\nRecursivePaths = ${romsDir}\n`);
    fs.writeFileSync(path.join(configRoot, 'inis', 'playtime.dat'), 'AAAA-11111  10  1600000000');
    const isoPath = path.join(romsDir, 'Game.iso');
    fs.writeFileSync(isoPath, buildPs2Iso({ cnfText: serialToBootLine('AAAA-11111', { ps2: true }) }));

    // If the caller (like a test fixture) passes an explicit homeDir in both places, the 2-argument
    // call hits the SAME cache key too.
    assert.equal(findInstalledGamesCached(configRoot, fakeHome).length, 1);

    // The ROM disappears from disk — a fresh (uncached) scan would return an empty list from now on.
    fs.rmSync(isoPath);
    const stillCached = findRecentlyPlayed(configRoot, fakeHome, 5);
    assert.equal(stillCached.length, 1, 'findRecentlyPlayed reads from the SHARED cache, does not rescan');

    findInstalledGamesCached.invalidate();
    assert.equal(findRecentlyPlayed(configRoot, fakeHome, 5).length, 0, 'after invalidate() the result is fresh (empty)');
});

test('findRecentlyPlayed — in PRODUCTION mode (homeDir === undefined) it shares the ONE-ARGUMENT findInstalledGamesCached(configRoot) with the list-pcsx2-games IPC', () => {
    const configRoot = tmpDir('gl-pcsx2-cfg-');
    const romsDir = tmpDir('gl-pcsx2-roms-');
    fs.mkdirSync(path.join(configRoot, 'inis'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'inis', 'PCSX2.ini'), `[GameList]\nRecursivePaths = ${romsDir}\n`);
    fs.writeFileSync(path.join(configRoot, 'inis', 'playtime.dat'), 'AAAA-11111  10  1600000000');
    const isoPath = path.join(romsDir, 'Game.iso');
    fs.writeFileSync(isoPath, buildPs2Iso({ cnfText: serialToBootLine('AAAA-11111', { ps2: true }) }));

    // The `list-pcsx2-games` IPC calls it with ONE ARGUMENT (`main.js`) — this warms up the cache.
    assert.equal(findInstalledGamesCached(configRoot).length, 1);

    fs.rmSync(isoPath);
    // The `fetchPcsx2Recent` thunk in `main.js` also passes `undefined` for homeDir — if it did NOT
    // hit the same cache entry, it would scan fresh (empty) here.
    const stillCached = findRecentlyPlayed(configRoot, undefined, 5);
    assert.equal(stillCached.length, 1, 'the production call mode reads from the SHARED cache too');

    findInstalledGamesCached.invalidate();
});

test('ps2CoverUrl — serial -> xlenore/ps2-covers URL, segment-encoded', () => {
    assert.equal(
        ps2CoverUrl('SCUS-97472'),
        'https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/SCUS-97472.jpg',
    );
});

test('pcsx2CoverPath / resolvePcsx2Cover — returns only a file that actually exists on disk', () => {
    return withTempHome(() => {
        assert.equal(resolvePcsx2Cover('SCUS-97472'), null);
        const dest = pcsx2CoverPath('SCUS-97472');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'jpeg-bytes');
        assert.equal(resolvePcsx2Cover('SCUS-97472'), dest);
        assert.equal(resolvePcsx2Cover(null), null);
    }, 'gl-pcsx2-home-');
});

test('ensurePcsx2Covers — downloads only the entry without a cover that carries a serial, cover in place', async () => {
    return withTempHome(async () => {
        const calls = [];
        const entries = [
            { name: 'Already has', cover: '/already/there.jpg', params: { serial: 'AAAA-00000' } },
            { name: 'Needs a cover', cover: null, params: { serial: 'SCUS-97472' } },
            { name: 'No serial', cover: null, params: {} },
        ];
        const download = async (url, dest) => { calls.push({ url, dest }); return true; };

        const n = await ensurePcsx2Covers(entries, { download });

        assert.equal(n, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, ps2CoverUrl('SCUS-97472'));
        assert.equal(entries[1].cover, calls[0].dest);
        assert.equal(entries[2].cover, null);
    }, 'gl-pcsx2-home-');
});

test('ensurePcsx2Covers — a failed download does not set the cover, does not throw', async () => {
    return withTempHome(async () => {
        const entries = [{ name: 'X', cover: null, params: { serial: 'FFFF-00000' } }];
        const n = await ensurePcsx2Covers(entries, { download: async () => false });
        assert.equal(n, 0);
        assert.equal(entries[0].cover, null);
    }, 'gl-pcsx2-home-');
});

// The launch argument list (the descriptor's `launch.args`, lib/launchers/emulator-sources.js).
test('pcsx2GameArgs — flatpak run PCSX2 <discPath>', () => {
    assert.deepEqual(pcsx2GameArgs('/roms/ps2/game.iso'), ['run', 'net.pcsx2.PCSX2', '/roms/ps2/game.iso']);
});
