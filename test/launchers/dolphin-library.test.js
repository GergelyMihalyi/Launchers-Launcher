'use strict';

// lib/launchers/dolphin-library.js — Dolphin (GameCube/Wii) installed disc-image discovery.
// The `.iso`/`.wbfs` header extraction follows the byte layout verified on the machine
// (hexdump of a real "New Super Mario Bros: Arcadia" SMNP77.wbfs file).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, withTempHome, mkdirp, writeFile } = require('../helpers/fs.js');
const {
    parseIsoPaths, readGameDirs, parseDiscHeader, extractIsoDiscMeta,
    extractWbfsDiscMeta, dolphinGameLabel, dolphinGameId, findInstalledGames,
    dolphinCoverPath, dolphinNativeCoverPath, resolveDolphinCover, gametdbRegion, gametdbCoverUrl,
    ensureDolphinCovers,
    dolphinGameArgs,
} = require('../../lib/launchers/dolphin-library.js');

// The native GC/Wii disc header: Game ID 6 bytes @0, Wii magic @0x18 / GC magic @0x1c, title
// (null-terminated ASCII) @0x20 — layout verified with hexdump on the machine.
function buildDiscHeader({ gameId = 'SMNP77', title = 'New Super Mario Bros: Arcadia', wii = true } = {}) {
    const buf = Buffer.alloc(0x60);
    Buffer.from(gameId, 'ascii').copy(buf, 0);
    if (wii) buf.writeUInt32BE(0x5d1c9ea3, 0x18);
    else buf.writeUInt32BE(0xc2339f3d, 0x1c);
    Buffer.from(title, 'ascii').copy(buf, 0x20);
    return buf;
}

function buildFakeWbfs(discHeader, hdSecShift = 9) {
    const hdSectorSize = 1 << hdSecShift;
    const buf = Buffer.alloc(hdSectorSize + 0x60);
    Buffer.from('WBFS', 'ascii').copy(buf, 0);
    buf.writeUInt32BE(0x000c2000, 4); // n_hd_sec — the value seen on the machine, not relevant here
    buf.writeUInt8(hdSecShift, 8);
    buf.writeUInt8(21, 9); // wbfs_sec_sz_s — the value seen on the machine (2^21), not relevant to the parser
    discHeader.copy(buf, hdSectorSize);
    return buf;
}

function writeTempFile(name, buf) {
    return writeFile(tmpDir('gl-dolphin-'), name, buf);
}

test('parseDiscHeader — Wii magic / GC magic / neither (null)', () => {
    assert.deepEqual(parseDiscHeader(buildDiscHeader({ wii: true })), {
        gameId: 'SMNP77', title: 'New Super Mario Bros: Arcadia', isWii: true,
    });
    assert.deepEqual(parseDiscHeader(buildDiscHeader({ gameId: 'GALE01', title: 'Super Smash Bros. Melee', wii: false })), {
        gameId: 'GALE01', title: 'Super Smash Bros. Melee', isWii: false,
    });
    const noMagic = Buffer.alloc(0x60);
    Buffer.from('XXXXXX', 'ascii').copy(noMagic, 0);
    assert.equal(parseDiscHeader(noMagic), null);
    assert.equal(parseDiscHeader(Buffer.alloc(10)), null); // too short
});

test('extractIsoDiscMeta — raw .iso/.gcm: the header at the start of the file', () => {
    const p = writeTempFile('game.iso', buildDiscHeader());
    assert.deepEqual(extractIsoDiscMeta(p), { gameId: 'SMNP77', title: 'New Super Mario Bros: Arcadia', isWii: true });
    assert.equal(extractIsoDiscMeta('/does/not/exist.iso'), null);
});

test('extractWbfsDiscMeta — the native disc header AFTER the WBFS header, at the hd_sector_size offset', () => {
    const p = writeTempFile('game.wbfs', buildFakeWbfs(buildDiscHeader()));
    assert.deepEqual(extractWbfsDiscMeta(p), { gameId: 'SMNP77', title: 'New Super Mario Bros: Arcadia', isWii: true });
});

test('extractWbfsDiscMeta — null for a missing WBFS magic or a bad file, does not throw', () => {
    const p = writeTempFile('bad.wbfs', Buffer.from('NOTWBFS!'));
    assert.equal(extractWbfsDiscMeta(p), null);
    assert.equal(extractWbfsDiscMeta('/does/not/exist.wbfs'), null);
});

test('parseIsoPaths — [General] ISOPath0/1 lines + RecursiveISOPaths, another section does not interfere', () => {
    const ini = [
        '[Analytics]',
        'ID = abc',
        '',
        '[General]',
        'ISOPath0 = /home/user/Wii-ROMs',
        'ISOPath1 = ',
        'ISOPaths = 1',
        'RecursiveISOPaths = True',
        'UseGameCovers = True',
        '',
        '[NetPlay]',
        'TraversalChoice = direct',
    ].join('\n');
    assert.deepEqual(parseIsoPaths(ini), { dirs: ['/home/user/Wii-ROMs'], recursive: true });
});

test('parseIsoPaths — missing [General] section / empty text -> empty list, recursive false', () => {
    assert.deepEqual(parseIsoPaths(''), { dirs: [], recursive: false });
    assert.deepEqual(parseIsoPaths('[NetPlay]\nTraversalChoice = direct'), { dirs: [], recursive: false });
});

test('readGameDirs — only the folders that actually exist, deduped; empty list for a missing/bad ini', () => {
    const root = tmpDir('gl-dolphin-cfg-');
    const romsDir = tmpDir('gl-dolphin-roms-');
    fs.writeFileSync(path.join(root, 'Dolphin.ini'), [
        '[General]',
        `ISOPath0 = ${romsDir}`,
        'ISOPath1 = /does/not/exist/somewhere',
        'RecursiveISOPaths = False',
    ].join('\n'));
    assert.deepEqual(readGameDirs(root), { dirs: [romsDir], recursive: false });

    const emptyRoot = tmpDir('gl-dolphin-cfg-');
    assert.deepEqual(readGameDirs(emptyRoot), { dirs: [], recursive: false });
});

test('dolphinGameLabel — extension stripped, _/. -> space', () => {
    assert.equal(dolphinGameLabel('New_Super_Mario_Bros.wbfs'), 'New Super Mario Bros');
    assert.equal(dolphinGameLabel('Some.Game.Name.rvz'), 'Some Game Name');
});

test('dolphinGameId — the Game ID if present, otherwise a path-hash substitute', () => {
    assert.equal(dolphinGameId('SMNP77', '/roms/wii/x.wbfs'), 'SMNP77');
    assert.match(dolphinGameId(null, '/roms/wii/x.rvz'), /^p:[0-9a-f]{16}$/);
});

test('findInstalledGames — .wbfs/.iso with the full title+ID, .rvz only file-name based, sorted, dedup', () => {
    // Cover resolution calls `os.homedir()` (`dolphinCacheRoot()`) — a temp HOME is needed, otherwise
    // the test might read a GameTDB cache that really exists on the machine.
    return withTempHome(() => {
        const configRoot = tmpDir('gl-dolphin-cfg-');
        const romsDir = tmpDir('gl-dolphin-roms-');
        fs.writeFileSync(path.join(configRoot, 'Dolphin.ini'), [
            '[General]',
            `ISOPath0 = ${romsDir}`,
            'RecursiveISOPaths = False',
        ].join('\n'));

        fs.writeFileSync(path.join(romsDir, 'mario.wbfs'), buildFakeWbfs(buildDiscHeader({
            gameId: 'SMNP77', title: 'New Super Mario Bros: Arcadia',
        })));
        fs.writeFileSync(path.join(romsDir, 'zelda.iso'), buildDiscHeader({
            gameId: 'GZLE01', title: 'The Legend of Zelda', wii: false,
        }));
        fs.writeFileSync(path.join(romsDir, 'Some Compressed Game.rvz'), Buffer.from('not a real rvz'));

        const games = findInstalledGames(configRoot);
        assert.equal(games.length, 3);
        const byId = Object.fromEntries(games.map((g) => [g.id, g]));
        assert.equal(byId.SMNP77.name, 'New Super Mario Bros: Arcadia');
        assert.equal(byId.SMNP77.cover, null); // no cover cache on the temp HOME
        assert.equal(byId.GZLE01.name, 'The Legend of Zelda');
        const compressed = games.find((g) => g.path.endsWith('.rvz'));
        assert.equal(compressed.name, 'Some Compressed Game');
        assert.equal(compressed.gameId, null);
        assert.match(compressed.id, /^p:[0-9a-f]{16}$/);
    }, 'gl-dolphin-home-');
});

test('findInstalledGames — empty/missing ISOPath -> empty list, never throws', () => {
    const configRoot = tmpDir('gl-dolphin-cfg-');
    assert.deepEqual(findInstalledGames(configRoot), []);
});

test('dolphinCoverPath / resolveDolphinCover — Dolphin\'s own cache with PRECEDENCE, the launcher\'s own cache second', () => {
    return withTempHome(() => {
        const cacheRoot = tmpDir('gl-dolphin-nativecache-');
        assert.equal(resolveDolphinCover(cacheRoot, 'SMNP77'), null);
        assert.equal(resolveDolphinCover(cacheRoot, null), null);

        // only the launcher's own cache exists
        const own = dolphinCoverPath('SMNP77');
        mkdirp(path.dirname(own));
        fs.writeFileSync(own, 'x');
        assert.equal(resolveDolphinCover(cacheRoot, 'SMNP77'), own);

        // Dolphin's own cache appears too -> it takes PRECEDENCE
        const native = dolphinNativeCoverPath(cacheRoot, 'SMNP77');
        mkdirp(path.dirname(native));
        fs.writeFileSync(native, 'y');
        assert.equal(resolveDolphinCover(cacheRoot, 'SMNP77'), native);
    }, 'gl-dolphin-home-');
});

test('gametdbRegion / gametdbCoverUrl — region folder by the 4th character of the Game ID (verified live on the machine: P->EN, E->US, J->JA)', () => {
    assert.equal(gametdbRegion('SMNP77'), 'EN'); // P
    assert.equal(gametdbRegion('RMCE01'), 'US'); // E
    assert.equal(gametdbRegion('RMCJ01'), 'JA'); // J
    assert.equal(gametdbRegion('XXXX01'), 'EN'); // unknown -> fallback
    assert.equal(gametdbCoverUrl('SMNP77'), 'https://art.gametdb.com/wii/cover/EN/SMNP77.png');
});

test('ensureDolphinCovers — downloads only the entry without a cover that carries a gameId, cover in place', async () => {
    return withTempHome(async () => {
        const entries = [
            { cover: null, params: { gameId: 'SMNP77' } },
            { cover: '/already/has/one.png', params: { gameId: 'GZLE01' } },
            { cover: null, params: {} }, // no gameId -> skipped
        ];
        const download = async (url, dest) => {
            assert.equal(url, 'https://art.gametdb.com/wii/cover/EN/SMNP77.png');
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, 'img');
            return true;
        };
        const n = await ensureDolphinCovers(entries, { download });
        assert.equal(n, 1);
        assert.equal(entries[0].cover, dolphinCoverPath('SMNP77'));
    }, 'gl-dolphin-home-');
});

test('ensureDolphinCovers — a failed download does not set the cover, does not throw', async () => {
    return withTempHome(async () => {
        const entries = [{ cover: null, params: { gameId: 'ZZZZ99' } }];
        const n = await ensureDolphinCovers(entries, { download: async () => false });
        assert.equal(n, 0);
        assert.equal(entries[0].cover, null);
    }, 'gl-dolphin-home-');
});

// The launch argument list (the descriptor's `launch.args`, lib/launchers/emulator-sources.js).
test('dolphinGameArgs — flatpak run Dolphin -b -e <discPath> -C Dolphin.Display.Fullscreen=True', () => {
    assert.deepEqual(dolphinGameArgs('/roms/wii/game.wbfs'), [
        'run', 'org.DolphinEmu.dolphin-emu', '-b', '-e', '/roms/wii/game.wbfs',
        '-C', 'Dolphin.Display.Fullscreen=True',
    ]);
});
