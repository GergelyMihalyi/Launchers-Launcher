'use strict';

// lib/apps/installed-apps.js — pure merge of the "Installed application" list (without the discovery).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInstalledAppItems } = require('../../lib/apps/installed-apps.js');

const CATALOG = [
    { id: 'steam', name: 'Steam', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam'], flathubId: 'com.valvesoftware.Steam', nativeCmd: 'steam' },
];

test('buildInstalledAppItems — flatpak + native by name; known from the catalog AND the added launchers', () => {
    const items = buildInstalledAppItems({
        flatpaks: [{ appId: 'com.valvesoftware.Steam', name: 'Steam' }, { appId: 'org.foo.Bar', name: 'Bar' }],
        natives: [
            { id: 'steam', name: 'Steam (native)', cmd: '/usr/bin/steam', args: [], icon: 'steam' },
            { id: 'ff', name: 'Firefox', cmd: 'firefox', args: [], icon: 'firefox' },
        ],
        catalog: CATALOG,
        launchers: [{ id: 'x', cmd: 'flatpak', args: ['run', 'org.foo.Bar'] }],
        resolveIcon: (n) => (n ? `/icons/${n}.png` : null),
    });
    assert.deepEqual(items.map((a) => [a.key, a.kind, a.icon, a.known]), [
        ['flatpak:org.foo.Bar', 'flatpak', '/icons/org.foo.Bar.png', true],
        ['desktop:ff', 'native', '/icons/firefox.png', false],
        ['flatpak:com.valvesoftware.Steam', 'flatpak', '/icons/com.valvesoftware.Steam.png', true],
        ['desktop:steam', 'native', '/icons/steam.png', true],
    ]);
    assert.deepEqual(items[0].args, ['run', 'org.foo.Bar']);
});

test('buildInstalledAppItems — a native row that would not pass the add-launcher gate (shell, flatpak command) is skipped', () => {
    const items = buildInstalledAppItems({
        flatpaks: [],
        natives: [
            { id: 'term', name: 'Shell', cmd: 'bash', args: ['-l'] },
            { id: 'fp', name: 'Via flatpak', cmd: 'flatpak', args: ['run', 'org.foo.Bar'] },
        ],
        catalog: CATALOG,
        launchers: [],
        resolveIcon: () => null,
    });
    assert.deepEqual(items, []);
});
