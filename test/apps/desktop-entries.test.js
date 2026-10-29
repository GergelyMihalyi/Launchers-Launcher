'use strict';

// lib/apps/desktop-entries.js — discovery of native `.desktop` entries for the "＋ Add launcher"
// wizard.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, writeFile } = require('../helpers/fs.js');
const {
    parseDesktopFile, localized, splitExec, desktopEntryToApp, desktopDirs, listDesktopApps,
} = require('../../lib/apps/desktop-entries.js');

const desktop = (fields, extra = '') => `[Desktop Entry]\n${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')}\n${extra}`;

test('parseDesktopFile — only the [Desktop Entry] group, comments/empty lines skipped, the first key wins', () => {
    const e = parseDesktopFile('# x\n[Desktop Entry]\nName=Foo\nName[hu]=Fú\nExec=foo\nName=Second\n\n[Desktop Action new]\nExec=foo --new\n');
    assert.deepEqual(e, { Name: 'Foo', 'Name[hu]': 'Fú', Exec: 'foo' });
});

test('localized — hu_HU → hu → default', () => {
    const e = { Name: 'Foo', 'Name[hu]': 'Fú', 'Name[de_DE]': 'Fuu' };
    assert.equal(localized(e, 'Name', 'hu_HU.UTF-8'), 'Fú');
    assert.equal(localized(e, 'Name', 'de_DE.UTF-8'), 'Fuu');
    assert.equal(localized(e, 'Name', 'C'), 'Foo');
});

test('splitExec — quoting, escapes, field codes dropped, %% → %', () => {
    assert.deepEqual(splitExec('foo %U'), ['foo']);
    assert.deepEqual(splitExec('"/opt/My Game/run" --fullscreen %f'), ['/opt/My Game/run', '--fullscreen']);
    assert.deepEqual(splitExec('app "say \\"hi\\"" 100%%'), ['app', 'say "hi"', '100%']);
    assert.deepEqual(splitExec('app --file=%f -x'), ['app', '-x']);
    assert.equal(splitExec('"unclosed'), null);
    assert.equal(splitExec('%U'), null);
    assert.equal(splitExec(''), null);
});

test('desktopEntryToApp — NoDisplay/Hidden/Terminal/non-Application/flatpak/ourselves: skipped', () => {
    const ok = { Type: 'Application', Name: 'Foo', Exec: 'foo %u', Icon: 'foo' };
    assert.deepEqual(desktopEntryToApp('foo', ok), {
        id: 'foo', name: 'Foo', cmd: 'foo', args: [], icon: 'foo', genericName: '', categories: [],
    });
    for (const bad of [
        { ...ok, NoDisplay: 'true' }, { ...ok, Hidden: 'True' }, { ...ok, Terminal: 'true' },
        { ...ok, Type: 'Link' }, { ...ok, Exec: '/usr/bin/flatpak run org.foo.Bar' }, { ...ok, 'X-Flatpak': 'org.foo.Bar' },
        { ...ok, Name: '' }, { ...ok, Exec: '' },
    ]) assert.equal(desktopEntryToApp('foo', bad), null, JSON.stringify(bad));
    assert.equal(desktopEntryToApp('launchers-launcher', ok), null);
});

test('desktopDirs — the user folder first, the flatpak exports skipped, dedup', () => {
    const dirs = desktopDirs({ homeDir: '/h', dataDirs: '/usr/share:/h/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share/:/usr/share' });
    assert.deepEqual(dirs, ['/h/.local/share/applications', '/usr/share/applications']);
});

test('listDesktopApps — multiple roots: the earlier wins, subfolder id, sorted, unreadable skipped', async () => {
    const user = tmpDir();
    const sys = tmpDir();
    writeFile(user, 'foo.desktop', desktop({ Type: 'Application', Name: 'Foo (user)', Exec: 'foo-user' }));
    writeFile(sys, 'foo.desktop', desktop({ Type: 'Application', Name: 'Foo (sys)', Exec: 'foo-sys' }));
    writeFile(sys, 'bar.desktop', desktop({ Type: 'Application', Name: 'Bar', Exec: '/opt/bar/bar -x', Icon: 'bar' }));
    writeFile(sys, 'kde/baz.desktop', desktop({ Type: 'Application', Name: 'Baz', Exec: 'baz' }));
    writeFile(sys, 'hidden.desktop', desktop({ Type: 'Application', Name: 'Hidden', Exec: 'h', NoDisplay: 'true' }));
    writeFile(sys, 'notes.txt', 'x');
    const apps = await listDesktopApps({ dirs: [user, sys, path.join(sys, 'missing')], lang: 'C' });
    assert.deepEqual(apps.map((a) => [a.id, a.name, a.cmd, a.args]), [
        ['bar', 'Bar', '/opt/bar/bar', ['-x']],
        ['kde-baz', 'Baz', 'baz', []],
        ['foo', 'Foo (user)', 'foo-user', []],
    ]);
});
