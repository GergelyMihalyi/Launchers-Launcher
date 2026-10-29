'use strict';

// Test coverage of `lib/launchers/ppsspp-library.js`: `.pbp` header offset extraction (`buildFakePbp`),
// the two-level ISO9660 (`PSP_GAME/`) traversal (`buildPspIso`), and CSO block decoding
// (`buildFakeCso` — compresses the ISO fixture with zlib raw deflate, and the decoded content
// must be byte-identical). The PARAM.SFO parser is in `test/launchers/shared/param-sfo.test.js`,
// the shared fixtures in `test/helpers/fixtures.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, withTempHome, writeFile } = require('../helpers/fs.js');
const { buildFakeIso, buildFakeParamSfo } = require('../helpers/fixtures.js');
const zlib = require('zlib');
const {
    parsePinnedPaths, parseRecentFiles, parsePlayTime, readGameDirs,
    extractPbpMeta, extractDiscMeta, ppssppGameLabel, ppssppGameId, findInstalledGames,
    recentFromGames, ppssppCoverPath, resolvePpssppCover, ensurePpssppCover,
    ppssppGameArgs,
} = require('../../lib/launchers/ppsspp-library.js');

const SECTOR = 2048;

// A PSP UMD image: `PSP_GAME/PARAM.SFO` + optional `PSP_GAME/ICON0.PNG` (the PSP counterpart of
// the PS3 `PS3_GAME/` pattern); `noPspGame` -> an empty `PSP_GAME` folder.
function buildPspIso({ paramSfo, icon0, noMagic = false, noPspGame = false } = {}) {
    const game = {};
    if (!noPspGame) {
        game['PARAM.SFO'] = paramSfo;
        if (icon0) game['ICON0.PNG'] = icon0;
    }
    return buildFakeIso({ PSP_GAME: game }, { noMagic });
}

// Builds a CSO from an ISO buffer (raw deflate, the real `.cso` format, see the lib's header
// comment) — the same content, just compressed, so the byte-identity of the decoding
// can be checked.
function buildFakeCso(isoBuf, blockSize = SECTOR) {
    const numBlocks = Math.ceil(isoBuf.length / blockSize);
    const blocks = [];
    for (let i = 0; i < numBlocks; i++) {
        const start = i * blockSize;
        let block = isoBuf.subarray(start, Math.min(start + blockSize, isoBuf.length));
        if (block.length < blockSize) {
            const padded = Buffer.alloc(blockSize);
            block.copy(padded);
            block = padded;
        }
        blocks.push(zlib.deflateRawSync(block));
    }
    const headerSize = 24;
    let offset = headerSize + (numBlocks + 1) * 4;
    const offsets = [];
    for (let i = 0; i < numBlocks; i++) { offsets.push(offset); offset += blocks[i].length; }
    offsets.push(offset);
    const header = Buffer.alloc(headerSize);
    Buffer.from('CISO', 'ascii').copy(header, 0);
    header.writeUInt32LE(headerSize, 4);
    header.writeBigUInt64LE(BigInt(isoBuf.length), 8);
    header.writeUInt32LE(blockSize, 16);
    header[20] = 1; // version
    header[21] = 0; // align
    const indexBuf = Buffer.alloc((numBlocks + 1) * 4);
    offsets.forEach((o, i) => indexBuf.writeUInt32LE(o, i * 4));
    return Buffer.concat([header, indexBuf, ...blocks]);
}

function buildFakePbp({ paramSfo, icon0 }) {
    const header = Buffer.alloc(40);
    Buffer.from([0x00, 0x50, 0x42, 0x50]).copy(header, 0); // "\0PBP"
    header.writeUInt32LE(0x00010001, 4);
    const iconBuf = icon0 || Buffer.alloc(0);
    const sfoStart = 40;
    const iconStart = sfoStart + paramSfo.length;
    const end = iconStart + iconBuf.length;
    const offsets = [sfoStart, iconStart, end, end, end, end, end, end];
    offsets.forEach((o, i) => header.writeUInt32LE(o, 8 + i * 4));
    return Buffer.concat([header, paramSfo, iconBuf]);
}

function writeTempFile(name, buf) {
    return writeFile(tmpDir('gl-ppsspp-file-'), name, buf);
}

test('parsePinnedPaths — Path0/Path1 lines of [PinnedPaths], another section does not interfere', () => {
    const ini = [
        '[General]',
        'FirstRun = False',
        '',
        '[PinnedPaths]',
        'Path0 = /home/user/PSP-ROMs',
        'Path1 = /run/user/1000/doc/xyz/psp',
        '',
        '[Recent]',
        'MaxRecent = 60',
    ].join('\r\n');
    assert.deepEqual(parsePinnedPaths(ini), ['/home/user/PSP-ROMs', '/run/user/1000/doc/xyz/psp']);
});

test('parsePinnedPaths — no [PinnedPaths] section -> empty list', () => {
    assert.deepEqual(parsePinnedPaths('[General]\r\nFirstRun = False\r\n'), []);
});

test('parsePlayTime — <DISC_ID> = <seconds>,<unix s>', () => {
    const ini = '[Recent]\r\nMaxRecent = 60\r\n[PlayTime]\r\nULES00789 = 274,1789401775\r\n[Log]\r\nSYSTEMEnabled = True\r\n';
    const map = parsePlayTime(ini);
    assert.deepEqual(map.get('ULES00789'), { seconds: 274, lastPlayedAt: 1789401775000 });
});

test('readGameDirs — only the folders that actually exist, deduped', () => {
    const configRoot = tmpDir('gl-ppsspp-cfg-');
    const romsDir = tmpDir('gl-ppsspp-roms-');
    fs.mkdirSync(path.join(configRoot, 'PSP', 'SYSTEM'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'PSP', 'SYSTEM', 'ppsspp.ini'), [
        '[PinnedPaths]',
        `Path0 = ${romsDir}`,
        `Path1 = ${romsDir}`, // dedup
        'Path2 = /does/not/exist/anywhere',
    ].join('\r\n'));
    assert.deepEqual(readGameDirs(configRoot), [romsDir]);
});

test('readGameDirs — missing ppsspp.ini -> empty list, does not throw', () => {
    assert.deepEqual(readGameDirs(tmpDir('gl-ppsspp-empty-')), []);
});

test('parseRecentFiles — FileName0/1 lines of [Recent], another section does not interfere', () => {
    const ini = [
        '[Recent]',
        'MaxRecent = 60',
        'FileName0 = /run/flatpak/doc/p8Wcff0VbJfk4_qhLDMghg/psp/Loco Roco USA.cso',
        'FileName1 = /run/flatpak/doc/p8Wcff0VbJfk4_qhLDMghg/psp/Dragon Ball Z Shin Budokai 2.cso',
        '[Log]',
        'SYSTEMEnabled = True',
    ].join('\r\n');
    assert.deepEqual(parseRecentFiles(ini), [
        '/run/flatpak/doc/p8Wcff0VbJfk4_qhLDMghg/psp/Loco Roco USA.cso',
        '/run/flatpak/doc/p8Wcff0VbJfk4_qhLDMghg/psp/Dragon Ball Z Shin Budokai 2.cso',
    ]);
});

// Gotcha verified in production: the `[Recent]` entry stores the `/run/flatpak/doc/<token>/...`
// path seen INSIDE the flatpak sandbox, which does NOT exist from the launcher's (unsandboxed)
// process — it is reachable under the host-side FUSE mount `/run/user/<uid>/doc/<token>/...`
// (the same document-portal instance).
// The user's actual case: never pinned a folder in PPSSPP, only opened ROMs with the file
// picker — so the PARENT folder of the `[Recent]` entries is the SECOND source of
// `readGameDirs`, with portal path translation.
test('readGameDirs — the parent folder of [Recent] is a source too (portal path translated), no [PinnedPaths]', () => {
    const configRoot = tmpDir('gl-ppsspp-recentdir-cfg-');
    const romsDir = tmpDir('gl-ppsspp-recentdir-roms-');
    fs.mkdirSync(path.join(configRoot, 'PSP', 'SYSTEM'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'PSP', 'SYSTEM', 'ppsspp.ini'), [
        '[Recent]',
        'MaxRecent = 60',
        `FileName0 = ${path.join(romsDir, 'game.cso')}`, // plain (non-portal) path
    ].join('\r\n'));
    assert.deepEqual(readGameDirs(configRoot), [romsDir]);
});

test('extractPbpMeta — the embedded PARAM.SFO + ICON0.PNG extracted', () => {
    const sfo = buildFakeParamSfo({ DISC_ID: 'NPUH10086', TITLE: 'Homebrew Test' });
    const icon = Buffer.from('fake-icon-bytes');
    const pbpPath = writeTempFile('EBOOT.PBP', buildFakePbp({ paramSfo: sfo, icon0: icon }));
    const meta = extractPbpMeta(pbpPath);
    assert.equal(meta.sfo.DISC_ID, 'NPUH10086');
    assert.equal(meta.sfo.TITLE, 'Homebrew Test');
    assert.ok(meta.icon.equals(icon));
});

test('extractPbpMeta — bad magic -> null', () => {
    const p = writeTempFile('bad.pbp', Buffer.from('not-a-pbp-file'));
    assert.equal(extractPbpMeta(p), null);
});

test('extractDiscMeta — .iso: PSP_GAME/PARAM.SFO + PSP_GAME/ICON0.PNG with a two-level ISO9660 traversal', () => {
    const sfo = buildFakeParamSfo({ DISC_ID: 'ULES00789', TITLE: 'Dragon Ball Z Shin Budokai 2' });
    const icon = Buffer.from('fake-icon-bytes-iso');
    const isoPath = writeTempFile('game.iso', buildPspIso({ paramSfo: sfo, icon0: icon }));
    const meta = extractDiscMeta(isoPath);
    assert.equal(meta.sfo.DISC_ID, 'ULES00789');
    assert.ok(meta.icon.equals(icon));
});

test('extractDiscMeta — .iso: missing CD001 magic -> null', () => {
    const sfo = buildFakeParamSfo({ DISC_ID: 'X' });
    const isoPath = writeTempFile('bad.iso', buildPspIso({ paramSfo: sfo, noMagic: true }));
    assert.equal(extractDiscMeta(isoPath), null);
});

test('extractDiscMeta — .iso: missing PSP_GAME subdirectory -> null', () => {
    const sfo = buildFakeParamSfo({ DISC_ID: 'X' });
    const isoPath = writeTempFile('nogame.iso', buildPspIso({ paramSfo: sfo, noPspGame: true }));
    assert.equal(extractDiscMeta(isoPath), null);
});

test('extractDiscMeta — .cso: the CSO block decoding gives a byte-identical result to the plain .iso', () => {
    const sfo = buildFakeParamSfo({ DISC_ID: 'ULES00789', TITLE: 'Dragon Ball Z Shin Budokai 2' });
    const icon = Buffer.from('fake-icon-bytes-cso'.repeat(50)); // a size spanning a few blocks
    const iso = buildPspIso({ paramSfo: sfo, icon0: icon });
    const csoPath = writeTempFile('game.cso', buildFakeCso(iso));
    const meta = extractDiscMeta(csoPath);
    assert.equal(meta.sfo.DISC_ID, 'ULES00789');
    assert.equal(meta.sfo.TITLE, 'Dragon Ball Z Shin Budokai 2');
    assert.ok(meta.icon.equals(icon));
});

test('extractDiscMeta — unknown extension -> null', () => {
    assert.equal(extractDiscMeta('/tmp/whatever.txt'), null);
});

test('ppssppGameLabel — extension stripped, _/. -> space', () => {
    assert.equal(ppssppGameLabel('Some_Game.Name.iso'), 'Some Game Name');
});

test('ppssppGameId — DISC_ID if present; otherwise a path-hash substitute', () => {
    assert.equal(ppssppGameId('ULES00789', '/x/game.iso'), 'ULES00789');
    const id = ppssppGameId(null, '/x/homebrew.pbp');
    assert.match(id, /^p:[0-9a-f]{16}$/);
});

test('findInstalledGames — pinned folder + built-in PSP/GAME scan, dedup, enriched with playtime', () => {
    const configRoot = tmpDir('gl-ppsspp-full-cfg-');
    fs.mkdirSync(path.join(configRoot, 'PSP', 'SYSTEM'), { recursive: true });
    fs.mkdirSync(path.join(configRoot, 'PSP', 'GAME', 'Homebrew Test'), { recursive: true });

    const romsDir = tmpDir('gl-ppsspp-full-roms-');
    const isoSfo = buildFakeParamSfo({ DISC_ID: 'ULES00789', TITLE: 'Dragon Ball Z Shin Budokai 2' });
    fs.writeFileSync(path.join(romsDir, 'dbz.iso'), buildPspIso({ paramSfo: isoSfo }));

    const pbpSfo = buildFakeParamSfo({ TITLE: 'Homebrew Test' }); // no DISC_ID -> path-hash id
    fs.writeFileSync(
        path.join(configRoot, 'PSP', 'GAME', 'Homebrew Test', 'EBOOT.PBP'),
        buildFakePbp({ paramSfo: pbpSfo }),
    );

    fs.writeFileSync(path.join(configRoot, 'PSP', 'SYSTEM', 'ppsspp.ini'), [
        '[PinnedPaths]',
        `Path0 = ${romsDir}`,
        '[PlayTime]',
        'ULES00789 = 274,1789401775',
    ].join('\r\n'));

    const games = findInstalledGames(configRoot);
    assert.equal(games.length, 2);
    const dbz = games.find((g) => g.id === 'ULES00789');
    assert.ok(dbz);
    assert.equal(dbz.name, 'Dragon Ball Z Shin Budokai 2');
    assert.equal(dbz.lastPlayedAt, 1789401775000);
    const homebrew = games.find((g) => g.name === 'Homebrew Test');
    assert.ok(homebrew);
    assert.match(homebrew.id, /^p:[0-9a-f]{16}$/);
    assert.equal(homebrew.lastPlayedAt, null); // no DISC_ID -> no playtime match
});

test('findInstalledGames — no pinned folder, empty PSP/GAME -> empty list, does not throw', () => {
    const configRoot = tmpDir('gl-ppsspp-empty2-cfg-');
    fs.mkdirSync(path.join(configRoot, 'PSP', 'GAME'), { recursive: true });
    assert.deepEqual(findInstalledGames(configRoot), []);
});

test('recentFromGames — only the entries with lastPlayedAt, in descending order', () => {
    const configRoot = tmpDir('gl-ppsspp-recent-cfg-');
    fs.mkdirSync(path.join(configRoot, 'PSP', 'SYSTEM'), { recursive: true });
    const romsDir = tmpDir('gl-ppsspp-recent-roms-');
    const sfo1 = buildFakeParamSfo({ DISC_ID: 'ULES00789', TITLE: 'Game A' });
    const sfo2 = buildFakeParamSfo({ DISC_ID: 'ULUS10001', TITLE: 'Game B' });
    fs.writeFileSync(path.join(romsDir, 'a.iso'), buildPspIso({ paramSfo: sfo1 }));
    fs.writeFileSync(path.join(romsDir, 'b.iso'), buildPspIso({ paramSfo: sfo2 }));
    fs.writeFileSync(path.join(configRoot, 'PSP', 'SYSTEM', 'ppsspp.ini'), [
        '[PinnedPaths]',
        `Path0 = ${romsDir}`,
        '[PlayTime]',
        'ULES00789 = 100,1000',
        'ULUS10001 = 200,2000',
    ].join('\r\n'));
    const recent = recentFromGames(findInstalledGames(configRoot), 3);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].name, 'Game B'); // 2000 > 1000
    assert.equal(recent[0].kind, 'ppsspp');
    assert.equal(recent[0].key, 'ppsspp-game-ULUS10001');
    // Must be an ISO 8601 STRING, NOT the raw ms-epoch number — mergeRecentGameLists() in
    // lib/recent/usage.js calls Date.parse() on it (this was the production bug, see the
    // analogous duckstation-library.js fix).
    assert.equal(recent[0].lastLaunchedAt, new Date(2000 * 1000).toISOString());
    assert.equal(Number.isNaN(Date.parse(recent[0].lastLaunchedAt)), false);
});

test('resolvePpssppCover / ensurePpssppCover — self-healing disk cache, without network', () => {
    withTempHome(() => {
        assert.equal(resolvePpssppCover('ULES00789'), null);
        const dest = ensurePpssppCover('ULES00789', Buffer.from('png-bytes'));
        assert.equal(dest, ppssppCoverPath('ULES00789'));
        assert.ok(fs.existsSync(dest));
        assert.equal(resolvePpssppCover('ULES00789'), dest);
        // A second call does not overwrite (self-healing — writes only if not there yet).
        const again = ensurePpssppCover('ULES00789', Buffer.from('other-bytes'));
        assert.equal(again, dest);
        assert.equal(fs.readFileSync(dest, 'utf8'), 'png-bytes');
    }, 'gl-ppsspp-home-');
});

test('ensurePpssppCover — missing id or empty icon -> null', () => {
    assert.equal(ensurePpssppCover(null, Buffer.from('x')), null);
    assert.equal(ensurePpssppCover('X', null), null);
});

// The launch argument list (the descriptor's `launch.args`, lib/launchers/emulator-sources.js).
test('ppssppGameArgs — flatpak run PPSSPP --fullscreen <discPath>', () => {
    assert.deepEqual(ppssppGameArgs('/roms/psp/game.iso'), [
        'run', 'org.ppsspp.PPSSPP', '--fullscreen', '/roms/psp/game.iso',
    ]);
});
