'use strict';

// lib/launchers/shared/cover-override.js — the manual cover override.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, writeFile } = require('../../helpers/fs.js');
const {
    coverOverrideRoot, overrideFileBase, loadCoverOverrides, findCoverOverride,
    coverOverrideSuggestion, overrideTargetForKey, applyCoverOverrides, applyCoverOverridesToEntries,
    listCoverImages, installCoverOverride, removeCoverOverride,
} = require('../../../lib/launchers/shared/cover-override.js');

const NES = 'Nintendo - Nintendo Entertainment System';

function fixtureRoot() {
    const root = path.join(tmpDir('gl-cover-ovr-'), 'covers');
    writeFile(root, 'pcsx2/SCUS-97472.png', 'x');
    writeFile(root, 'steam/620.JPG', 'x');
    writeFile(root, 'rpcs3/BLUS30001.webp', 'x');
    writeFile(root, 'heroic/Hades.png', 'x');
    writeFile(root, `retroarch/${NES}/Zelda: Link.png`, 'x'); // named by hand with `:`
    writeFile(root, 'pcsx2/readme.txt', 'not an image');
    return root;
}

test('the root is ~/Pictures/launchers-launcher/covers (under the wallpaper folder)', () => {
    assert.equal(coverOverrideRoot('/home/x'), '/home/x/Pictures/launchers-launcher/covers');
});

test('overrideFileBase — the RetroArch thumbnail rule (`& * / : \\` < > ? |` → `_`)', () => {
    assert.equal(overrideFileBase('Zelda: Link/Past?'), 'Zelda_ Link_Past_');
    assert.equal(overrideFileBase('p:0123abcd'), 'p_0123abcd');
    assert.equal(overrideFileBase('SCUS-97472'), 'SCUS-97472');
});

test('missing root → empty map, the list is UNCHANGED (the same array)', () => {
    const root = path.join(tmpDir(), 'missing');
    const rows = [{ id: 'SCUS-97472', cover: null }];
    assert.equal(loadCoverOverrides(root).size, 0);
    assert.equal(applyCoverOverrides(rows, (r) => ({ source: 'pcsx2', id: r.id }), root), rows);
    assert.equal(findCoverOverride('pcsx2', 'SCUS-97472', root), null);
});

test('findCoverOverride — case-insensitive, only image extensions, RetroArch system folder', () => {
    const root = fixtureRoot();
    assert.equal(findCoverOverride('pcsx2', 'scus-97472', root), path.join(root, 'pcsx2/SCUS-97472.png'));
    assert.equal(findCoverOverride('steam', 620, root), path.join(root, 'steam/620.JPG'));
    assert.equal(findCoverOverride('pcsx2', 'readme', root), null);
    assert.equal(findCoverOverride(`retroarch/${NES}`, 'Zelda: Link', root),
        path.join(root, 'retroarch', NES, 'Zelda: Link.png'));
    assert.equal(findCoverOverride('pcsx2', '', root), null);
});

test('applyCoverOverrides — only the overridden row becomes a copy, the input is untouched', () => {
    const root = fixtureRoot();
    const a = { id: 'SCUS-97472', cover: '/cache/a.jpg' };
    const b = { id: 'SLUS-00001', cover: '/cache/b.jpg' };
    const rows = [a, b];
    const out = applyCoverOverrides(rows, (r) => ({ source: 'pcsx2', id: r.id }), root);
    assert.notEqual(out, rows);
    assert.equal(out[0].cover, path.join(root, 'pcsx2/SCUS-97472.png'));
    assert.equal(out[1], b);
    assert.equal(a.cover, '/cache/a.jpg', 'the cached object must not be modifiable');
    // No matching row → the same array.
    assert.equal(applyCoverOverrides([b], (r) => ({ source: 'pcsx2', id: r.id }), root).length, 1);
    const same = [b];
    assert.equal(applyCoverOverrides(same, (r) => ({ source: 'pcsx2', id: r.id }), root), same);
});

test('new file → the next call already sees it (mtime signature), deletion → it disappears', () => {
    const root = fixtureRoot();
    assert.equal(findCoverOverride('dolphin', 'GALE01', root), null);
    const f = writeFile(root, 'dolphin/GALE01.png', 'x');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'dolphin'), future, future);
    fs.utimesSync(root, future, future);
    assert.equal(findCoverOverride('dolphin', 'GALE01', root), f);
    fs.rmSync(f);
    const later = new Date(Date.now() + 10000);
    fs.utimesSync(path.join(root, 'dolphin'), later, later);
    assert.equal(findCoverOverride('dolphin', 'GALE01', root), null);
});

test('overrideTargetForKey — the recent/favorite keys', () => {
    assert.deepEqual(overrideTargetForKey('steam-game-620'), { source: 'steam', id: '620' });
    assert.deepEqual(overrideTargetForKey('heroic-game-Hades'), { source: 'heroic', id: 'Hades' });
    assert.deepEqual(overrideTargetForKey('melonds-game-p:0123'), { source: 'melonds', id: 'p:0123' });
    assert.deepEqual(overrideTargetForKey(`retroarch:${NES}:Zelda: Link`), { source: `retroarch/${NES}`, id: 'Zelda: Link' });
    assert.equal(overrideTargetForKey('something'), null);
    assert.equal(overrideTargetForKey(undefined), null);
});

test('applyCoverOverridesToEntries — by the key', () => {
    const root = fixtureRoot();
    const list = [
        { key: 'rpcs3-game-BLUS30001', cover: null },
        { key: `retroarch:${NES}:Zelda: Link`, cover: null },
        { key: 'heroic-game-Hades', cover: '/x.jpg' },
        { key: 'cemu-game-000500001010ec00', cover: '/c.png' },
    ];
    const out = applyCoverOverridesToEntries(list, root);
    assert.equal(out[0].cover, path.join(root, 'rpcs3/BLUS30001.webp'));
    assert.equal(out[1].cover, path.join(root, 'retroarch', NES, 'Zelda: Link.png'));
    assert.equal(out[2].cover, path.join(root, 'heroic/Hades.png'));
    assert.equal(out[3], list[3]);
});

test('coverOverrideSuggestion — the PNG path, with the cleaned file name', () => {
    assert.equal(coverOverrideSuggestion('melonds', 'p:ab', '/r'), '/r/melonds/p_ab.png');
    assert.equal(coverOverrideSuggestion(`retroarch/${NES}`, 'A/B', '/r'), `/r/retroarch/${NES}/A_B.png`);
    assert.equal(coverOverrideSuggestion('steam', '', '/r'), null);
});

// --- Manual cover picker ---

function pickerHome() {
    const home = tmpDir('gl-cover-pick-');
    writeFile(home, 'Pictures/launchers-launcher/a.png', 'AAAA');
    writeFile(home, 'Pictures/b.jpg', 'BBBB');
    writeFile(home, 'Downloads/c.webp', 'CCCC');
    writeFile(home, 'Downloads/notes.txt', 'not an image');
    writeFile(home, 'Documents/secret.png', 'not in the selectable folders');
    return home;
}

test('listCoverImages — only the direct image files of the three folders; an empty file / non-image is dropped', async () => {
    const home = pickerHome();
    writeFile(home, 'Pictures/empty.png', '');
    const list = await listCoverImages(home);
    assert.deepEqual(list.map((x) => x.name).sort(), ['a.png', 'b.jpg', 'c.webp']);
    assert.deepEqual(await listCoverImages(tmpDir('gl-cover-nohome-')), []);
});

test('installCoverOverride — the image is copied to the place per the override convention, the old version is replaced', async () => {
    const home = pickerHome();
    const root = coverOverrideRoot(home);
    writeFile(root, 'steam/620.jpg', 'OLD');
    const res = await installCoverOverride({ key: 'steam-game-620', srcPath: path.join(home, 'Pictures/launchers-launcher/a.png'), home });
    assert.equal(res.ok, true);
    assert.equal(res.dest, path.join(root, 'steam', '620.png'));
    assert.equal(fs.readFileSync(res.dest, 'utf8'), 'AAAA');
    assert.equal(fs.existsSync(path.join(root, 'steam', '620.jpg')), false); // the one with the old extension is deleted
    assert.equal(fs.existsSync(path.join(home, 'Pictures/launchers-launcher/a.png')), true); // the original stays
    assert.equal(findCoverOverride('steam', '620', root), res.dest);
    // RetroArch: system subfolder + cleaned title
    const ra = await installCoverOverride({ key: `retroarch:${NES}:Zelda: Link`, srcPath: path.join(home, 'Pictures/b.jpg'), home });
    assert.equal(ra.ok, true);
    assert.equal(ra.dest, path.join(root, 'retroarch', NES, 'Zelda_ Link.jpg'));
});

test('installCoverOverride — an arbitrary / out-of-folder file, bad key, symlink trick rejected', async () => {
    const home = pickerHome();
    const outside = path.join(home, 'Documents/secret.png');
    assert.equal((await installCoverOverride({ key: 'steam-game-1', srcPath: outside, home })).error, 'not-in-picker-dir');
    assert.equal((await installCoverOverride({ key: 'steam-game-1', srcPath: path.join(home, 'Pictures/notes.txt'), home })).ok, false);
    assert.equal((await installCoverOverride({ key: 'rossz-kulcs', srcPath: path.join(home, 'Pictures/b.jpg'), home })).error, 'invalid-key');
    assert.equal((await installCoverOverride({ key: 'retroarch:..:x', srcPath: path.join(home, 'Pictures/b.jpg'), home })).error, 'invalid-key');
    // a symlink in Pictures to Documents → the realpath's folder can no longer be picked
    fs.symlinkSync(outside, path.join(home, 'Pictures/link.png'));
    assert.equal((await installCoverOverride({ key: 'steam-game-1', srcPath: path.join(home, 'Pictures/link.png'), home })).error, 'not-in-picker-dir');
});

test('removeCoverOverride — deletes the override of the game, not the others', async () => {
    const home = pickerHome();
    const root = coverOverrideRoot(home);
    writeFile(root, 'steam/620.png', 'x');
    writeFile(root, 'steam/730.png', 'y');
    assert.deepEqual(await removeCoverOverride({ key: 'steam-game-620', home }), { ok: true, removed: 1 });
    assert.equal(fs.existsSync(path.join(root, 'steam/620.png')), false);
    assert.equal(fs.existsSync(path.join(root, 'steam/730.png')), true);
    assert.equal((await removeCoverOverride({ key: 'rossz', home })).ok, false);
});
