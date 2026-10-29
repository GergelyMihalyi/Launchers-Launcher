'use strict';

// lib/launchers/cemu-library.js — Cemu (Wii U) installed-game discovery.
// The `settings.xml`/`meta.xml` sample texts follow the shape of the content actually found on
// the machine (GamePaths list, mlc01/usr/title/<type>/<group> structure, multi-line
// `longname_en`). The TGA->PNG cover conversion is covered on a synthetic, minimal TGA image
// (`buildFakeTga`), the PNG output decoded back pixel-exactly with `inflatePngPixels` from
// `test/helpers/fixtures.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, withTempHome, mkdirp } = require('../helpers/fs.js');
const { inflatePngPixels } = require('../helpers/fixtures.js');
const {
    parseGamePaths, readGameDirs, mlcRoot, findMlcBaseGameDirs, parseMetaXml, cemuGameLabel,
    cemuGameId, findInstalledGames, decodeTga, cemuCoverPath, resolveCemuCover,
    ensureCemuCover, MAX_ICON_TGA_BYTES,
    cemuGameArgs,
} = require('../../lib/launchers/cemu-library.js');

function writeMeta(dir, { titleId, longnameEn, extraXml = '' } = {}) {
    mkdirp(path.join(dir, 'meta'));
    const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<menu type="complex" access="777">'];
    if (titleId) lines.push(`  <title_id type="hexBinary" length="8">${titleId}</title_id>`);
    if (longnameEn !== undefined) lines.push(`  <longname_en type="string" length="512">${longnameEn}</longname_en>`);
    lines.push(extraXml, '</menu>');
    fs.writeFileSync(path.join(dir, 'meta', 'meta.xml'), lines.join('\n'));
}

// --- settings.xml parse ---

test('parseGamePaths — the entries of the <GamePaths><Entry>...</Entry></GamePaths> block', () => {
    const xml = '<content><GamePaths><Entry>/a/b</Entry><Entry>/c/d</Entry></GamePaths><Other/></content>';
    assert.deepEqual(parseGamePaths(xml), ['/a/b', '/c/d']);
});

test('parseGamePaths — missing block / empty <GamePaths/> -> empty list', () => {
    assert.deepEqual(parseGamePaths('<content></content>'), []);
    assert.deepEqual(parseGamePaths('<content><GamePaths/></content>'), []);
});

test('readGameDirs — only the folders that actually exist, an empty list if settings.xml is missing', () => {
    const configRoot = tmpDir('gl-cemu-cfg-');
    assert.deepEqual(readGameDirs(configRoot), []);

    const gamesDir = tmpDir('gl-cemu-games-');
    fs.writeFileSync(path.join(configRoot, 'settings.xml'),
        `<content><GamePaths><Entry>${gamesDir}</Entry><Entry>/does/not/exist/anywhere</Entry></GamePaths></content>`);
    assert.deepEqual(readGameDirs(configRoot), [gamesDir]);
});

test('mlcRoot — <mlc_path> override, if empty the dataRoot/mlc01 default', () => {
    const configRoot = tmpDir('gl-cemu-cfg-');
    const dataRoot = tmpDir('gl-cemu-data-');
    fs.writeFileSync(path.join(configRoot, 'settings.xml'), '<content><mlc_path></mlc_path></content>');
    assert.equal(mlcRoot(configRoot, dataRoot), path.join(dataRoot, 'mlc01'));

    fs.writeFileSync(path.join(configRoot, 'settings.xml'), '<content><mlc_path>/egyeni/mlc</mlc_path></content>');
    assert.equal(mlcRoot(configRoot, dataRoot), '/egyeni/mlc');
});

test('findMlcBaseGameDirs — ONLY subgroups of type 00050000 (base game), 0005000e (update) is skipped', () => {
    const mlc = tmpDir('gl-cemu-mlc-');
    const baseDir = path.join(mlc, 'usr', 'title', '00050000', '10143600');
    writeMeta(baseDir, { titleId: '0005000010143600', longnameEn: 'Base Game' });
    const updateDir = path.join(mlc, 'usr', 'title', '0005000e', '10101e00');
    writeMeta(updateDir, { titleId: '0005000010101e00', longnameEn: 'Update Package' });
    // A group folder without meta.xml (partial/interrupted install) -> skipped.
    mkdirp(path.join(mlc, 'usr', 'title', '00050000', 'deadbeef'));

    assert.deepEqual(findMlcBaseGameDirs(mlc), [baseDir]);
});

test('findMlcBaseGameDirs — missing mlc -> empty list, does not throw', () => {
    assert.deepEqual(findMlcBaseGameDirs('/does/not/exist/anywhere'), []);
});

// --- meta.xml parse ---

test('parseMetaXml — title_id + longname_en, a multi-line title joined into one line', () => {
    const xml = [
        '<menu>',
        '  <title_id type="hexBinary" length="8">0005000010143600</title_id>',
        '  <longname_en type="string" length="512">THE LEGEND OF ZELDA',
        'The Wind Waker HD</longname_en>',
        '</menu>',
    ].join('\n');
    assert.deepEqual(parseMetaXml(xml), { titleId: '0005000010143600', name: 'THE LEGEND OF ZELDA The Wind Waker HD' });
});

test('parseMetaXml — if longname_en is missing falls back to the next non-empty localization', () => {
    const xml = [
        '<menu>',
        '  <title_id type="hexBinary" length="8">0005000010101E00</title_id>',
        '  <longname_en type="string" length="512"></longname_en>',
        '  <longname_fr type="string" length="512">New SUPER MARIO BROS. U</longname_fr>',
        '</menu>',
    ].join('\n');
    assert.deepEqual(parseMetaXml(xml), { titleId: '0005000010101e00', name: 'New SUPER MARIO BROS. U' });
});

test('parseMetaXml — for empty/bad text { titleId: null, name: null }, never throws', () => {
    assert.deepEqual(parseMetaXml(''), { titleId: null, name: null });
    assert.deepEqual(parseMetaXml('not xml'), { titleId: null, name: null });
});

test('cemuGameLabel — underscore/dot -> space cleanup', () => {
    assert.equal(cemuGameLabel('Some_Game.Folder'), 'Some Game Folder');
    assert.equal(cemuGameLabel(''), '');
});

test('cemuGameId — the titleId if present, otherwise a stable path-hash substitute', () => {
    assert.equal(cemuGameId('0005000010143600', '/x/y'), '0005000010143600');
    const id = cemuGameId(null, '/x/y');
    assert.match(id, /^p:[0-9a-f]{16}$/);
    assert.equal(cemuGameId(null, '/x/y'), id); // deterministic
});

// --- findInstalledGames: GamePaths-scan + mlc01, dedup ---

test('findInstalledGames — walks the GamePaths folders (meta/meta.xml marker), appends the mlc01 base games too, dedup on titleId (GamePaths wins)', () => {
    const configRoot = tmpDir('gl-cemu-cfg-');
    const dataRoot = tmpDir('gl-cemu-data-');
    const gamesRoot = tmpDir('gl-cemu-games-');
    fs.writeFileSync(path.join(configRoot, 'settings.xml'),
        `<content><GamePaths><Entry>${gamesRoot}</Entry></GamePaths></content>`);

    // 1. External dump under GamePaths.
    const marioDir = path.join(gamesRoot, 'New Super Mario Bros U [ARPP01]');
    writeMeta(marioDir, { titleId: '0005000010101E00', longnameEn: 'New SUPER MARIO BROS. U' });
    fs.writeFileSync(path.join(marioDir, 'meta', 'iconTex.tga'), buildFakeTga(2, 2, SAMPLE_2X2));

    // 2. A SECOND external dump carrying the SAME title id as an mlc01
    //    install (to test dedup) — the GamePaths source should win.
    const zeldaExternalDir = path.join(gamesRoot, 'The Legend of Zelda - The Wind Waker HD [BCZP01]');
    writeMeta(zeldaExternalDir, { titleId: '0005000010143600', longnameEn: 'External Zelda Copy' });
    const zeldaMlcDir = path.join(dataRoot, 'mlc01', 'usr', 'title', '00050000', '10143600');
    writeMeta(zeldaMlcDir, { titleId: '0005000010143600', longnameEn: 'Mlc Zelda Copy' });

    // 3. A title installed ONLY in mlc01 (not anywhere in GamePaths — e.g. installed with a
    //    WUP installer).
    const onlyMlcDir = path.join(dataRoot, 'mlc01', 'usr', 'title', '00050000', 'aaaa0000');
    writeMeta(onlyMlcDir, { titleId: '00050000aaaa0000', longnameEn: 'Only Mlc Game' });

    // Non-Wii-U content (no meta/meta.xml) — skipped.
    mkdirp(path.join(gamesRoot, 'Random ROM Folder'));
    fs.writeFileSync(path.join(gamesRoot, 'Random ROM Folder', 'game.nsp'), 'x');

    const games = findInstalledGames(configRoot, dataRoot);
    const byName = Object.fromEntries(games.map((g) => [g.name, g]));

    assert.deepEqual(Object.keys(byName).sort(), [
        'External Zelda Copy', 'New SUPER MARIO BROS. U', 'Only Mlc Game',
    ].sort());
    assert.equal(byName['External Zelda Copy'].path, zeldaExternalDir); // GamePaths wins the dedup
    assert.equal(byName['New SUPER MARIO BROS. U'].titleId, '0005000010101e00');
    assert.equal(byName['Only Mlc Game'].path, onlyMlcDir);
    // Has meta/iconTex.tga -> a PNG converted into the cover cache (under the temp HOME); the others
    // have no icon -> null. (The fixture must write the TGA itself — otherwise the test could pass
    // only because the machine's REAL cover cache happened to have the same title id.)
    const cover = byName['New SUPER MARIO BROS. U'].cover;
    assert.ok(cover && fs.existsSync(cover));
    assert.ok(cover.startsWith(os.homedir()));
    assert.equal(byName['Only Mlc Game'].cover, null);
});

test('findInstalledGames — with empty/missing GamePaths + mlc an empty list, does not throw', () => {
    const configRoot = tmpDir('gl-cemu-cfg-');
    const dataRoot = tmpDir('gl-cemu-data-');
    assert.deepEqual(findInstalledGames(configRoot, dataRoot), []);
});

// --- TGA -> PNG cover conversion ---

// Minimal, uncompressed 32-bit TGA (the fixed shape of the Wii U iconTex.tga): 18-byte header +
// raw BGRA pixel data. With `bottomUp: true` (the actual storage direction of Wii U icons)
// the rows are written to the buffer in reverse order (the decoder flips them back).
function buildFakeTga(width, height, pixelsRgba, { bottomUp = true } = {}) {
    const header = Buffer.alloc(18);
    header[2] = 2; // image type: uncompressed truecolor
    header.writeUInt16LE(width, 12);
    header.writeUInt16LE(height, 14);
    header[16] = 32; // bpp
    header[17] = bottomUp ? 0x08 : 0x28; // alpha bits=8, bit5 (0x20) = origin top/bottom

    const body = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const srcRow = bottomUp ? (height - 1 - y) : y;
        for (let x = 0; x < width; x++) {
            const s = (srcRow * width + x) * 4;
            const d = (y * width + x) * 4;
            // TGA truecolor: B, G, R, A storage order.
            body[d] = pixelsRgba[s + 2];
            body[d + 1] = pixelsRgba[s + 1];
            body[d + 2] = pixelsRgba[s];
            body[d + 3] = pixelsRgba[s + 3];
        }
    }
    return Buffer.concat([header, body]);
}

// 2x2 image, 4 clearly distinct colors (RGBA row-major, y=0 is the TOP of the image).
const SAMPLE_2X2 = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, // red, green
    0, 0, 255, 128, 255, 255, 0, 0, // half-transparent blue, fully transparent yellow
]);

test('decodeTga — decoding an uncompressed 32bpp TGA (bottom-to-top storage flipped)', () => {
    const tga = buildFakeTga(2, 2, SAMPLE_2X2, { bottomUp: true });
    const decoded = decodeTga(tga);
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
    assert.deepEqual(Uint8Array.from(decoded.pixels), Uint8Array.from(SAMPLE_2X2));
});

test('decodeTga — the top-to-bottom stored (origin bit=1) variant decodes correctly too', () => {
    const tga = buildFakeTga(2, 2, SAMPLE_2X2, { bottomUp: false });
    const decoded = decodeTga(tga);
    assert.deepEqual(Uint8Array.from(decoded.pixels), Uint8Array.from(SAMPLE_2X2));
});

test('decodeTga — null for an unsupported/corrupt TGA, never throws', () => {
    assert.equal(decodeTga(Buffer.alloc(4)), null); // header too short
    const rle = buildFakeTga(2, 2, SAMPLE_2X2);
    rle[2] = 10; // RLE-compressed image type — not supported
    assert.equal(decodeTga(rle), null);
    const huge = buildFakeTga(2, 2, SAMPLE_2X2);
    huge.writeUInt16LE(2000, 12); // width above the sanity limit
    assert.equal(decodeTga(huge), null);
});

test('ensureCemuCover / resolveCemuCover / cemuCoverPath — local TGA->PNG conversion, cached, self-healing', () => {
    const gameDir = tmpDir('gl-cemu-gamedir-');
    mkdirp(path.join(gameDir, 'meta'));
    fs.writeFileSync(path.join(gameDir, 'meta', 'iconTex.tga'), buildFakeTga(2, 2, SAMPLE_2X2));

    return withTempHome(() => {
        assert.equal(resolveCemuCover('0005000010143600'), null); // not cached yet

        const dest = ensureCemuCover(gameDir, '0005000010143600');
        assert.equal(dest, cemuCoverPath('0005000010143600'));
        assert.ok(fs.existsSync(dest));
        assert.deepEqual(inflatePngPixels(fs.readFileSync(dest), 2, 2), SAMPLE_2X2);

        assert.equal(resolveCemuCover('0005000010143600'), dest); // finds itself
        assert.equal(resolveCemuCover(null), null);
    }, 'gl-cemu-home-');
});

test('ensureCemuCover — null for a missing titleId / missing iconTex.tga, never throws', () => {
    return withTempHome(() => {
        assert.equal(ensureCemuCover('/does/not/exist', null), null);
        assert.equal(ensureCemuCover('/does/not/exist', 'deadbeefdeadbeef'), null);
    }, 'gl-cemu-home-');
});

test('ensureCemuCover — does NOT read a file above MAX_ICON_TGA_BYTES completely (freeze protection)', () => {
    const gameDir = tmpDir('gl-cemu-gamedir-');
    mkdirp(path.join(gameDir, 'meta'));
    const tgaPath = path.join(gameDir, 'meta', 'iconTex.tga');
    // Sparse file — the guard cares about its SIZE, not its content; it does not take that much disk.
    fs.writeFileSync(tgaPath, Buffer.alloc(0));
    fs.truncateSync(tgaPath, MAX_ICON_TGA_BYTES + 1);

    const origReadFileSync = fs.readFileSync;
    let readFileSyncCalled = false;
    fs.readFileSync = (...args) => {
        if (args[0] === tgaPath) readFileSyncCalled = true;
        return origReadFileSync(...args);
    };
    try {
        withTempHome(() => {
            assert.equal(ensureCemuCover(gameDir, '0005000010143600'), null);
        }, 'gl-cemu-home-');
        assert.equal(
            readFileSyncCalled, false,
            'the whole file was NOT read — the size check rejected it BEFORE readFileSync',
        );
    } finally {
        fs.readFileSync = origReadFileSync;
    }
});

// The launch argument list (the descriptor's `launch.args`, lib/launchers/emulator-sources.js).
test('cemuGameArgs — flatpak run Cemu -f -g <gamePath>', () => {
    assert.deepEqual(cemuGameArgs('/mnt/Wiiu/Some Game'), [
        'run', 'info.cemu.Cemu', '-f', '-g', '/mnt/Wiiu/Some Game',
    ]);
});

// A symlinked game folder under GamePaths is found too, the trash is not.
test('findInstalledGames — a symlinked game folder (other drive) too, $RECYCLE.BIN is skipped', () => {
    const configRoot = tmpDir('gl-cemu-cfg-');
    const dataRoot = tmpDir('gl-cemu-data-');
    const gamesRoot = tmpDir('gl-cemu-games-');
    const otherDisk = tmpDir('gl-cemu-disk-');
    fs.writeFileSync(path.join(configRoot, 'settings.xml'),
        `<content><GamePaths><Entry>${gamesRoot}</Entry></GamePaths></content>`);
    writeMeta(path.join(otherDisk, 'Linked Game'), { titleId: '0005000010101E00', longnameEn: 'Linked Game' });
    fs.symlinkSync(path.join(otherDisk, 'Linked Game'), path.join(gamesRoot, 'Linked Game'));
    writeMeta(path.join(gamesRoot, '$RECYCLE.BIN', 'Deleted'), { titleId: '0005000010143600', longnameEn: 'Deleted' });
    const games = findInstalledGames(configRoot, dataRoot);
    assert.deepEqual(games.map((g) => g.name), ['Linked Game']);
});
