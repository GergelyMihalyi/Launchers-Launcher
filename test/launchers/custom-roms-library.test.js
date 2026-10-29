'use strict';

// lib/launchers/custom-roms-library.js — custom ROM-folder source for an added launcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, writeFile } = require('../helpers/fs.js');
const roms = require('../../lib/launchers/custom-roms-library.js');

test('normalizeCustomGameSource — absolute folders, `.ext` in lowercase, template without {rom} → default', () => {
    assert.deepEqual(roms.normalizeCustomGameSource({
        launcherId: 'custom-citron', dirs: ['/roms/switch', 'relative', '/roms/switch/'], exts: ['NSP', '.xci', 'bad ext', '.toolongextension'],
        argsTemplate: '--fullscreen',
    }), { launcherId: 'custom-citron', dirs: ['/roms/switch'], exts: ['.nsp', '.xci'], argsTemplate: '{rom}' });
    assert.equal(roms.normalizeCustomGameSource({ launcherId: 'x', dirs: [], exts: ['.iso'] }), null, 'without a folder');
    assert.equal(roms.normalizeCustomGameSource({ launcherId: 'x', dirs: ['/r'], exts: [] }), null, 'without an extension');
    assert.equal(roms.normalizeCustomGameSource({ launcherId: '../x', dirs: ['/r'], exts: ['.iso'] }), null, 'bad id');
    assert.equal(roms.normalizeCustomGameSource(null), null);
});

test('normalizeCustomGameSources — one per launcher (the last wins), the bad one is dropped', () => {
    const list = roms.normalizeCustomGameSources([
        { launcherId: 'a', dirs: ['/1'], exts: ['.iso'] },
        { launcherId: 'b', dirs: [], exts: ['.iso'] },
        { launcherId: 'a', dirs: ['/2'], exts: ['.iso'], argsTemplate: '-f {rom}' },
    ]);
    assert.deepEqual(list, [{ launcherId: 'a', dirs: ['/2'], exts: ['.iso'], argsTemplate: '-f {rom}' }]);
});

test('buildCustomGameArgs — {rom} is one argv element (a path with spaces too), replaces when embedded too', () => {
    assert.deepEqual(roms.buildCustomGameArgs('{rom}', '/My Games/a b.iso'), ['/My Games/a b.iso']);
    assert.deepEqual(roms.buildCustomGameArgs('-f --load={rom} -x', '/r/a.iso'), ['-f', '--load=/r/a.iso', '-x']);
    assert.deepEqual(roms.buildCustomGameArgs('not in it', '/r/a.iso'), ['/r/a.iso'], 'template without {rom} → default');
});

test('scanCustomSource — recursive, by extension, hidden skipped, name from the file name, sorted, stable id', async () => {
    const root = tmpDir();
    writeFile(root, 'Zelda_Breath.nsp', 'x');
    writeFile(root, 'sub/Mario Kart 8.XCI', 'x');
    writeFile(root, 'sub/readme.txt', 'x');
    writeFile(root, '.hidden/Secret.nsp', 'x');
    const src = roms.normalizeCustomGameSource({ launcherId: 'custom-citron', dirs: [root], exts: ['.nsp', '.xci'] });
    const games = await roms.scanCustomSource(src);
    assert.deepEqual(games.map((g) => g.name), ['Mario Kart 8', 'Zelda Breath']);
    assert.equal(games[1].path, path.join(root, 'Zelda_Breath.nsp'));
    assert.equal(games[1].launcherId, 'custom-citron');
    assert.equal(games[1].id, roms.customGameId('custom-citron', games[1].path));
    assert.notEqual(roms.customGameId('a', '/r.iso'), roms.customGameId('b', '/r.iso'), 'the launcher salts the id');
    assert.deepEqual(await roms.scanCustomSource({ ...src, dirs: [path.join(root, 'missing')] }), []);
});

test('isRomInSource — only an existing file under the source folder with a matching extension', () => {
    const root = tmpDir();
    const rom = writeFile(root, 'a.iso', 'x');
    const other = writeFile(tmpDir(), 'b.iso', 'x');
    const txt = writeFile(root, 'c.txt', 'x');
    const src = roms.normalizeCustomGameSource({ launcherId: 'x', dirs: [root], exts: ['.iso'] });
    assert.equal(roms.isRomInSource(src, rom), true);
    assert.equal(roms.isRomInSource(src, other), false, 'another folder');
    assert.equal(roms.isRomInSource(src, txt), false, 'extension');
    assert.equal(roms.isRomInSource(src, path.join(root, 'missing.iso')), false, 'does not exist');
    assert.equal(roms.isRomInSource(src, path.join(root, '..', path.basename(path.dirname(other)), 'b.iso')), false, '.. escape');
    assert.equal(roms.isRomInSource(null, rom), false);
});

test('customGameMeta — recent booked at launch time under the launcher card, custom kind', () => {
    assert.deepEqual(roms.customGameMeta('custom-citron', 'p:1', '', '/r/Zelda_BotW.nsp'), {
        launcherId: 'custom-citron', key: 'custom-game-p:1', name: 'Zelda BotW', cover: null, kind: 'custom',
        params: { launcherId: 'custom-citron', path: '/r/Zelda_BotW.nsp' },
    });
});

// Symlinked ROM folder / file, junk files, circular symlink.
test('scanCustomSource — follows a symlink, ._ / trash is skipped, the cycle does not repeat', async () => {
    const fs = require('node:fs');
    const root = tmpDir();
    writeFile(root, 'disk/Game One.iso', 'x');
    writeFile(root, 'disk/._Game One.iso', 'x');
    writeFile(root, 'disk/$RECYCLE.BIN/$R1.iso', 'x');
    writeFile(root, 'roms/own.iso', 'x');
    fs.symlinkSync(path.join(root, 'disk'), path.join(root, 'roms', 'linked'));
    fs.symlinkSync(path.join(root, 'roms'), path.join(root, 'disk', 'loop'));
    const games = await roms.scanCustomSource({ launcherId: 'x', dirs: [path.join(root, 'roms')], exts: ['.iso'], argsTemplate: '{rom}' }, { maxDepth: 6 });
    assert.deepEqual(games.map((g) => path.relative(root, g.path)).sort(), [path.join('roms', 'linked', 'Game One.iso'), path.join('roms', 'own.iso')]);
});
