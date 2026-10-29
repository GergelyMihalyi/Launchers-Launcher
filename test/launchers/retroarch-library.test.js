'use strict';

// lib/launchers/retroarch-library.js — RetroArch playlist-based ROM discovery.
// The sample JSON follows the real .lpl structure found on the machine
// (items[].label/path/core_path/db_name).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');
const {
    parsePlaylist, countPlaylistItems, systemNameFromFile, listPlaylistFiles,
    findSystemCounts, findSystemCountsCached, findGamesForSystem, findAllGames,
    parseContentHistory, systemFromCoreName, labelFromPath, findRecentGames,
    coreForSystem, corePathForSystem, retroarchThumbnailLabel, resolveRetroarchThumbnail,
    libretroThumbnailUrl, ensureRecentThumbnails, MAX_PLAYLIST_BYTES,
} = require('../../lib/launchers/retroarch-library.js');

function samplePlaylist(items) {
    return JSON.stringify({
        version: '1.5',
        default_core_path: '',
        default_core_name: '',
        items: items.map((it) => ({
            path: it.path,
            label: it.label,
            core_path: 'DETECT',
            core_name: 'DETECT',
            crc32: '00000000|crc',
            db_name: 'Nintendo - Super Nintendo Entertainment System.lpl',
        })),
    });
}

test('parsePlaylist — extracting label/path, the core/crc/db_name fields are not needed', () => {
    const games = parsePlaylist(samplePlaylist([
        { path: '/roms/snes/Chrono Trigger.sfc', label: 'Chrono Trigger (USA)' },
    ]));
    assert.deepEqual(games, [{ label: 'Chrono Trigger (USA)', path: '/roms/snes/Chrono Trigger.sfc' }]);
});

test('parsePlaylist — an empty list for a missing/empty "items" array', () => {
    assert.deepEqual(parsePlaylist(JSON.stringify({})), []);
});

test('countPlaylistItems — counts the "path" key without JSON.parse ("core_path" does not interfere)', () => {
    assert.equal(countPlaylistItems(samplePlaylist([
        { path: '/a', label: 'A' }, { path: '/b', label: 'B' }, { path: '/c', label: 'C' },
    ])), 3);
    assert.equal(countPlaylistItems(samplePlaylist([])), 0);
    assert.equal(countPlaylistItems('{ not json'), 0);
});

test('systemNameFromFile — strips the .lpl extension', () => {
    assert.equal(systemNameFromFile('Nintendo - Super Nintendo Entertainment System.lpl'), 'Nintendo - Super Nintendo Entertainment System');
});

test('listPlaylistFiles — returns only the .lpl files, skips the "logs"/"builtin" subdirectory', () => {
    const dir = tmpDir('gl-ra-playlists-');
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.mkdirSync(path.join(dir, 'builtin'));
    fs.writeFileSync(path.join(dir, 'DOS.lpl'), samplePlaylist([{ path: '/x', label: 'x' }]));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a playlist');
    assert.deepEqual(listPlaylistFiles(dir), ['DOS.lpl']);
});

test('listPlaylistFiles — an empty array for a missing folder', () => {
    assert.deepEqual(listPlaylistFiles(path.join(os.tmpdir(), 'gl-ra-missing-dir')), []);
});

test('findSystemCounts — count per system, an empty playlist is dropped', () => {
    const root = tmpDir('gl-ra-root-');
    const playlistsDir = path.join(root, 'playlists');
    fs.mkdirSync(playlistsDir);
    fs.writeFileSync(path.join(playlistsDir, 'DOS.lpl'), samplePlaylist([{ path: '/a', label: 'A' }]));
    fs.writeFileSync(path.join(playlistsDir, 'Nintendo - Nintendo Entertainment System.lpl'), samplePlaylist([
        { path: '/b', label: 'B' }, { path: '/c', label: 'C' },
    ]));
    fs.writeFileSync(path.join(playlistsDir, 'Empty System.lpl'), samplePlaylist([]));

    assert.deepEqual(findSystemCounts(root), [
        { system: 'DOS', count: 1 },
        { system: 'Nintendo - Nintendo Entertainment System', count: 2 },
    ]);
});

test('findSystemCountsCached — does not re-read the disk within the TTL window', () => {
    const root = tmpDir('gl-ra-cache-');
    const playlistsDir = path.join(root, 'playlists');
    fs.mkdirSync(playlistsDir);
    fs.writeFileSync(path.join(playlistsDir, 'DOS.lpl'), samplePlaylist([{ path: '/a', label: 'A' }]));

    const first = findSystemCountsCached(root);
    assert.deepEqual(first, [{ system: 'DOS', count: 1 }]);
    // A new playlist on disk — the cached call does NOT see it YET (within the TTL).
    fs.writeFileSync(path.join(playlistsDir, 'SNES.lpl'), samplePlaylist([{ path: '/b', label: 'B' }]));
    assert.deepEqual(findSystemCountsCached(root), first);
    // after invalidate it does.
    findSystemCountsCached.invalidate();
    assert.equal(findSystemCountsCached(root).length, 2);
});

test('findGamesForSystem — the full list of a given system (cover: null if there is no local thumbnail), an empty array for an unknown system', () => {
    const root = tmpDir('gl-ra-root2-');
    fs.mkdirSync(path.join(root, 'playlists'));
    fs.writeFileSync(path.join(root, 'playlists', 'DOS.lpl'), samplePlaylist([{ path: '/a', label: 'A' }]));

    assert.deepEqual(findGamesForSystem(root, 'DOS'), [{ label: 'A', path: '/a', cover: null }]);
    assert.deepEqual(findGamesForSystem(root, 'No Such'), []);
});

test('findAllGames — gives the full ROM set grouped by system (with local cover), an empty/missing playlist is dropped (ALL + RetroArch)', () => {
    const root = tmpDir('gl-ra-all-');
    fs.mkdirSync(path.join(root, 'playlists'));
    fs.writeFileSync(path.join(root, 'playlists', 'DOS.lpl'), samplePlaylist([
        { path: '/a', label: 'Alpha' }, { path: '/b', label: 'Beta' },
    ]));
    fs.writeFileSync(path.join(root, 'playlists', 'NES.lpl'), samplePlaylist([{ path: '/n', label: 'Nes Game' }]));
    fs.writeFileSync(path.join(root, 'playlists', 'Ures.lpl'), samplePlaylist([]));
    const bx = path.join(root, 'thumbnails', 'DOS', 'Named_Boxarts');
    fs.mkdirSync(bx, { recursive: true });
    fs.writeFileSync(path.join(bx, 'Alpha.png'), '');

    const groups = findAllGames(root).sort((a, b) => a.system.localeCompare(b.system));
    assert.deepEqual(groups.map((g) => g.system), ['DOS', 'NES']);
    const dos = groups[0].games;
    assert.deepEqual(dos.map((g) => g.label).sort(), ['Alpha', 'Beta']);
    assert.equal(dos.find((g) => g.label === 'Alpha').cover, path.join(bx, 'Alpha.png'));
    assert.equal(dos.find((g) => g.label === 'Beta').cover, null);
    assert.deepEqual(findAllGames(path.join(root, 'no-such')), []);
});

test('findGamesForSystem — resolves a cover already present in the LOCAL thumbnails/ folder without network', () => {
    const root = tmpDir('gl-ra-root2cover-');
    fs.mkdirSync(path.join(root, 'playlists'));
    fs.writeFileSync(path.join(root, 'playlists', 'DOS.lpl'), samplePlaylist([
        { path: '/a', label: 'Alpha' }, { path: '/b', label: 'Beta' },
    ]));
    const bx = path.join(root, 'thumbnails', 'DOS', 'Named_Boxarts');
    fs.mkdirSync(bx, { recursive: true });
    fs.writeFileSync(path.join(bx, 'Alpha.png'), '');

    const games = findGamesForSystem(root, 'DOS');
    assert.equal(games.find((g) => g.label === 'Alpha').cover, path.join(bx, 'Alpha.png'));
    assert.equal(games.find((g) => g.label === 'Beta').cover, null);
});

test('findGamesForSystem — returns sorted by `label` (regardless of the .lpl order)', () => {
    const root = tmpDir('gl-ra-sort-');
    fs.mkdirSync(path.join(root, 'playlists'));
    // Reverse order in the .lpl (typical on the machine) + a numeric case.
    fs.writeFileSync(path.join(root, 'playlists', 'NES.lpl'), samplePlaylist([
        { path: '/z', label: 'Zelda II' },
        { path: '/f10', label: 'Final Fantasy 10' },
        { path: '/f2', label: 'Final Fantasy 2' },
        { path: '/a', label: 'Adventure Island' },
    ]));
    assert.deepEqual(findGamesForSystem(root, 'NES').map((g) => g.label), [
        'Adventure Island', 'Final Fantasy 2', 'Final Fantasy 10', 'Zelda II',
    ]);
});

test('findGamesForSystem — does NOT read/parse an .lpl above MAX_PLAYLIST_BYTES (freeze protection)', () => {
    const root = tmpDir('gl-ra-huge-');
    fs.mkdirSync(path.join(root, 'playlists'));
    const playlistPath = path.join(root, 'playlists', 'NES.lpl');
    // Sparse file — the guard cares about its SIZE, not its content; it does not take that much disk.
    fs.writeFileSync(playlistPath, '');
    fs.truncateSync(playlistPath, MAX_PLAYLIST_BYTES + 1);

    const origReadFileSync = fs.readFileSync;
    let readFileSyncCalled = false;
    fs.readFileSync = (...args) => {
        if (args[0] === playlistPath) readFileSyncCalled = true;
        return origReadFileSync(...args);
    };
    try {
        assert.deepEqual(findGamesForSystem(root, 'NES'), []);
        assert.equal(
            readFileSyncCalled, false,
            'the whole file was NOT read/JSON.parse-d — the size check rejected it BEFORE readFileSync',
        );
    } finally {
        fs.readFileSync = origReadFileSync;
    }
});

test('coreForSystem — gives the installed core file name for a known system, null for an unknown one', () => {
    assert.equal(coreForSystem('Nintendo - Nintendo Entertainment System'), 'mesen_libretro.so');
    assert.equal(coreForSystem('Sega - Mega Drive - Genesis'), 'genesis_plus_gx_libretro.so');
    // No PSP core installed on the machine (PSP is handled by a separate PPSSPP launcher).
    assert.equal(coreForSystem('Sony - PlayStation Portable'), null);
    assert.equal(coreForSystem('Unknown Rendszer'), null);
});

test('parseContentHistory — label/path + the system from db_name (.lpl stripped)', () => {
    const hist = JSON.stringify({ items: [
        { path: '/roms/smb.nes', label: 'Super Mario Bros.', db_name: 'Nintendo - Nintendo Entertainment System.lpl' },
        { path: '/roms/ct.sfc', label: 'Chrono Trigger', db_name: 'Nintendo - Super Nintendo Entertainment System.lpl' },
        { path: '/roms/x', label: 'X' }, // without db_name -> system null
    ] });
    assert.deepEqual(parseContentHistory(hist), [
        { label: 'Super Mario Bros.', path: '/roms/smb.nes', system: 'Nintendo - Nintendo Entertainment System' },
        { label: 'Chrono Trigger', path: '/roms/ct.sfc', system: 'Nintendo - Super Nintendo Entertainment System' },
        { label: 'X', path: '/roms/x', system: null },
    ]);
    assert.deepEqual(parseContentHistory(JSON.stringify({})), []);
});

test('systemFromCoreName — strips the " (<core name variant>)" suffix', () => {
    assert.equal(systemFromCoreName('Sony - PlayStation (Beetle PSX HW)'), 'Sony - PlayStation');
    assert.equal(systemFromCoreName('Nintendo - Nintendo Entertainment System (Mesen)'), 'Nintendo - Nintendo Entertainment System');
    assert.equal(systemFromCoreName('NoParens'), 'NoParens');
    assert.equal(systemFromCoreName(''), null);
    assert.equal(systemFromCoreName(null), null);
});

test('labelFromPath — the file name without extension', () => {
    assert.equal(labelFromPath('/roms/Vigilante 8 - 2nd Offense (USA).cue'), 'Vigilante 8 - 2nd Offense (USA)');
    assert.equal(labelFromPath('/roms/smb.nes'), 'smb');
    assert.equal(labelFromPath(''), null);
    assert.equal(labelFromPath(null), null);
});

test('parseContentHistory — for unrecognized content (empty label/db_name) core_name/path is the fallback (case verified on the machine, 2026-09-12)', () => {
    const hist = JSON.stringify({ items: [
        {
            path: '/mnt/Download/Games/RETRO/Sony - Playstation/Vigilante 8/Vigilante 8 - 2nd Offense (USA).cue',
            label: '', core_name: 'Sony - PlayStation (Beetle PSX HW)', crc32: '', db_name: '',
        },
    ] });
    assert.deepEqual(parseContentHistory(hist), [{
        label: 'Vigilante 8 - 2nd Offense (USA)',
        path: '/mnt/Download/Games/RETRO/Sony - Playstation/Vigilante 8/Vigilante 8 - 2nd Offense (USA).cue',
        system: 'Sony - PlayStation',
    }]);
});

test('findRecentGames — the first max items of content_history.lpl in recentGames shape, with cover resolver', () => {
    const root = tmpDir('gl-ra-recent-');
    fs.mkdirSync(path.join(root, 'playlists', 'builtin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'playlists', 'builtin', 'content_history.lpl'), JSON.stringify({ items: [
        { path: '/roms/smb.nes', label: 'Super Mario Bros.', db_name: 'Nintendo - Nintendo Entertainment System.lpl' },
        { path: '/roms/ct.sfc', label: 'Chrono Trigger', db_name: 'Nintendo - Super Nintendo Entertainment System.lpl' },
    ] }));
    // cover only for the first
    const bx = path.join(root, 'thumbnails', 'Nintendo - Nintendo Entertainment System', 'Named_Boxarts');
    fs.mkdirSync(bx, { recursive: true });
    fs.writeFileSync(path.join(bx, 'Super Mario Bros..png'), '');

    const recent = findRecentGames(root, 3);
    assert.equal(recent.length, 2);
    const { lastLaunchedAt, ...rest } = recent[0];
    assert.deepEqual(rest, {
        key: 'retroarch:Nintendo - Nintendo Entertainment System:Super Mario Bros.',
        name: 'Super Mario Bros.',
        cover: path.join(bx, 'Super Mario Bros..png'),
        kind: 'retroarch',
        params: { system: 'Nintendo - Nintendo Entertainment System', path: '/roms/smb.nes' },
    });
    // a timestamp approximated from the .lpl mtime — valid ISO,
    // and item 0 is newer than or equal to item 1 (i*1000 ms decrease within the list).
    assert.ok(!Number.isNaN(Date.parse(lastLaunchedAt)));
    assert.ok(Date.parse(recent[0].lastLaunchedAt) >= Date.parse(recent[1].lastLaunchedAt));
    assert.equal(recent[1].cover, null);
    assert.deepEqual(findRecentGames(root, 1).map((r) => r.name), ['Super Mario Bros.']);
    assert.deepEqual(findRecentGames(path.join(os.tmpdir(), 'gl-ra-nohist')), []);
});

test('retroarchThumbnailLabel — RetroArch file name cleanup (& * / : ` < > ? | -> _)', () => {
    assert.equal(retroarchThumbnailLabel('Ratchet & Clank'), 'Ratchet _ Clank');
    assert.equal(retroarchThumbnailLabel('Where in the World?'), 'Where in the World_');
    assert.equal(retroarchThumbnailLabel('Sonic'), 'Sonic');
    assert.equal(retroarchThumbnailLabel(null), '');
});

test('resolveRetroarchThumbnail — resolves thumbnails/<System>/Named_Boxarts/<label>.png, missing -> null', () => {
    const root = tmpDir('gl-ra-thumb-');
    const dir = path.join(root, 'thumbnails', 'Nintendo - Nintendo Entertainment System', 'Named_Boxarts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Metroid _ Mother Brain.png'), '');

    assert.equal(
        resolveRetroarchThumbnail(root, 'Nintendo - Nintendo Entertainment System', 'Metroid & Mother Brain'),
        path.join(dir, 'Metroid _ Mother Brain.png'),
    );
    assert.equal(resolveRetroarchThumbnail(root, 'Nintendo - Nintendo Entertainment System', 'No Such'), null);
    assert.equal(resolveRetroarchThumbnail(root, 'No System', 'Anything'), null);
});

test('libretroThumbnailUrl — <base>/<System>/Named_Boxarts/<cleaned label>.png, URL-encoded', () => {
    assert.equal(
        libretroThumbnailUrl('Sony - PlayStation', 'CTR - Crash Team Racing (USA)'),
        'https://thumbnails.libretro.com/Sony%20-%20PlayStation/Named_Boxarts/CTR%20-%20Crash%20Team%20Racing%20(USA).png',
    );
    // The & -> _ cleanup (retroarchThumbnailLabel) runs before encoding.
    assert.equal(
        libretroThumbnailUrl('Sega - Mega Drive - Genesis', 'Addams Family, The'),
        'https://thumbnails.libretro.com/Sega%20-%20Mega%20Drive%20-%20Genesis/Named_Boxarts/Addams%20Family%2C%20The.png',
    );
});

test('ensureRecentThumbnails — downloads only the entry without a cover, good URL + target path, cover in place', async () => {
    const root = tmpDir('gl-ra-ensure-');
    const calls = [];
    const entries = [
        { name: 'CTR', cover: '/already/there.png', params: { system: 'Sony - PlayStation' } },
        { name: 'Tekken 3', cover: null, params: { system: 'Sony - PlayStation' } },
        { name: 'NoSystem', cover: null, params: {} },
    ];
    const download = async (url, dest) => { calls.push({ url, dest }); return true; };

    const n = await ensureRecentThumbnails(root, entries, { download });

    assert.equal(n, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://thumbnails.libretro.com/Sony%20-%20PlayStation/Named_Boxarts/Tekken%203.png');
    assert.equal(calls[0].dest, path.join(root, 'thumbnails', 'Sony - PlayStation', 'Named_Boxarts', 'Tekken 3.png'));
    assert.equal(entries[1].cover, calls[0].dest);
    assert.equal(entries[0].cover, '/already/there.png');
    assert.equal(entries[2].cover, null);
});

test('ensureRecentThumbnails — sets a file already on disk without downloading', async () => {
    const root = tmpDir('gl-ra-ensure2-');
    const dest = path.join(root, 'thumbnails', 'Sony - PlayStation', 'Named_Boxarts', 'Tekken 3.png');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'png');
    const entries = [{ name: 'Tekken 3', cover: null, params: { system: 'Sony - PlayStation' } }];
    let downloadCalled = false;

    const n = await ensureRecentThumbnails(root, entries, { download: async () => { downloadCalled = true; return true; } });

    assert.equal(n, 0);
    assert.equal(downloadCalled, false);
    assert.equal(entries[0].cover, dest);
});

test('ensureRecentThumbnails — on a failed download the cover stays null, does not throw', async () => {
    const root = tmpDir('gl-ra-ensure3-');
    const entries = [{ name: 'Unknown', cover: null, params: { system: 'Sony - PlayStation' } }];

    const n = await ensureRecentThumbnails(root, entries, { download: async () => false });

    assert.equal(n, 0);
    assert.equal(entries[0].cover, null);
});

test('corePathForSystem — gives a path only if the core file is actually on disk', () => {
    const root = tmpDir('gl-ra-cores-');
    fs.mkdirSync(path.join(root, 'cores'));
    fs.writeFileSync(path.join(root, 'cores', 'mesen_libretro.so'), '');

    // `[]` = do not look at the machine's real system libretro folders (machine-independent test).
    assert.equal(
        corePathForSystem(root, 'Nintendo - Nintendo Entertainment System', []),
        path.join(root, 'cores', 'mesen_libretro.so'),
    );
    // Listed in the table, but the file is not on disk (e.g. a removed core) -> null.
    assert.equal(corePathForSystem(root, 'Nintendo - Nintendo 64', []), null);
    assert.equal(corePathForSystem(root, 'Unknown Rendszer', []), null);
});

test('corePathForSystem — native distro package: also searches the libretro folder of the system (after cores/)', () => {
    const root = tmpDir('gl-ra-cores-');
    const sysDir = tmpDir('gl-ra-syscores-');
    fs.writeFileSync(path.join(sysDir, 'mesen_libretro.so'), '');
    assert.equal(corePathForSystem(root, 'Nintendo - Nintendo Entertainment System', [sysDir]),
        path.join(sysDir, 'mesen_libretro.so'));
    fs.mkdirSync(path.join(root, 'cores'));
    fs.writeFileSync(path.join(root, 'cores', 'mesen_libretro.so'), '');
    assert.equal(corePathForSystem(root, 'Nintendo - Nintendo Entertainment System', [sysDir]),
        path.join(root, 'cores', 'mesen_libretro.so'));
});

// A corrupt item (null / number / without path) must not throw away the whole playlist.
test('parsePlaylist / parseContentHistory — skips non-object and path-less items, keeps the rest', () => {
    const text = JSON.stringify({ items: [null, 5, { label: 'no path' }, { label: 'Tekken 3', path: '/r/t3.cue' }] });
    assert.deepEqual(parsePlaylist(text), [{ label: 'Tekken 3', path: '/r/t3.cue' }]);
    assert.deepEqual(parseContentHistory(text).map((g) => g.path), ['/r/t3.cue']);
});
