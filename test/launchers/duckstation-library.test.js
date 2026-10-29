'use strict';

// lib/launchers/duckstation-library.js — DuckStation (PS1) disc-image discovery.
// Serial extraction is a REAL ISO9660 traversal
// (PVD -> root-directory extent -> SYSTEM.CNF entry -> content), for TWO possible
// disc-image geometries: plain 2048 bytes/sector (`.iso`, as with PCSX2) AND raw 2352
// bytes/sector, Mode2/Form1 (`.bin`, the vast majority of the user's collection — per the `.cue`
// `TRACK 01 MODE2/2352` line). `buildFakeRawBin` (-> `buildFakeIso` in `test/helpers/fixtures.js`,
// `rawSectors`) follows the geometry measured on the machine (verified with hexdump: PVD in
// logical sector 16, data offset 24 bytes inside the raw sector).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, withTempHome } = require('../helpers/fs.js');
const { buildFakeIso, serialToBootLine } = require('../helpers/fixtures.js');
const {
    readGameDirs, extractSerialFromDisc, resolveCueDataFile, duckstationGameLabel, duckstationGameId, findInstalledGames,
    recentFromGames, duckstationCoverPath, resolveDuckstationCover,
    duckstationThumbnailUrl, ensureDuckstationCovers,
    duckstationGameArgs,
} = require('../../lib/launchers/duckstation-library.js');

// A PS1 disc image (a SYSTEM.CNF in the root only), either a plain 2048 bytes/sector `.iso` OR
// a raw 2352 bytes/sector (Mode2/Form1) `.bin`, which makes up most of the user's collection.
function buildPs1Disc({ cnfText, noMagic = false, noSystemCnf = false } = {}, rawSectors = false) {
    return buildFakeIso(noSystemCnf ? {} : { 'SYSTEM.CNF': cnfText }, { noMagic, rawSectors });
}
const buildFakePlainIso = (opts) => buildPs1Disc(opts, false);
const buildFakeRawBin = (opts) => buildPs1Disc(opts, true);

test('readGameDirs — reads settings.ini (NOT under inis/, like PCSX2), only existing folders, deduped', () => {
    const configRoot = tmpDir('gl-ds-cfg-');
    const romsDir = tmpDir('gl-ds-roms-');
    fs.writeFileSync(path.join(configRoot, 'settings.ini'), [
        '[GameList]',
        `RecursivePaths = ${romsDir}`,
        `RecursivePaths = ${romsDir}`, // duplicate -> dedup
        'RecursivePaths = /does/not/exist/somewhere',
        '',
    ].join('\n'));
    assert.deepEqual(readGameDirs(configRoot), [romsDir]);
});

test('readGameDirs — an empty list for a missing settings.ini, does not throw', () => {
    assert.deepEqual(readGameDirs(tmpDir('gl-ds-cfg-')), []);
});

test('resolveCueDataFile — the first FILE "..." line relative to the directory of the .cue, only for an existing file', () => {
    const dir = tmpDir('gl-ds-cue-');
    fs.writeFileSync(path.join(dir, 'game.bin'), 'x');
    fs.writeFileSync(path.join(dir, 'game.cue'), [
        'FILE "game.bin" BINARY',
        '  TRACK 01 MODE2/2352',
        '    INDEX 01 00:00:00',
    ].join('\n'));
    assert.equal(resolveCueDataFile(path.join(dir, 'game.cue')), path.join(dir, 'game.bin'));
});

test('resolveCueDataFile — the referenced file does not exist (broken cue/bin pairing) -> null', () => {
    const dir = tmpDir('gl-ds-cue-');
    fs.writeFileSync(path.join(dir, 'game.cue'), 'FILE "Image.bin" BINARY\n  TRACK 01 MODE2/2352\n');
    assert.equal(resolveCueDataFile(path.join(dir, 'game.cue')), null);
});

test('resolveCueDataFile — no FILE line / nonexistent .cue -> null', () => {
    const dir = tmpDir('gl-ds-cue-');
    fs.writeFileSync(path.join(dir, 'empty.cue'), 'REM comment only\n');
    assert.equal(resolveCueDataFile(path.join(dir, 'empty.cue')), null);
    assert.equal(resolveCueDataFile(path.join(dir, 'no-such.cue')), null);
});

test('extractSerialFromDisc — plain 2048 bytes/sector .iso (the PCSX2 format)', () => {
    const dir = tmpDir('gl-ds-disc-');
    const p = path.join(dir, 'game.iso');
    fs.writeFileSync(p, buildFakePlainIso({ cnfText: serialToBootLine('SCES-01420') }));
    assert.equal(extractSerialFromDisc(p), 'SCES-01420');
});

test('extractSerialFromDisc — raw 2352 bytes/sector .bin, Mode2/Form1 (the format of the user\'s collection)', () => {
    const dir = tmpDir('gl-ds-disc-');
    const p = path.join(dir, 'game.bin');
    fs.writeFileSync(p, buildFakeRawBin({ cnfText: serialToBootLine('SLUS-00821') }));
    assert.equal(extractSerialFromDisc(p), 'SLUS-00821');
});

// Case found in production (the user's "Tekken 3" disc): the boot file is in a subdirectory
// (`BOOT = cdrom:\TEKKEN3\SLUS_004.02;1`) — the naive "directly in the root" assumption would
// have turned this into null.
test('extractSerialFromDisc — the boot file is in a subdirectory (BOOT = cdrom:\\<folder>\\<exe>;1)', () => {
    const dir = tmpDir('gl-ds-disc-');
    const p = path.join(dir, 'game.bin');
    fs.writeFileSync(p, buildFakeRawBin({ cnfText: serialToBootLine('SLUS-00402', { subdir: 'TEKKEN3' }) }));
    assert.equal(extractSerialFromDisc(p), 'SLUS-00402');
});

test('extractSerialFromDisc — no CD001 magic in either geometry -> null', () => {
    const dir = tmpDir('gl-ds-disc-');
    const p = path.join(dir, 'game.bin');
    fs.writeFileSync(p, buildFakeRawBin({ cnfText: serialToBootLine('SLUS-00821'), noMagic: true }));
    assert.equal(extractSerialFromDisc(p), null);
});

test('extractSerialFromDisc — no SYSTEM.CNF entry in the root directory -> null', () => {
    const dir = tmpDir('gl-ds-disc-');
    const p = path.join(dir, 'game.bin');
    fs.writeFileSync(p, buildFakeRawBin({ noSystemCnf: true }));
    assert.equal(extractSerialFromDisc(p), null);
});

test('extractSerialFromDisc — SYSTEM.CNF is present, but no BOOT line -> null', () => {
    const dir = tmpDir('gl-ds-disc-');
    const p = path.join(dir, 'game.bin');
    fs.writeFileSync(p, buildFakeRawBin({ cnfText: 'TCB = 4\r\n' }));
    assert.equal(extractSerialFromDisc(p), null);
});

test('extractSerialFromDisc — compressed/unknown container (e.g. PSX2PSP .pbp) -> null, does not throw', () => {
    const dir = tmpDir('gl-ds-disc-');
    const p = path.join(dir, 'game.pbp');
    fs.writeFileSync(p, Buffer.from('\0PBP' + 'x'.repeat(5000)));
    assert.equal(extractSerialFromDisc(p), null);
});

test('extractSerialFromDisc — nonexistent file -> null, does not throw', () => {
    assert.equal(extractSerialFromDisc('/does/not/exist/game.bin'), null);
});

test('duckstationGameLabel — extension stripped, _/. -> space', () => {
    assert.equal(duckstationGameLabel('Street_Fighter_Alpha_3.cue'), 'Street Fighter Alpha 3');
    assert.equal(duckstationGameLabel('Vagrant.Story.USA.pbp'), 'Vagrant Story USA');
});

test('duckstationGameId — the serial if present; otherwise a stable path-hash substitute', () => {
    assert.equal(duckstationGameId('SLUS-00821', '/roms/x.cue'), 'SLUS-00821');
    const id = duckstationGameId(null, '/roms/no-serial.pbp');
    assert.match(id, /^p:[0-9a-f]{16}$/);
    assert.equal(duckstationGameId(null, '/roms/no-serial.pbp'), id); // deterministic
});

test('findInstalledGames — walking the [GameList] folders, .cue scanned through the referenced .bin + playtime, a bare .bin is skipped', () => {
    const configRoot = tmpDir('gl-ds-cfg-');
    const romsDir = tmpDir('gl-ds-roms-');
    const fakeHome = tmpDir('gl-ds-home-'); // no flatpak install -> gamedb not found
    fs.writeFileSync(path.join(configRoot, 'settings.ini'), `[GameList]\nRecursivePaths = ${romsDir}\n`);
    fs.writeFileSync(path.join(configRoot, 'playtime.dat'), 'SLUS-00821  82  1700000000\n');

    const dir1 = path.join(romsDir, 'Game One');
    fs.mkdirSync(dir1);
    fs.writeFileSync(path.join(dir1, 'Game One.bin'), buildFakeRawBin({ cnfText: serialToBootLine('SLUS-00821') }));
    fs.writeFileSync(path.join(dir1, 'Game One.cue'), 'FILE "Game One.bin" BINARY\n  TRACK 01 MODE2/2352\n');

    const dir2 = path.join(romsDir, 'Game Two');
    fs.mkdirSync(dir2);
    // The .cue refers to "Missing.bin", which is NOT in the folder (a broken cue/bin
    // pairing, cf. the user's "Worms Armageddon" disc) -> no serial can be extracted.
    fs.writeFileSync(path.join(dir2, 'Missing.bin'), buildFakeRawBin({ cnfText: serialToBootLine('ZZZZ-00000') }));
    fs.writeFileSync(path.join(dir2, 'Game Two.cue'), 'FILE "Nope.bin" BINARY\n  TRACK 01 MODE2/2352\n');

    // A bare .bin WITHOUT a .cue -> INTENTIONALLY skipped (no .cue/.chd/.pbp/.iso extension).
    fs.writeFileSync(path.join(romsDir, 'orphan.bin'), 'not a disc-image extension in the scan whitelist');
    fs.writeFileSync(path.join(romsDir, 'readme.txt'), 'not a disc image');

    const games = findInstalledGames(configRoot, fakeHome);
    const names = games.map((g) => g.name).sort();
    assert.deepEqual(names, ['Game One', 'Game Two']);

    const one = games.find((g) => g.name === 'Game One');
    assert.equal(one.serial, 'SLUS-00821');
    assert.equal(one.id, 'SLUS-00821');
    assert.equal(one.lastPlayedAt, 1700000000000);
    assert.match(one.path, /Game One\.cue$/); // the .cue stays the `path` — the DuckStation CLI expects it

    const two = games.find((g) => g.name === 'Game Two');
    assert.equal(two.serial, null);
    assert.equal(two.lastPlayedAt, null);
    assert.match(two.id, /^p:[0-9a-f]{16}$/);
});

test('findInstalledGames — empty list for an empty/missing [GameList]', () => {
    const configRoot = tmpDir('gl-ds-cfg-');
    assert.deepEqual(findInstalledGames(configRoot, configRoot), []);
});

test('recentFromGames — descending by lastPlayedAt, cut to max, recentGames shape', () => {
    const configRoot = tmpDir('gl-ds-cfg-');
    const romsDir = tmpDir('gl-ds-roms-');
    const fakeHome = tmpDir('gl-ds-home-');
    fs.writeFileSync(path.join(configRoot, 'settings.ini'), `[GameList]\nRecursivePaths = ${romsDir}\n`);
    fs.writeFileSync(path.join(configRoot, 'playtime.dat'), [
        'AAAA-11111  10  1600000000',
        'BBBB-22222  20  1700000000',
    ].join('\n'));

    for (const [name, serial] of [['Old', 'AAAA-11111'], ['New', 'BBBB-22222'], ['NeverPlayed', 'CCCC-33333']]) {
        const dir = path.join(romsDir, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, `${name}.bin`), buildFakeRawBin({ cnfText: serialToBootLine(serial) }));
        fs.writeFileSync(path.join(dir, `${name}.cue`), `FILE "${name}.bin" BINARY\n  TRACK 01 MODE2/2352\n`);
    }

    const games = findInstalledGames(configRoot, fakeHome);
    const recent = recentFromGames(games, 5);
    assert.deepEqual(recent.map((r) => r.key), ['duckstation-game-BBBB-22222', 'duckstation-game-AAAA-11111']);
    assert.equal(recent[0].kind, 'duckstation');
    assert.equal(recent[0].params.serial, 'BBBB-22222');
    assert.match(recent[0].params.path, /New\.cue$/);
    // ⚠️ Must be an ISO 8601 STRING, NOT the raw ms-epoch number — in production this made the
    // DuckStation games vanish entirely from the merged "Continue"/"Recently played"
    // lists: mergeRecentGameLists() in lib/recent/usage.js calls Date.parse() on
    // lastLaunchedAt, which gives NaN for a raw number (score 0 -> it would drop to the end of the
    // list, which would have fit, BUT the other ~10 sources had already filled the max before it).
    assert.equal(recent[0].lastLaunchedAt, new Date(1700000000000).toISOString());
    assert.equal(Number.isNaN(Date.parse(recent[0].lastLaunchedAt)), false);

    assert.equal(recentFromGames(games, 1).length, 1);
});

test('duckstationThumbnailUrl — the "Sony - PlayStation" system of the libretro thumbnail server, title-based', () => {
    assert.equal(
        duckstationThumbnailUrl('Crash Bandicoot 3 - Warped (Europe) (En,Fr,De,Es,It)'),
        'https://thumbnails.libretro.com/Sony%20-%20PlayStation/Named_Boxarts/'
        + 'Crash%20Bandicoot%203%20-%20Warped%20(Europe)%20(En%2CFr%2CDe%2CEs%2CIt).png',
    );
});

test('duckstationCoverPath / resolveDuckstationCover — returns only a file that actually exists on disk', () => {
    return withTempHome(() => {
        assert.equal(resolveDuckstationCover('SLUS-00821'), null);
        const dest = duckstationCoverPath('SLUS-00821');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'png-bytes');
        assert.equal(resolveDuckstationCover('SLUS-00821'), dest);
        assert.equal(resolveDuckstationCover(null), null);
    }, 'gl-ds-home-');
});

test('ensureDuckstationCovers — downloads only the entry without a cover that carries serial+name, cover in place', async () => {
    return withTempHome(async () => {
        const calls = [];
        const entries = [
            { name: 'Already has', cover: '/already/there.png', params: { serial: 'AAAA-00000' } },
            { name: 'Street Fighter Alpha 3 (USA)', cover: null, params: { serial: 'SLUS-00821' } },
            { name: 'No serial', cover: null, params: {} },
        ];
        const download = async (url, dest) => { calls.push({ url, dest }); return true; };

        const n = await ensureDuckstationCovers(entries, { download });

        assert.equal(n, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, duckstationThumbnailUrl('Street Fighter Alpha 3 (USA)'));
        assert.equal(entries[1].cover, calls[0].dest);
        assert.equal(entries[2].cover, null);
    }, 'gl-ds-home-');
});

test('ensureDuckstationCovers — a failed download does not set the cover, does not throw', async () => {
    return withTempHome(async () => {
        const entries = [{ name: 'X', cover: null, params: { serial: 'FFFF-00000' } }];
        const n = await ensureDuckstationCovers(entries, { download: async () => false });
        assert.equal(n, 0);
        assert.equal(entries[0].cover, null);
    }, 'gl-ds-home-');
});

// The launch argument list (the descriptor's `launch.args`, lib/launchers/emulator-sources.js).
// `-batch` — a bug fixed in production: without it, on closing the game DuckStation stayed in
// its own main menu, the process did not exit, and the launcher never got control back.
// See the comment of `duckstationGameArgs`.
test('duckstationGameArgs — flatpak run DuckStation -fullscreen -batch -- <discPath>', () => {
    assert.deepEqual(duckstationGameArgs('/roms/ps1/Street Fighter Alpha 3 (USA).cue'), [
        'run', 'org.duckstation.DuckStation', '-fullscreen', '-batch', '--', '/roms/ps1/Street Fighter Alpha 3 (USA).cue',
    ]);
});
