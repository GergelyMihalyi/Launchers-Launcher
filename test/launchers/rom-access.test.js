'use strict';

// lib/launchers/rom-access.js — sandbox visibility of the flatpak emulators' ROM folders.
// The pure matching against the `filesystems=` entries of `flatpak info --show-permissions`;
// the checker is in test/ipc/game-sources-ipc.test.js (via IPC).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, writeFile } = require('../helpers/fs.js');
const {
    resolveFsEntry, flatpakSees, checkRomDirAccess, readUserDirs, readRomDirs,
} = require('../../lib/launchers/rom-access.js');

const ENV = {
    home: '/home/user', runtimeDir: '/run/user/1000', appId: 'net.pcsx2.PCSX2',
    userDirs: { XDG_DOWNLOAD_DIR: '/home/user/Downloads' },
};
const sees = (dir, fsList) => flatpakSees(dir, fsList, ENV);

test('resolveFsEntry — the roots of the entry kinds, suffix and denial', () => {
    assert.deepEqual(resolveFsEntry('host', ENV).roots, ['/']);
    assert.equal(resolveFsEntry('host', ENV).kind, 'host');
    assert.deepEqual(resolveFsEntry('home:ro', ENV).roots, ['/home/user']);
    assert.deepEqual(resolveFsEntry('~/Games/', ENV).roots, ['/home/user/Games']);
    assert.deepEqual(resolveFsEntry('xdg-run/gvfs', ENV).roots, ['/run/user/1000/gvfs']);
    assert.deepEqual(resolveFsEntry('xdg-download/roms:create', ENV).roots, ['/home/user/Downloads/roms']);
    assert.deepEqual(resolveFsEntry('xdg-videos', ENV).roots, ['/home/user/Videos'], 'the base name without user-dirs');
    assert.deepEqual(resolveFsEntry('xdg-data/roms', ENV).roots, ['/home/user/.local/share/roms']);
    assert.deepEqual(resolveFsEntry('/mnt/roms/:rw', ENV).roots, ['/mnt/roms']);
    const neg = resolveFsEntry('!/mnt/roms/private', ENV);
    assert.equal(neg.negated, true);
    assert.deepEqual(neg.roots, ['/mnt/roms/private']);
    assert.equal(resolveFsEntry('host-reserved', ENV), null, 'unknown → null');
    assert.equal(resolveFsEntry('', ENV), null);
});

test('flatpakSees — home / specific folder / host', () => {
    assert.equal(sees('/home/user/roms/ps2', ['home']), true);
    assert.equal(sees('/mnt/roms/ps2', ['home']), false, 'home does not open an NFS folder outside $HOME');
    assert.equal(sees('/mnt/roms/ps2', ['/mnt/roms']), true);
    assert.equal(sees('/mnt/roms2', ['/mnt/roms']), false, 'a prefix match is not enough (roms2 ≠ roms/…)');
    assert.equal(sees('/mnt/roms', ['/mnt/roms:ro']), true);
    assert.equal(sees('/run/media/user/USB/roms', ['host']), true);
    assert.equal(sees('/home/user/Games', []), false);
});

test('flatpakSees — the most specific entry wins, the denial too', () => {
    assert.equal(sees('/home/user/private/roms', ['home', '!~/private']), false);
    assert.equal(sees('/home/user/private/roms', ['!~/private', '~/private/roms']), true);
    assert.equal(sees('/home/user/x', ['host', '!home']), false);
    assert.equal(sees('/mnt/x', ['host', '!home']), true);
});

test('flatpakSees — host does not open the runtime directory (gvfs Samba share) and the system folders', () => {
    const gvfs = '/run/user/1000/gvfs/smb-share:server=nas,share=roms/ps2';
    assert.equal(sees(gvfs, ['host']), false);
    assert.equal(sees(gvfs, ['xdg-run/gvfs']), true);
    assert.equal(sees('/usr/share/games/roms', ['host']), false);
    assert.equal(sees('/usr/share/games/roms', ['host-os']), true);
});

test('flatpakSees — the document portal and the app\'s own ~/.var/app folder are visible without permission too', () => {
    assert.equal(sees('/run/user/1000/doc/abc123/PS2', []), true);
    assert.equal(sees('/home/user/.var/app/net.pcsx2.PCSX2/roms', []), true);
    assert.equal(sees('/home/user/.var/app/org.other.App/roms', []), false);
});

test('checkRomDirAccess — symlinked folder: the TARGET must be visible, unless the link was named specifically', () => {
    const dirs = [{ dir: '/home/user/roms', real: '/mnt/ntfs/ROMs' }];
    assert.deepEqual(checkRomDirAccess(dirs, ['home'], ENV), [{ dir: '/home/user/roms', visible: false }]);
    assert.deepEqual(checkRomDirAccess(dirs, ['home', '/mnt/ntfs'], ENV), [{ dir: '/home/user/roms', visible: true }]);
    assert.deepEqual(checkRomDirAccess(dirs, ['~/roms'], ENV), [{ dir: '/home/user/roms', visible: true }]);
    assert.deepEqual(checkRomDirAccess([{ dir: '/mnt/x', real: null }], ['/mnt'], ENV), [{ dir: '/mnt/x', visible: true }]);
});

test('readUserDirs — the $HOME-relative lines of user-dirs.dirs; missing file → {}', () => {
    const home = tmpDir('gl-userdirs-');
    assert.deepEqual(readUserDirs(home), {});
    writeFile(home, '.config/user-dirs.dirs', '# comment\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_MUSIC_DIR="/data/music"\n');
    assert.deepEqual(readUserDirs(home), {
        XDG_DOWNLOAD_DIR: path.join(home, 'Downloads'), XDG_MUSIC_DIR: '/data/music',
    });
});

test('readRomDirs — readGameDirs of the library + realpath (array and Dolphin-style { dirs } shape)', () => {
    const root = tmpDir('gl-romdirs-');
    const target = path.join(root, 'ntfs', 'PS2');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(root, 'ps2link'));
    writeFile(root, 'cfg/inis/PCSX2.ini', `[GameList]\nRecursivePaths = ${path.join(root, 'ps2link')}\n`);
    assert.deepEqual(readRomDirs('pcsx2', [path.join(root, 'cfg')]), [
        { dir: path.join(root, 'ps2link'), real: fs.realpathSync(target) },
    ]);
    writeFile(root, 'dolphin/Dolphin.ini', `[General]\nISOPaths = 1\nISOPath0 = ${target}\n`);
    assert.deepEqual(readRomDirs('dolphin', [path.join(root, 'dolphin')]), [{ dir: target, real: fs.realpathSync(target) }]);
    assert.throws(() => readRomDirs('no-such', []), /unknown emulator/);
});
