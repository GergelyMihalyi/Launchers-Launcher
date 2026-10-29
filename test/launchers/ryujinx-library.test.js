'use strict';

// lib/launchers/ryujinx-library.js — Ryujinx (Switch) ROM discovery.
// The sample files follow the structure of the "Switch Games" folder actually found on the machine
// (scene-release NFOs, own-dump title-id bracket, Update folders/files).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, withTempHome, mkdirp } = require('../helpers/fs.js');
const {
    readGameDirs, isLikelyUpdateOrDlc, extractTitleIdFromName, findSidecarInfo,
    ryujinxGameLabel, findInstalledGames, ryujinxCoverPath, resolveRyujinxCover,
    nlibIconUrl, ensureRyujinxCovers,
    ryujinxGameArgs,
} = require('../../lib/launchers/ryujinx-library.js');

test('readGameDirs — deduped union of game_dirs + autoload_dirs, only existing folders', () => {
    const root = tmpDir('gl-ry-cfg-');
    const gamesDir = tmpDir('gl-ry-games-');
    fs.writeFileSync(path.join(root, 'Config.json'), JSON.stringify({
        game_dirs: [gamesDir, '/does/not/exist/somewhere'],
        autoload_dirs: [gamesDir, '/other/does/not/exist'],
    }));
    assert.deepEqual(readGameDirs(root), [gamesDir]);
});

test('readGameDirs — an empty list for a missing/bad Config.json, does not throw', () => {
    const root = tmpDir('gl-ry-cfg-');
    assert.deepEqual(readGameDirs(root), []);
    fs.writeFileSync(path.join(root, 'Config.json'), 'not json');
    assert.deepEqual(readGameDirs(root), []);
});

test('isLikelyUpdateOrDlc — update/dlc/patch/upd substring match (without a separator too)', () => {
    assert.equal(isLikelyUpdateOrDlc('Metroid_Dread_Update_v2.0.0_NSW-VENOM'), true);
    assert.equal(isLikelyUpdateOrDlc('Super Mario Odyssey [UPD][0100000000010800][v196608].nsp'), true);
    assert.equal(isLikelyUpdateOrDlc('mariokart8deluxeupd17.nsp'), true); // "upd" without a separator
    assert.equal(isLikelyUpdateOrDlc('Super Mario Odyssey [0100000000010000][v0].nsp'), false);
    assert.equal(isLikelyUpdateOrDlc('mariokart8deluxe.nsp'), false);
});

test('extractTitleIdFromName — 16 hex digit [...] pattern, null if unknown', () => {
    assert.equal(
        extractTitleIdFromName('The Legend of Zelda Tears of the Kingdom [0100f2c0115b6000][v0].xci'),
        '0100F2C0115B6000',
    );
    assert.equal(extractTitleIdFromName('v-metroid_dread.xci'), null);
});

test('findSidecarInfo — reads the "Title :" + "Title ID :" lines of the scene NFO (plain AND dot-padded formatting)', () => {
    const dir = tmpDir('gl-ry-nfo-');
    fs.writeFileSync(path.join(dir, 'v-metroid_dread.nfo'), [
        '  |       Title : Metroid Dread                                             |',
        '  |       Genre : Action / Adventure          Title ID : 010093801237C000   |',
    ].join('\n'));
    assert.deepEqual(findSidecarInfo(dir), { titleId: '010093801237C000', title: 'Metroid Dread' });
});

test('findSidecarInfo — dot-padded "Title ID..............:" format (NiiNTENDO sample)', () => {
    const dir = tmpDir('gl-ry-nfo-');
    fs.writeFileSync(path.join(dir, 'n-tlozeow.nfo'), 'Title ID..............: 01008CF01BAAC000\n');
    assert.deepEqual(findSidecarInfo(dir), { titleId: '01008CF01BAAC000', title: null });
});

test('findSidecarInfo — no .nfo/.txt or nothing in them -> { titleId: null, title: null }', () => {
    const dir = tmpDir('gl-ry-nfo-');
    assert.deepEqual(findSidecarInfo(dir), { titleId: null, title: null });
    fs.writeFileSync(path.join(dir, 'readme.nfo'), 'nothing useful in this file');
    assert.deepEqual(findSidecarInfo(dir), { titleId: null, title: null });
});

test('ryujinxGameLabel — strips the extension/bracket/version tag/NSW scene tag', () => {
    assert.equal(
        ryujinxGameLabel('The Legend of Zelda Tears of the Kingdom [0100F2C0115B6000][v0].xci'),
        'The Legend of Zelda Tears of the Kingdom',
    );
    assert.equal(ryujinxGameLabel('Super_Mario_Bros_Wonder_NSW-LiGHTFORCE'), 'Super Mario Bros Wonder');
    assert.equal(ryujinxGameLabel('Metroid_Dread_NSW-VENOM'), 'Metroid Dread');
});

test('findInstalledGames — walks game_dirs, skips Update/DLC-suspect files, uses the NFO/bracket title id + the official title', () => {
    const configRoot = tmpDir('gl-ry-cfg-');
    const gamesDir = tmpDir('gl-ry-games-');
    fs.writeFileSync(path.join(configRoot, 'Config.json'), JSON.stringify({ game_dirs: [gamesDir] }));

    // 1. Scene release: folder name with a cryptic file name, title + title id in the NFO.
    const metroidDir = path.join(gamesDir, 'Metroid_Dread_NSW-VENOM');
    mkdirp(metroidDir);
    fs.writeFileSync(path.join(metroidDir, 'v-metroid_dread.xci'), 'x');
    fs.writeFileSync(path.join(metroidDir, 'v-metroid_dread.nfo'), [
        '  |       Title : Metroid Dread                                             |',
        '  |       Genre : Action          Title ID : 010093801237C000               |',
    ].join('\n'));

    // 2. Update folder next to metroid — skipped entirely.
    const metroidUpdateDir = path.join(gamesDir, 'Metroid_Dread_Update_v2.0.0_NSW-VENOM');
    mkdirp(metroidUpdateDir);
    fs.writeFileSync(path.join(metroidUpdateDir, 'v-metroid_dread_v262144.nsp'), 'x');

    // 3. Own dump, flat file in the root, with a bracket title id, no NFO.
    fs.writeFileSync(
        path.join(gamesDir, 'The Legend of Zelda Tears of the Kingdom [0100F2C0115B6000][v0].xci'), 'x',
    );

    // 4. An update file in the same folder marked "upd" without a separator — skipped.
    const mk8Dir = path.join(gamesDir, 'Mario Kart 8 Deluxe');
    mkdirp(mk8Dir);
    fs.writeFileSync(path.join(mk8Dir, 'mariokart8deluxe.nsp'), 'x');
    fs.writeFileSync(path.join(mk8Dir, 'mariokart8deluxeupd17.nsp'), 'x');

    // 5. No NFO, no bracket, no recognizable scene tag -> fallback name from the cleaned file name.
    const partyDir = path.join(gamesDir, 'Super Mario Party Jamboree');
    mkdirp(partyDir);
    fs.writeFileSync(path.join(partyDir, 'Super Mario Party Jamboree.xci'), 'x');

    // Not a ROM extension — skipped.
    fs.writeFileSync(path.join(gamesDir, 'olvasdel.txt'), 'x');

    const games = findInstalledGames(configRoot);
    const names = games.map((g) => g.name).sort();
    assert.deepEqual(names, [
        'Mario Kart 8 Deluxe', 'Metroid Dread', 'Super Mario Party Jamboree',
        'The Legend of Zelda Tears of the Kingdom',
    ].sort());

    const metroid = games.find((g) => g.name === 'Metroid Dread');
    assert.equal(metroid.titleId, '010093801237C000');
    assert.equal(metroid.id, '010093801237C000');

    const totk = games.find((g) => g.name === 'The Legend of Zelda Tears of the Kingdom');
    assert.equal(totk.titleId, '0100F2C0115B6000');

    const party = games.find((g) => g.name === 'Super Mario Party Jamboree');
    assert.equal(party.titleId, null);
    assert.match(party.id, /^p:[0-9a-f]{16}$/); // path-hash substitute, not a real title id
});

test('findInstalledGames — an empty list for empty/missing game_dirs', () => {
    const configRoot = tmpDir('gl-ry-cfg-');
    assert.deepEqual(findInstalledGames(configRoot), []);
});

test('ryujinxCoverPath / resolveRyujinxCover — returns only a file that actually exists on disk', () => {
    return withTempHome(() => {
        assert.equal(resolveRyujinxCover('010093801237C000'), null);
        const dest = ryujinxCoverPath('010093801237C000');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'jpeg-bytes');
        assert.equal(resolveRyujinxCover('010093801237C000'), dest);
        assert.equal(resolveRyujinxCover(null), null);
    }, 'gl-ry-home-');
});

test('nlibIconUrl — title ID -> api.nlib.cc icon URL', () => {
    assert.equal(nlibIconUrl('010093801237C000'), 'https://api.nlib.cc/nx/010093801237C000/icon/256');
    assert.equal(nlibIconUrl('010093801237C000', 512), 'https://api.nlib.cc/nx/010093801237C000/icon/512');
});

test('ensureRyujinxCovers — downloads only the entry without a cover that carries a titleId, cover in place', async () => {
    return withTempHome(async () => {
        const calls = [];
        const entries = [
            { name: 'Already has', cover: '/already/there.jpg', params: { titleId: 'AAAA000000000000' } },
            { name: 'Needs a cover', cover: null, params: { titleId: '010093801237C000' } },
            { name: 'No title id', cover: null, params: {} },
        ];
        const download = async (url, dest) => { calls.push({ url, dest }); return true; };

        const n = await ensureRyujinxCovers(entries, { download });

        assert.equal(n, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.nlib.cc/nx/010093801237C000/icon/256');
        assert.equal(entries[1].cover, calls[0].dest);
        assert.equal(entries[2].cover, null);
    }, 'gl-ry-home-');
});

test('ensureRyujinxCovers — a failed download does not set the cover, does not throw', async () => {
    return withTempHome(async () => {
        const entries = [{ name: 'X', cover: null, params: { titleId: 'FFFF000000000000' } }];
        const n = await ensureRyujinxCovers(entries, { download: async () => false });
        assert.equal(n, 0);
        assert.equal(entries[0].cover, null);
    }, 'gl-ry-home-');
});

// The launch argument list (the descriptor's `launch.args`, lib/launchers/emulator-sources.js).
test('ryujinxGameArgs — flatpak run Ryujinx <romPath>', () => {
    assert.deepEqual(ryujinxGameArgs('/roms/switch/game.xci'), [
        'run', 'io.github.ryubing.Ryujinx', '/roms/switch/game.xci',
    ]);
});
