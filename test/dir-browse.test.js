'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers/fs.js');

const {
    listSubdirs, isDirectory, isInsideDir, filterExistingDirs, walkFilesByExtension, isJunkEntry,
} = require('../lib/dir-browse.js');

test('listSubdirs: returns only the folders, without hidden folders, sorted', () => {
    const root = tmpDir('gl-dirbrowse-');
    fs.mkdirSync(path.join(root, 'Zelda'));
    fs.mkdirSync(path.join(root, 'Alpha'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'not-a-dir.txt'), 'x');
    const res = listSubdirs(root);
    assert.deepEqual(res.dirs.map((d) => d.name), ['Alpha', 'Zelda']);
    assert.equal(res.dirs[0].path, path.join(root, 'Alpha'));
    assert.equal(res.path, path.resolve(root));
});

test('listSubdirs: parent is the path of the parent, null at the root', () => {
    const root = tmpDir('gl-dirbrowse-');
    fs.mkdirSync(path.join(root, 'sub'));
    const res = listSubdirs(path.join(root, 'sub'));
    assert.equal(res.parent, root);

    const fsRoot = path.parse(root).root;
    const rootRes = listSubdirs(fsRoot);
    assert.equal(rootRes.parent, null);
});

test('listSubdirs: throws for a nonexistent folder', () => {
    assert.throws(() => listSubdirs('/no/such/dir/surely-1234'));
});

test('isDirectory: true for a folder, false for a file/nonexistent', () => {
    const root = tmpDir('gl-dirbrowse-');
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(isDirectory(root), true);
    assert.equal(isDirectory(file), false);
    assert.equal(isDirectory(path.join(root, 'missing')), false);
});

test('isInsideDir: a subfolder and the parent itself are "inside", a sibling/outside folder is not', () => {
    assert.equal(isInsideDir('/home/user/roms', '/home/user'), true);
    assert.equal(isInsideDir('/home/user', '/home/user'), true); // itself = "inside"
    assert.equal(isInsideDir('/home/userX', '/home/user'), false); // name-prefix trap, NOT a subfolder
    assert.equal(isInsideDir('/mnt/Download/nds', '/home/user'), false);
    assert.equal(isInsideDir('/home', '/home/user'), false); // the parent itself can NOT be under the child
});

// filterExistingDirs — the shared dedup + existence filter core of the launcher modules'
// readGameDirs().
test('filterExistingDirs: dedups (order-preserving) and keeps only the folders that actually exist', () => {
    const root = tmpDir('gl-dirbrowse-');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const missing = path.join(root, 'no-such');
    assert.deepEqual(filterExistingDirs([a, missing, b, a]), [a, b]);
});

test('filterExistingDirs: an empty array for non-array/empty/invalid input, does not throw', () => {
    assert.deepEqual(filterExistingDirs(undefined), []);
    assert.deepEqual(filterExistingDirs([]), []);
    assert.deepEqual(filterExistingDirs([null, '', 42]), []);
});

test('filterExistingDirs: a path pointing to a file (not a folder) is dropped', () => {
    const root = tmpDir('gl-dirbrowse-');
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'x');
    assert.deepEqual(filterExistingDirs([file]), []);
});

// walkFilesByExtension — the shared recursive walker core of the launcher modules' ROM/disc-image
// scanners.
test('walkFilesByExtension: recursively collects the files with the given extension, case-insensitively', () => {
    const root = tmpDir('gl-dirbrowse-');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'a.NDS'), '');
    fs.writeFileSync(path.join(root, 'b.txt'), '');
    fs.writeFileSync(path.join(root, 'sub', 'c.nds'), '');
    const found = walkFilesByExtension(root, new Set(['.nds']));
    assert.deepEqual(
        found.map((f) => path.relative(root, f)).sort(),
        [path.join('sub', 'c.nds'), 'a.NDS'].sort(),
    );
});

test('walkFilesByExtension: with recursive:false it only looks at the direct files of the root', () => {
    const root = tmpDir('gl-dirbrowse-');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'top.iso'), '');
    fs.writeFileSync(path.join(root, 'sub', 'nested.iso'), '');
    assert.deepEqual(
        walkFilesByExtension(root, new Set(['.iso']), { recursive: false }),
        [path.join(root, 'top.iso')],
    );
});

test('walkFilesByExtension: maxDepth limits the depth of the walk', () => {
    const root = tmpDir('gl-dirbrowse-');
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'shallow.iso'), '');
    fs.writeFileSync(path.join(deep, 'deep.iso'), '');
    const found = walkFilesByExtension(root, new Set(['.iso']), { maxDepth: 1 });
    assert.deepEqual(found, [path.join(root, 'a', 'shallow.iso')]);
});

test('walkFilesByExtension: an empty array for a nonexistent root, does not throw', () => {
    assert.deepEqual(walkFilesByExtension('/no/such/dir/surely-1234', new Set(['.iso'])), []);
});

// --- Symlinks + junk files ---

// A typical local setup: the ROM folder points to another drive with symlinks.
function symlinkFixture() {
    const root = tmpDir('gl-rom-links-');
    const disk = path.join(root, 'ntfs');
    fs.mkdirSync(path.join(disk, 'PS2', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(disk, 'PS2', 'a.iso'), 'x');
    fs.writeFileSync(path.join(disk, 'PS2', 'sub', 'b.iso'), 'x');
    fs.writeFileSync(path.join(disk, 'single.iso'), 'x');
    const roms = path.join(root, 'roms');
    fs.mkdirSync(roms);
    fs.symlinkSync(path.join(disk, 'PS2'), path.join(roms, 'ps2'));          // symlinked folder
    fs.symlinkSync(path.join(disk, 'single.iso'), path.join(roms, 'one.iso')); // symlinked file
    fs.symlinkSync(path.join(root, 'missing.iso'), path.join(roms, 'broken.iso')); // broken symlink
    fs.symlinkSync(roms, path.join(disk, 'PS2', 'vissza'));                  // circular: the PS2 → back to roms
    return { root, roms };
}

test('walkFilesByExtension — walks symlinked folders and files too, the broken one is dropped, the cycle does not repeat', () => {
    const { roms } = symlinkFixture();
    const found = walkFilesByExtension(roms, new Set(['.iso']), { maxDepth: 5 }).map((p) => path.relative(roms, p)).sort();
    assert.deepEqual(found, ['one.iso', path.join('ps2', 'a.iso'), path.join('ps2', 'sub', 'b.iso')]);
});

test('walkFilesByExtension — macOS ._ files, the trash and the system folders are skipped', () => {
    const root = tmpDir('gl-rom-junk-');
    for (const rel of ['Game.iso', '._Game.iso', '.DS_Store', '$RECYCLE.BIN/S-1-5/$R1.iso',
        'System Volume Information/x.iso', '.Trash-1000/files/old.iso', 'sub/Other.ISO']) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), 'x');
    }
    const found = walkFilesByExtension(root, new Set(['.iso']), { maxDepth: 5 }).map((p) => path.relative(root, p)).sort();
    assert.deepEqual(found, ['Game.iso', path.join('sub', 'Other.ISO')]);
});

test('isJunkEntry — case-insensitive', () => {
    for (const n of ['._x.nds', '$Recycle.Bin', 'SYSTEM VOLUME INFORMATION', 'Thumbs.db', '.Trash-1000', 'lost+found']) {
        assert.equal(isJunkEntry(n), true, n);
    }
    for (const n of ['Game.iso', 'Recycle', '_x.iso', '.hidden-but-not-junk']) assert.equal(isJunkEntry(n), false, n);
});

test('listSubdirs — also shows the symlinked folder (selectable in the folder browser), not the trash', () => {
    const { roms } = symlinkFixture();
    fs.mkdirSync(path.join(roms, '$RECYCLE.BIN'));
    assert.deepEqual(listSubdirs(roms).dirs.map((d) => d.name), ['ps2']);
});
