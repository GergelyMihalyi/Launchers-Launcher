'use strict';

// renderer/settings/settings-launcher-add.js — the pure parts of the "＋ Add launcher" wizard:
// the filter and the wizard's output → `add-launcher` payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    customLauncherSlug, customLauncherId, filterInstalledApps, launcherAddPayload,
} = require('../../renderer/settings/settings-launcher-add.js');

test('customLauncherSlug / customLauncherId — without accents, -2, -3 on collision', () => {
    assert.equal(customLauncherSlug('Crème Brûlée Game!'), 'creme-brulee-game');
    assert.equal(customLauncherSlug('***'), 'app');
    assert.equal(customLauncherId('Foo', []), 'custom-foo');
    assert.equal(customLauncherId('Foo', [{ id: 'custom-foo' }, { id: 'custom-foo-2' }]), 'custom-foo-3');
});

test('filterInstalledApps — every word must match (name / appid / command), accent-insensitive', () => {
    const apps = [
        { name: 'Pokémon Launcher', appId: 'org.poke.Mon', cmd: 'flatpak' },
        { name: 'Firefox', cmd: 'firefox' },
        { name: 'Jeu Été', cmd: '/opt/x/run' },
    ];
    assert.equal(filterInstalledApps(apps, ''), apps);
    assert.deepEqual(filterInstalledApps(apps, 'pokemon').map((a) => a.name), ['Pokémon Launcher']);
    assert.deepEqual(filterInstalledApps(apps, 'org.poke launcher').map((a) => a.name), ['Pokémon Launcher']);
    assert.deepEqual(filterInstalledApps(apps, 'jeu ete').map((a) => a.name), ['Jeu Été']);
    assert.deepEqual(filterInstalledApps(apps, 'opt/x').map((a) => a.name), ['Jeu Été']);
    assert.deepEqual(filterInstalledApps(apps, 'missing'), []);
});

test('launcherAddPayload — flatpak: flatpak-<appid> id, the own icon as iconFile', () => {
    const p = launcherAddPayload({
        kind: 'flatpak', appId: 'org.foo.Bar', name: 'Bar', cmd: 'flatpak', args: ['run', 'org.foo.Bar'],
        iconFile: '/usr/share/icons/hicolor/256x256/apps/org.foo.Bar.png', useOwnIcon: true, builtinIcon: '', accent: '#1a9fff',
    }, []);
    assert.deepEqual(p, {
        id: 'flatpak-org-foo-bar', name: 'Bar', hint: '', icon: '', cmd: 'flatpak', args: ['run', 'org.foo.Bar'],
        custom: true, iconFile: '/usr/share/icons/hicolor/256x256/apps/org.foo.Bar.png', accent: '#1a9fff',
    });
});

test('launcherAddPayload — native/custom: custom-<name> id; a built-in icon overrides the own one; the default color is not included', () => {
    const p = launcherAddPayload({
        kind: 'native', name: 'Fire Fox', cmd: 'firefox', args: ['--kiosk'],
        iconFile: '/i/ff.png', useOwnIcon: true, builtinIcon: 'assets/icons/steam.svg', accent: null,
    }, [{ id: 'custom-fire-fox' }]);
    assert.deepEqual(p, {
        id: 'custom-fire-fox-2', name: 'Fire Fox', hint: '', icon: 'assets/icons/steam.svg',
        cmd: 'firefox', args: ['--kiosk'], custom: true,
    });
    const none = launcherAddPayload({ kind: 'custom', name: 'X', cmd: 'x', args: [], iconFile: '/i/x.png', useOwnIcon: false, builtinIcon: '' }, []);
    assert.equal('iconFile' in none, false, 'if the user chose "no icon", we do not send it');
});
