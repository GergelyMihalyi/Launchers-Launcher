'use strict';

// lib/flatpak.js — the pure parsers of the flatpak helpers.
// The `ps`/`list`/`info`/`kill`/`install` calls need a live `flatpak` binary — not
// tested (like `cec.js`/`bluetooth.js`).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    flatpakRunAppId, catalogAppId, parseFlatpakPs, parseFlatpakAppList, parseFlatpakInstalledApps,
    flatpakErrorLine,
    parseFlatpakPermissions,
} = require('../lib/flatpak.js');

const FLATPAK_PS = [
    'io.dbeaver.DBeaverCommunity\t34717',
    'com.google.Chrome\t24830',
    'org.libretro.RetroArch\t51002',
].join('\n');

test('flatpakRunAppId — the item after `run`, otherwise null', () => {
    assert.equal(flatpakRunAppId(['run', 'org.foo.Bar', '--x']), 'org.foo.Bar');
    assert.equal(flatpakRunAppId(['--x']), null);
    assert.equal(flatpakRunAppId(['run']), null);
    assert.equal(flatpakRunAppId(null), null);
});

test('catalogAppId', () => {
    assert.equal(catalogAppId({ cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'] }), 'net.lutris.Lutris');
    assert.equal(catalogAppId({ args: ['run', '--branch=stable', 'org.foo.Bar'] }), '--branch=stable'); // known limitation
    assert.equal(catalogAppId({ args: [] }), undefined);
});

test('parseFlatpakPs — gives the PID of the searched appid', () => {
    assert.equal(parseFlatpakPs(FLATPAK_PS, 'org.libretro.RetroArch'), 51002);
    assert.equal(parseFlatpakPs(FLATPAK_PS, 'com.google.Chrome'), 24830);
});

test('parseFlatpakAppList — appids per line (lines without a `.` / empty lines are dropped)', () => {
    assert.deepEqual(
        parseFlatpakAppList('org.libretro.RetroArch\ncom.google.Chrome\n\nrossz-sor\n'),
        ['org.libretro.RetroArch', 'com.google.Chrome'],
    );
    assert.deepEqual(parseFlatpakAppList(''), []);
});

test('parseFlatpakPs — null for a non-running appid', () => {
    assert.equal(parseFlatpakPs(FLATPAK_PS, 'com.heroicgameslauncher.hgl'), null);
    assert.equal(parseFlatpakPs('', 'anything'), null);
});

test('parseFlatpakInstalledApps — tab-separated "application\\tname" rows (launcher-model-v2 C)', () => {
    const out = parseFlatpakInstalledApps(
        'com.heroicgameslauncher.hgl\tHeroic Games Launcher\norg.libretro.RetroArch\tRetroArch\nheader junk\n');
    assert.deepEqual(out, [
        { appId: 'com.heroicgameslauncher.hgl', name: 'Heroic Games Launcher' },
        { appId: 'org.libretro.RetroArch', name: 'RetroArch' },
    ]);
    // row without a name → appId is the name
    assert.deepEqual(parseFlatpakInstalledApps('org.x.Y'), [{ appId: 'org.x.Y', name: 'org.x.Y' }]);
    assert.deepEqual(parseFlatpakInstalledApps(''), []);
});

test('flatpakErrorLine — returns the error:/hiba: line, without the prefix', () => {
    assert.equal(flatpakErrorLine('Looking for matches…\nerror: Nothing matches com.x.Y in remote flathub'),
        'Nothing matches com.x.Y in remote flathub');
    assert.equal(flatpakErrorLine('hiba: Nem található\n'), 'Nem található');
    // no explicit error → the last non-empty line
    assert.equal(flatpakErrorLine('a\nb\n\n'), 'b');
    assert.equal(flatpakErrorLine(''), '');
});

// `flatpak info --show-permissions` (including overrides) — keyfile shape; for the ROM-folder access
// warning (lib/launchers/rom-access.js).
test('parseFlatpakPermissions — the filesystems line of [Context], sections; the filesystems of another section does not count', () => {
    const text = [
        '[Context]',
        'shared=network;ipc;',
        'sockets=x11;wayland;pulseaudio;',
        'filesystems=xdg-run/gvfs;host:ro;~/Games;!home;/mnt/roms:rw;',
        '',
        '[Session Bus Policy]',
        'org.freedesktop.Flatpak=talk',
        'filesystems=/nem/ez',
        '',
    ].join('\n');
    assert.deepEqual(parseFlatpakPermissions(text), {
        sections: ['Context', 'Session Bus Policy'],
        filesystems: ['xdg-run/gvfs', 'host:ro', '~/Games', '!home', '/mnt/roms:rw'],
    });
});

test('parseFlatpakPermissions — empty / no-filesystems / garbage output', () => {
    assert.deepEqual(parseFlatpakPermissions(''), { sections: [], filesystems: [] });
    assert.deepEqual(parseFlatpakPermissions(null), { sections: [], filesystems: [] });
    assert.deepEqual(parseFlatpakPermissions('[Context]\nshared=network;\n'), { sections: ['Context'], filesystems: [] });
    assert.deepEqual(parseFlatpakPermissions('error: app/x not installed'), { sections: [], filesystems: [] });
});
