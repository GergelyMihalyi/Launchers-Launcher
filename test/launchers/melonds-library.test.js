'use strict';

// lib/launchers/melonds-library.js — melonDS (Nintendo DS/DSi) ROM discovery.
// The ROM header + 32×32 4bpp icon decoding follows the byte layout verified on a REAL .nds ROM
// on the machine (with hexdump AND by rendering the decoded icon to PNG and checking it
// visually); the zip reader was verified byte-identical on a REAL user zip ROM (from melonDS's
// OWN `RecentROM`) against the reference unpacked with `unzip` — covered here with synthetic fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, withTempHome } = require('../helpers/fs.js');
const { inflatePngPixels, buildFakeZip } = require('../helpers/fixtures.js');
const { findEndOfCentralDirectory, parseCentralDirectory } = require('../../lib/launchers/shared/zip-reader.js');
const {
    parseTomlString, parseTomlStringArray, parseRecentEntry,
    readGameDirs, listZipRomEntries,
    listZipRomEntriesFromFile, parseNdsHeader, decodeNdsIcon, extractNdsMetaFromBuffer,
    extractNdsMetaFromFile, extractNdsMetaFromZipEntry, melondsGameLabel, melondsGameId,
    findInstalledGames, melondsCoverPath, resolveMelondsCover, ensureMelondsCover,
    melondsGameArgs,
} = require('../../lib/launchers/melonds-library.js');

// --- NDS header + icon/title block synthetic fixture (GBATEK layout, see the header comment) ---

function packBgr555(r, g, b) {
    return (r & 0x1f) | ((g & 0x1f) << 5) | ((b & 0x1f) << 10);
}

function buildFakeNds({
    title = 'GAME TITLE', gamecode = 'ABCD', iconOffset = 0x200,
    bitmap = Buffer.alloc(0x200), palette = Buffer.alloc(0x20), englishTitle = 'Fake Game',
} = {}) {
    const size = iconOffset + 0x340 + 0x100;
    const buf = Buffer.alloc(size);
    Buffer.from(title, 'ascii').copy(buf, 0, 0, 12);
    Buffer.from(gamecode, 'ascii').copy(buf, 0x0c, 0, 4);
    buf.writeUInt32LE(iconOffset, 0x68);
    bitmap.copy(buf, iconOffset + 0x20);
    palette.copy(buf, iconOffset + 0x220);
    const titleBuf = Buffer.from(englishTitle, 'utf16le');
    titleBuf.copy(buf, iconOffset + 0x340, 0, Math.min(titleBuf.length, 0x100 - 2));
    return buf;
}

test('parseNdsHeader — title @0x00, gamecode @0x0C, icon offset @0x68 (LE)', () => {
    const buf = buildFakeNds({ title: 'DRAGONBALLZ2', gamecode: 'A2SE', iconOffset: 0x102600 });
    assert.deepEqual(parseNdsHeader(buf), { title: 'DRAGONBALLZ2', gamecode: 'A2SE', iconOffset: 0x102600 });
});

test('parseNdsHeader — too short buffer / unrealistic icon offset -> null', () => {
    assert.equal(parseNdsHeader(Buffer.alloc(10)), null);
    const buf = Buffer.alloc(0x70);
    buf.writeUInt32LE(0, 0x68); // 0 = no offset
    assert.equal(parseNdsHeader(buf), null);
});

test('decodeNdsIcon — nibble order (low = left pixel) + tile layout (4x4, row-major)', () => {
    const palette = Buffer.alloc(0x20);
    // index 1 = red, index 2 = green (index 0 stays black/transparent per the GBATEK convention).
    palette.writeUInt16LE(packBgr555(31, 0, 0), 1 * 2);
    palette.writeUInt16LE(packBgr555(0, 31, 0), 2 * 2);

    const bitmap = Buffer.alloc(0x200);
    // First byte of the first tile (ty=0,tx=0): low nibble = pixel(0,0), high nibble = pixel(1,0).
    bitmap[0] = 0x21; // low=1 (red) -> (0,0); high=2 (green) -> (1,0)
    // The first byte of the last tile (ty=3,tx=3, byte 15*32=480) gives the tile's (24,24) corner.
    bitmap[480] = 0x12; // low=2 (green) -> (24,24); high=1 (red) -> (25,24)

    const decoded = decodeNdsIcon(bitmap, palette);
    assert.equal(decoded.width, 32);
    assert.equal(decoded.height, 32);
    const px = (x, y) => {
        const d = (y * 32 + x) * 4;
        return [decoded.pixels[d], decoded.pixels[d + 1], decoded.pixels[d + 2], decoded.pixels[d + 3]];
    };
    assert.deepEqual(px(0, 0), [255, 0, 0, 255]); // red
    assert.deepEqual(px(1, 0), [0, 255, 0, 255]); // green
    assert.deepEqual(px(2, 0), [0, 0, 0, 0]); // index 0 -> transparent
    assert.deepEqual(px(24, 24), [0, 255, 0, 255]); // corner of the last tile -> green
    assert.deepEqual(px(25, 24), [255, 0, 0, 255]); // -> red
});

test('decodeNdsIcon — too short bitmap/palette -> null, does not throw', () => {
    assert.equal(decodeNdsIcon(Buffer.alloc(10), Buffer.alloc(0x20)), null);
    assert.equal(decodeNdsIcon(Buffer.alloc(0x200), Buffer.alloc(5)), null);
});

test('extractNdsMetaFromBuffer / extractNdsMetaFromFile — header + English title (multi-line -> first line) + icon', () => {
    const buf = buildFakeNds({ title: 'FAKEGAME', gamecode: 'FAKE', englishTitle: 'Fake Game\nSubtitle' });
    const meta = extractNdsMetaFromBuffer(buf);
    assert.equal(meta.header.gamecode, 'FAKE');
    assert.equal(meta.title, 'Fake Game');
    assert.ok(meta.icon);
    assert.equal(meta.icon.width, 32);

    const dir = tmpDir('gl-melonds-file-');
    const p = path.join(dir, 'game.nds');
    fs.writeFileSync(p, buf);
    const metaFromFile = extractNdsMetaFromFile(p);
    assert.equal(metaFromFile.header.gamecode, 'FAKE');
    assert.equal(metaFromFile.title, 'Fake Game');
});

test('extractNdsMetaFromFile — nonexistent file / too short content -> null, does not throw', () => {
    assert.equal(extractNdsMetaFromFile('/does/not/exist.nds'), null);
    const dir = tmpDir('gl-melonds-bad-');
    const p = path.join(dir, 'short.nds');
    fs.writeFileSync(p, Buffer.alloc(5));
    assert.equal(extractNdsMetaFromFile(p), null);
});

// --- melonDS.toml minimal reader ---

test('parseTomlString / parseTomlStringArray — single-line string or string array key', () => {
    const toml = [
        'LastROMFolder = "/home/user/ROMs/NDS"',
        'LastBIOSFolder = ""',
        'RecentROM = ["/a/b.nds", "/a/c.zip|inner.nds"]',
    ].join('\n');
    assert.equal(parseTomlString(toml, 'LastROMFolder'), '/home/user/ROMs/NDS');
    assert.equal(parseTomlString(toml, 'LastBIOSFolder'), '');
    assert.equal(parseTomlString(toml, 'Missing'), null);
    assert.deepEqual(parseTomlStringArray(toml, 'RecentROM'), ['/a/b.nds', '/a/c.zip|inner.nds']);
    assert.deepEqual(parseTomlStringArray(toml, 'Missing'), []);
});

test('parseRecentEntry — plain path OR <archive>|<inner file name>', () => {
    assert.deepEqual(parseRecentEntry('/a/b.nds'), { path: '/a/b.nds', archiveEntry: null });
    assert.deepEqual(parseRecentEntry('/a/c.zip|inner.nds'), { path: '/a/c.zip', archiveEntry: 'inner.nds' });
});

test('readGameDirs — union of auto-derive (LastROMFolder + parent folders of RecentROM) + the manual melondsRomDirs, deduped', () => {
    const configRoot = tmpDir('gl-melonds-cfg-');
    const lastFolder = tmpDir('gl-melonds-last-');
    const recentFolder = tmpDir('gl-melonds-recent-');
    const manualFolder = tmpDir('gl-melonds-manual-');
    fs.writeFileSync(path.join(configRoot, 'melonDS.toml'), [
        `LastROMFolder = "${lastFolder}"`,
        `RecentROM = ["${path.join(recentFolder, 'game.zip')}|inner.nds", "/does/not/exist/x.nds"]`,
    ].join('\n'));
    const dirs = readGameDirs(configRoot, [manualFolder, lastFolder]); // lastFolder duplicated -> dedup
    assert.deepEqual(new Set(dirs), new Set([lastFolder, recentFolder, manualFolder]));
});

test('readGameDirs — missing melonDS.toml -> only the manual folders (they exist), never throws', () => {
    const configRoot = tmpDir('gl-melonds-cfg-');
    const manualFolder = tmpDir('gl-melonds-manual-');
    assert.deepEqual(readGameDirs(configRoot, [manualFolder, '/does/not/exist']), [manualFolder]);
    assert.deepEqual(readGameDirs(configRoot, []), []);
});

// --- Zip archive ROMs (on the shared lib/launchers/shared/zip-reader.js) ---

// (the `buildFakeZip` fixture + the shared reader's test: test/helpers/fixtures.js, test/launchers/shared/zip-reader.test.js)

test('listZipRomEntries — returns only the entries with a ROM extension (other files in the zip are skipped)', () => {
    const zip = buildFakeZip([
        { name: 'game.nds', data: Buffer.from('rom'), method: 0 },
        { name: 'readme.txt', data: Buffer.from('info'), method: 0 },
    ]);
    const entries = listZipRomEntries(zip);
    assert.deepEqual(entries.map((e) => e.name), ['game.nds']);
});

test('listZipRomEntriesFromFile — returns the same as the buffer-based listZipRomEntries, from a real file, positioned', () => {
    const dir = tmpDir('gl-melonds-zipfile-');
    const zipBuf = buildFakeZip([
        { name: 'a.nds', data: Buffer.from('sima ROM'), method: 0 },
        { name: 'b.nds', data: Buffer.alloc(2000, 7), method: 8 },
        { name: 'readme.txt', data: Buffer.from('info'), method: 0 },
    ]);
    const zipPath = path.join(dir, 'multi.zip');
    fs.writeFileSync(zipPath, zipBuf);
    const fromFile = listZipRomEntriesFromFile(zipPath);
    const fromBuf = listZipRomEntries(zipBuf);
    assert.deepEqual(fromFile.map((e) => e.name), fromBuf.map((e) => e.name));
    assert.deepEqual(fromFile.map((e) => e.localHeaderOffset), fromBuf.map((e) => e.localHeaderOffset));
});

test('listZipRomEntriesFromFile — nonexistent file -> empty list, does not throw', () => {
    assert.deepEqual(listZipRomEntriesFromFile('/does/not/exist/x.zip'), []);
});

// In production the launcher froze when opening a network (NFS) ROM folder: both the zip
// listing AND the header extraction read the WHOLE (even 100+ MB) file with
// `fs.readFileSync`, TWICE per entry. This test packs a ROM padded with a LARGE (>1 MB),
// well-compressible "filler", and measures the total bytes passing through `fs.readSync` —
// it would catch a regression if someone restored whole-file reading.
test('extractNdsMetaFromZipEntry — does not read the whole file even for a large compressed entry (positioned prefix read)', () => {
    const dir = tmpDir('gl-melonds-bigzip-');
    const rom = buildFakeNds({ title: 'BIG GAME', gamecode: 'BIGG', englishTitle: 'Big Game' });
    // Random (incompressible) filler, so the zip REALLY stays large on disk too
    // (a homogeneous filler would shrink to a few KB under deflate, defeating the test's purpose).
    const filler = require('crypto').randomBytes(6 * 1024 * 1024);
    const bigRom = Buffer.concat([rom, filler]);
    const zipPath = path.join(dir, 'big.zip');
    fs.writeFileSync(zipPath, buildFakeZip([{ name: 'big.nds', data: bigRom, method: 8 }]));

    const zipBuf = fs.readFileSync(zipPath);
    const eocd = findEndOfCentralDirectory(zipBuf);
    const entries = parseCentralDirectory(zipBuf, eocd);
    const stat = fs.statSync(zipPath);
    assert.ok(stat.size > 1024 * 1024, 'the test fixture must actually be large');

    let totalRead = 0;
    const origReadSync = fs.readSync;
    fs.readSync = (...args) => {
        const n = origReadSync.apply(fs, args);
        totalRead += n;
        return n;
    };
    let meta;
    try {
        meta = extractNdsMetaFromZipEntry(zipPath, entries[0]);
    } finally {
        fs.readSync = origReadSync;
    }

    assert.equal(meta.header.gamecode, 'BIGG');
    assert.equal(meta.title, 'Big Game');
    assert.ok(meta.icon);
    assert.ok(totalRead < 1024 * 1024, `read too many bytes (${totalRead} / file size ${stat.size})`);
});

// --- Title/id helpers ---

test('melondsGameLabel — extension stripped, _/. -> space', () => {
    assert.equal(melondsGameLabel('Some_Game_Name.nds'), 'Some Game Name');
    assert.equal(melondsGameLabel('Another.Game.zip'), 'Another Game');
});

test('melondsGameId — the gamecode if present, otherwise a path(+archiveEntry)-hash substitute', () => {
    assert.equal(melondsGameId('A2SE', '/roms/x.nds', null), 'A2SE');
    assert.match(melondsGameId(null, '/roms/x.nds', null), /^p:[0-9a-f]{16}$/);
    // same zip, different inner file -> different id (no collision)
    const id1 = melondsGameId(null, '/roms/collection.zip', 'a.nds');
    const id2 = melondsGameId(null, '/roms/collection.zip', 'b.nds');
    assert.notEqual(id1, id2);
});

// --- findInstalledGames: a plain ROM + a zip archive in one scan folder ---

test('findInstalledGames — plain .nds with header + a ROM extracted from a zip archive, sorted, dedup', () => {
    return withTempHome(() => {
        const configRoot = tmpDir('gl-melonds-cfg-');
        const romsDir = tmpDir('gl-melonds-roms-');

        fs.writeFileSync(path.join(romsDir, 'zelda.nds'), buildFakeNds({
            title: 'ZELDA', gamecode: 'AZDE', englishTitle: 'Zelda Phantom Hourglass',
        }));
        const zipRom = buildFakeNds({ title: 'MARIO', gamecode: 'AMKE', englishTitle: 'Mario Kart DS' });
        fs.writeFileSync(path.join(romsDir, 'collection.zip'), buildFakeZip([
            { name: 'mario.nds', data: zipRom, method: 8 },
        ]));
        // Unknown header (corrupt ROM) -> fallback title from the file name + path-hash id.
        fs.writeFileSync(path.join(romsDir, 'Broken Game.nds'), Buffer.from('not a real ROM'));

        const games = findInstalledGames(configRoot, [romsDir]);
        assert.equal(games.length, 3);
        const byId = Object.fromEntries(games.map((g) => [g.id, g]));
        assert.equal(byId.AZDE.name, 'Zelda Phantom Hourglass');
        assert.equal(byId.AZDE.archiveEntry, null);
        assert.ok(byId.AZDE.cover); // the icon decodes -> local PNG cache
        assert.equal(byId.AMKE.name, 'Mario Kart DS');
        assert.equal(byId.AMKE.archiveEntry, 'mario.nds');
        assert.equal(byId.AMKE.path, path.join(romsDir, 'collection.zip'));
        const broken = games.find((g) => g.path.endsWith('Broken Game.nds'));
        assert.equal(broken.name, 'Broken Game');
        assert.equal(broken.gamecode, null);
        assert.match(broken.id, /^p:[0-9a-f]{16}$/);
    }, 'gl-melonds-home-');
});

test('findInstalledGames — no scan folder (empty melonDS.toml, no manual folder) -> empty list, never throws', () => {
    const configRoot = tmpDir('gl-melonds-cfg-');
    assert.deepEqual(findInstalledGames(configRoot, []), []);
});

// In production the "Games" panel re-read/decoded the whole collection on EVERY open of a
// ~140-zip ROM collection on an NFS network (the 60 s result cache of `createTtlCache` only
// covered openings within a minute). This test calls `findInstalledGames` twice on an
// unchanged ROM folder, and on the SECOND call monkey-patches `fs.openSync` to check that for
// unchanged files the module opens no file again (only the `fs.statSync`-based signature check
// runs) — it would catch a regression if the persistent file cache disappeared/broke.
test('findInstalledGames — persistent file cache: an unchanged ROM/zip does not open the file again on the second call', () => {
    return withTempHome(() => {
        const configRoot = tmpDir('gl-melonds-cfg-');
        const romsDir = tmpDir('gl-melonds-roms-');

        fs.writeFileSync(path.join(romsDir, 'zelda.nds'), buildFakeNds({
            title: 'ZELDA', gamecode: 'AZDE', englishTitle: 'Zelda Phantom Hourglass',
        }));
        const zipRom = buildFakeNds({ title: 'MARIO', gamecode: 'AMKE', englishTitle: 'Mario Kart DS' });
        fs.writeFileSync(path.join(romsDir, 'collection.zip'), buildFakeZip([
            { name: 'mario.nds', data: zipRom, method: 8 },
        ]));

        const first = findInstalledGames(configRoot, [romsDir]);
        assert.equal(first.length, 2);

        let openCalls = 0;
        const origOpenSync = fs.openSync;
        fs.openSync = (...args) => {
            openCalls += 1;
            return origOpenSync.apply(fs, args);
        };
        let second;
        try {
            second = findInstalledGames(configRoot, [romsDir]);
        } finally {
            fs.openSync = origOpenSync;
        }

        assert.deepEqual(second.map((g) => g.id).sort(), first.map((g) => g.id).sort());
        assert.equal(openCalls, 0, `fs.openSync should not be called for unchanged files (${openCalls} calls happened)`);

        // A MODIFIED (larger) file, however, is really reprocessed, with fresh
        // content — the cache's mtime+size signature correctly detects the change.
        fs.writeFileSync(path.join(romsDir, 'zelda.nds'), buildFakeNds({
            title: 'ZELDA2', gamecode: 'BZDE', englishTitle: 'Zelda: A Link Between Worlds',
        }));
        const third = findInstalledGames(configRoot, [romsDir]);
        const byId = Object.fromEntries(third.map((g) => [g.id, g]));
        assert.ok(byId.BZDE);
        assert.equal(byId.BZDE.name, 'Zelda: A Link Between Worlds');
        assert.ok(!byId.AZDE, 'the old gamecode should not remain');
    }, 'gl-melonds-home-');
});

// --- Cover image: local icon decoding -> PNG, no network ---

test('resolveMelondsCover / ensureMelondsCover — self-healing disk cache, the PNG can be decoded back pixel-exactly', () => {
    return withTempHome(() => {
        assert.equal(resolveMelondsCover('A2SE'), null);
        assert.equal(resolveMelondsCover(null), null);

        const palette = Buffer.alloc(0x20);
        palette.writeUInt16LE(packBgr555(31, 0, 0), 1 * 2); // index 1 = red
        const bitmap = Buffer.alloc(0x200);
        bitmap[0] = 0x01; // pixel(0,0) = index 1 (red)
        const icon = decodeNdsIcon(bitmap, palette);

        const dest = ensureMelondsCover('A2SE', icon);
        assert.equal(dest, melondsCoverPath('A2SE'));
        assert.equal(resolveMelondsCover('A2SE'), dest);

        // The PNG decoded back pixel-exactly: pixel(0,0) = the red palette color, fully opaque.
        const pixels = inflatePngPixels(fs.readFileSync(dest), 32, 32);
        assert.deepEqual([...pixels.subarray(0, 4)], [255, 0, 0, 255]);

        // self-healing: a second call does not rewrite (it returns the existing file).
        assert.equal(ensureMelondsCover('A2SE', icon), dest);
    }, 'gl-melonds-home-');
});

test('ensureMelondsCover — missing id or icon -> null, does not throw', () => {
    assert.equal(ensureMelondsCover(null, { width: 32, height: 32, pixels: Buffer.alloc(32 * 32 * 4) }), null);
    assert.equal(ensureMelondsCover('X', null), null);
});

// The launch argument list (the descriptor's `launch.args`, lib/launchers/emulator-sources.js).
test('melondsGameArgs — flatpak run melonDS --fullscreen <rom>, -a <inner file name> ONLY for a zip', () => {
    assert.deepEqual(melondsGameArgs('/roms/nds/game.nds'), [
        'run', 'net.kuribo64.melonDS', '--fullscreen', '/roms/nds/game.nds',
    ]);
    assert.deepEqual(melondsGameArgs('/roms/nds/game.zip', 'game.nds'), [
        'run', 'net.kuribo64.melonDS', '--fullscreen', '-a', 'game.nds', '/roms/nds/game.zip',
    ]);
});
