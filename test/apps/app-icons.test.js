'use strict';

// lib/apps/app-icons.js — icon resolution from the theme folders + import into the launcher's own icon folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { withTempHome, tmpDir, writeFile } = require('../helpers/fs.js');
const icons = require('../../lib/apps/app-icons.js');

test('iconScore — scalable/SVG is best, otherwise the size segment (@2x multiplier)', () => {
    assert.equal(icons.iconScore('/i/hicolor/scalable/apps/a.svg'), 1000);
    assert.equal(icons.iconScore('/i/hicolor/256x256/apps/a.png'), 256);
    assert.equal(icons.iconScore('/i/hicolor/48x48@2/apps/a.png'), 96);
    assert.equal(icons.iconScore('/i/breeze/apps/48/a.png'), 48);
    assert.equal(icons.iconScore('/usr/share/pixmaps/a.png'), 32);
});

test('buildIconIndex + resolveIconFile — hicolor + breeze layout + pixmaps + flatpak exports, the largest wins', async () => {
    const home = tmpDir();
    const share = tmpDir();
    writeFile(share, 'icons/hicolor/48x48/apps/foo.png', 'x');
    writeFile(share, 'icons/hicolor/256x256/apps/foo.png', 'x');
    writeFile(share, 'icons/breeze/apps/48/bar.svg', '<svg/>');
    writeFile(share, 'pixmaps/baz.png', 'x');
    writeFile(home, '.local/share/flatpak/exports/share/icons/hicolor/128x128/apps/org.foo.Bar.png', 'x');
    writeFile(share, 'icons/hicolor/64x64/apps/readme.txt', 'x');
    icons.clearIconIndexCache();
    const index = await icons.buildIconIndex({ homeDir: home, dataDirs: share });
    assert.equal(icons.resolveIconFile('foo', index), path.join(share, 'icons/hicolor/256x256/apps/foo.png'));
    assert.equal(icons.resolveIconFile('bar', index), path.join(share, 'icons/breeze/apps/48/bar.svg'));
    assert.equal(icons.resolveIconFile('baz.png', index), path.join(share, 'pixmaps/baz.png'));
    assert.equal(icons.resolveIconFile('org.foo.Bar', index),
        path.join(home, '.local/share/flatpak/exports/share/icons/hicolor/128x128/apps/org.foo.Bar.png'));
    assert.equal(icons.resolveIconFile('missing', index), null);
    assert.equal(icons.resolveIconFile('', index), null);
    // absolute Icon=: only an existing PNG/SVG
    assert.equal(icons.resolveIconFile(path.join(share, 'pixmaps/baz.png'), index), path.join(share, 'pixmaps/baz.png'));
    assert.equal(icons.resolveIconFile(path.join(share, 'pixmaps/missing.png'), index), null);
    icons.clearIconIndexCache();
});

test('isUserIconUrl — only a safely named file in the own icon folder', () => {
    const home = '/h';
    const dir = icons.userIconDir(home);
    assert.equal(icons.isUserIconUrl(pathToFileURL(path.join(dir, 'custom-foo.png')).href, home), true);
    assert.equal(icons.isUserIconUrl(pathToFileURL(path.join(dir, 'sub', 'x.png')).href, home), false);
    assert.equal(icons.isUserIconUrl(pathToFileURL('/etc/x.png').href, home), false);
    assert.equal(icons.isUserIconUrl(pathToFileURL(path.join(dir, 'x.txt')).href, home), false);
    assert.equal(icons.isUserIconUrl(path.join(dir, 'x.png'), home), false, 'not a file:// URL');
    assert.equal(icons.isUserIconUrl(null, home), false);
});

test('importLauncherIcon — copies from under an icon root + file:// URL; rejects other locations / bad extension / link target', () => {
    withTempHome((home) => {
        const src = writeFile(home, '.local/share/icons/hicolor/256x256/apps/foo.png', 'PNGDATA');
        const res = icons.importLauncherIcon(src, 'custom-foo');
        assert.equal(res.ok, true);
        assert.equal(res.url, pathToFileURL(path.join(icons.userIconDir(home), 'custom-foo.png')).href);
        assert.equal(fs.readFileSync(path.join(icons.userIconDir(home), 'custom-foo.png'), 'utf8'), 'PNGDATA');
        assert.equal(icons.isUserIconUrl(res.url), true);

        const secret = writeFile(home, 'secret.png', 'x');
        assert.equal(icons.importLauncherIcon(secret, 'x').ok, false, 'not an icon root');
        const txt = writeFile(home, '.local/share/icons/hicolor/48x48/apps/x.txt', 'x');
        assert.equal(icons.importLauncherIcon(txt, 'x').ok, false, 'not PNG/SVG');
        const target = writeFile(home, 'id_rsa', 'KEY');
        const link = path.join(home, '.local/share/icons/hicolor/48x48/apps/evil.png');
        fs.symlinkSync(target, link);
        assert.equal(icons.importLauncherIcon(link, 'x').ok, false, 'the link target is not an icon');

        assert.equal(icons.removeUserIcon(res.url), true);
        assert.equal(fs.existsSync(path.join(icons.userIconDir(home), 'custom-foo.png')), false);
        assert.equal(icons.removeUserIcon('assets/icons/steam.svg'), false, 'does not delete a built-in icon');
    });
});
