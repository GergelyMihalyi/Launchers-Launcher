'use strict';

// lib/xdg.js — flatpak config-root helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
    flatpakConfigRoot, flatpakDataRoot, flatpakCacheRoot, translateFlatpakDocPath, dataHome,
    setAppVariants, appVariant, appConfigRoot, appDataRoot, appCacheRoot,
} = require('../lib/xdg.js');
const { withTempHome, mkdirp } = require('./helpers/fs.js');

test('flatpakConfigRoot — ~/.var/app/<appId>/config/<appName>', () => {
    assert.equal(
        flatpakConfigRoot('org.libretro.RetroArch', 'retroarch', '/home/u'),
        path.join('/home/u', '.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch'),
    );
    assert.equal(
        flatpakConfigRoot('com.heroicgameslauncher.hgl', 'heroic', '/home/u'),
        path.join('/home/u', '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic'),
    );
});

test('flatpakConfigRoot — homeDir defaults to os.homedir()', () => {
    const r = flatpakConfigRoot('com.example.App', 'example');
    assert.ok(r.endsWith(path.join('.var', 'app', 'com.example.App', 'config', 'example')));
    assert.ok(path.isAbsolute(r));
});

test('flatpakDataRoot — ~/.var/app/<appId>/data/<appName> (the mlc01 of Cemu goes here)', () => {
    assert.equal(
        flatpakDataRoot('info.cemu.Cemu', 'Cemu', '/home/u'),
        path.join('/home/u', '.var', 'app', 'info.cemu.Cemu', 'data', 'Cemu'),
    );
});

test('flatpakDataRoot — homeDir defaults to os.homedir()', () => {
    const r = flatpakDataRoot('com.example.App', 'example');
    assert.ok(r.endsWith(path.join('.var', 'app', 'com.example.App', 'data', 'example')));
    assert.ok(path.isAbsolute(r));
});

test('flatpakCacheRoot — ~/.var/app/<appId>/cache/<appName> (the GameCovers cache of Dolphin goes here)', () => {
    assert.equal(
        flatpakCacheRoot('org.DolphinEmu.dolphin-emu', 'dolphin-emu', '/home/u'),
        path.join('/home/u', '.var', 'app', 'org.DolphinEmu.dolphin-emu', 'cache', 'dolphin-emu'),
    );
});

test('flatpakCacheRoot — homeDir defaults to os.homedir()', () => {
    const r = flatpakCacheRoot('com.example.App', 'example');
    assert.ok(r.endsWith(path.join('.var', 'app', 'com.example.App', 'cache', 'example')));
    assert.ok(path.isAbsolute(r));
});

// translateFlatpakDocPath — host-side translation of the document-portal bind mount inside the
// sandbox; 3 launcher modules (ppsspp/dolphin/melonds) had each written the same thing.
test('translateFlatpakDocPath — translates the portal prefix to the host side (explicit uid), another path unchanged', () => {
    assert.equal(
        translateFlatpakDocPath('/run/flatpak/doc/abc123/Wiiu', 1000),
        path.join('/run/user', '1000', 'doc', 'abc123/Wiiu'),
    );
    // already in host-side form on the machine — stays unchanged
    assert.equal(translateFlatpakDocPath('/run/user/1000/doc/abc123/Wiiu', 1000), '/run/user/1000/doc/abc123/Wiiu');
    assert.equal(translateFlatpakDocPath('/home/user/ROMs', 1000), '/home/user/ROMs');
});

test('translateFlatpakDocPath — without a uid it uses process.getuid()', () => {
    const uid = process.getuid();
    assert.equal(
        translateFlatpakDocPath('/run/flatpak/doc/p8Wcff0VbJfk4_qhLDMghg/psp/game.cso'),
        `/run/user/${uid}/doc/p8Wcff0VbJfk4_qhLDMghg/psp/game.cso`,
    );
});

test('translateFlatpakDocPath — non-string/null input unchanged', () => {
    assert.equal(translateFlatpakDocPath(null), null);
    assert.equal(translateFlatpakDocPath(undefined), undefined);
});

test('dataHome — ~/.local/share (intentionally does NOT follow XDG_DATA_HOME)', () => {
    assert.equal(dataHome('/home/x'), path.join('/home/x', '.local', 'share'));
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = '/valahol/mashol';
    try {
        assert.equal(dataHome('/home/x'), path.join('/home/x', '.local', 'share'));
    } finally {
        if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
    }
});

test('translateFlatpakDocPath — the ppsspp/dolphin/melonds discoverers re-export the same function', () => {
    for (const mod of ['ppsspp-library.js', 'dolphin-library.js', 'melonds-library.js']) {
        assert.equal(require(`../lib/launchers/${mod}`).translateFlatpakDocPath, translateFlatpakDocPath, mod);
    }
});

// --- Root by native / flatpak variant ---
test('appConfigRoot/DataRoot/CacheRoot — the added variant decides; for an unknown one the existing one, flatpak first', () => {
    withTempHome((home) => {
        const id = 'org.example.App';
        const flat = (kind) => path.join(home, '.var', 'app', id, kind, 'app');
        try {
            setAppVariants({});
            // nothing exists → flatpak (old behavior)
            assert.equal(appConfigRoot(id, 'app'), flat('config'));
            // only the native one exists → native
            mkdirp(path.join(home, '.config', 'app'));
            assert.equal(appConfigRoot(id, 'app'), path.join(home, '.config', 'app'));
            // both exist → flatpak
            mkdirp(flat('config'));
            assert.equal(appConfigRoot(id, 'app'), flat('config'));
            // the added variant overrides
            setAppVariants({ [id]: 'native', 'x.y.z': 'bogus' });
            assert.equal(appVariant(id), 'native');
            assert.equal(appVariant('x.y.z'), null);
            assert.equal(appConfigRoot(id, 'app'), path.join(home, '.config', 'app'));
            assert.equal(appDataRoot(id, 'app'), path.join(home, '.local', 'share', 'app'));
            assert.equal(appCacheRoot(id, 'app'), path.join(home, '.cache', 'app'));
            assert.equal(appConfigRoot(id, 'app', { native: (h) => path.join(h, 'egyedi') }), path.join(home, 'egyedi'));
            setAppVariants({ [id]: 'flatpak' });
            assert.equal(appDataRoot(id, 'app'), flat('data'));
        } finally {
            setAppVariants({});
        }
    });
});
