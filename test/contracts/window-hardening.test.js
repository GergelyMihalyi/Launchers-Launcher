'use strict';

// Hardening of the kiosk window — at source level (main.js cannot be
// required in the sandbox). The test fails if:
//   - sandbox / contextIsolation / nodeIntegration: false drops out of the webPreferences of
//     `mainWindowOptions()` in `lib/launch/main-window.js`;
//   - the navigation lock or the renderer crash guard is not wired to the window;
//   - the `ozone-platform` switch does not come from the socket-based `pickOzonePlatform()` but from
//     an env variable (XDG_SESSION_TYPE/WAYLAND_DISPLAY — the SIGSEGV lesson), the `package.json`
//     `start` does not go through `bin/start.js` (Chromium picks the ozone platform
//     BEFORE the JS — the decision must be passed as a CLI switch),
//     or the dead `UseOzonePlatform` flag comes back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = strip(fs.readFileSync(path.join(root, 'main.js'), 'utf8'));
// Window creation + the two guards are in lib/launch/main-window.js.
const winSrc = strip(fs.readFileSync(path.join(root, 'lib', 'launch', 'main-window.js'), 'utf8'));

function bodyOf(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    const end = text.indexOf('\n}\n', start);
    return text.slice(start, end);
}

test('mainWindowOptions — webPreferences: sandbox, contextIsolation, nodeIntegration: false, spellcheck: false', () => {
    const body = bodyOf(winSrc, 'function mainWindowOptions(');
    assert.match(body, /sandbox:\s*true/);
    assert.match(body, /contextIsolation:\s*true/);
    assert.match(body, /nodeIntegration:\s*false/);
    assert.match(body, /spellcheck:\s*false/);
});

test('createMainWindow — the hardened options, navigation lock and renderer-crash guard are wired in; main.js calls it', () => {
    const body = bodyOf(winSrc, 'function createMainWindow(');
    assert.match(body, /new BrowserWindow\(mainWindowOptions\(/);
    assert.match(body, /guardNavigation\(win\.webContents/);
    assert.match(body, /watchRendererCrashes\(win\.webContents/);
    assert.match(winSrc, /setWindowOpenHandler\(/);
    assert.match(winSrc, /'will-navigate'/);
    assert.match(winSrc, /'render-process-gone'/);
    assert.match(bodyOf(src, 'function createWindow()'), /createMainWindow\(/);
    assert.match(src, /app\.on\('child-process-gone'/);
});

test('ozone-platform from the socket-based pickOzonePlatform(); no env-based decision; the CLI switch is given by bin/start.js', () => {
    assert.match(src, /const ozone = pickOzonePlatform\(\)/);
    assert.match(src, /appendSwitch\('ozone-platform', ozone\.platform\)/);
    assert.doesNotMatch(src, /process\.env\.(XDG_SESSION_TYPE|WAYLAND_DISPLAY)/,
        'main.js must not decide the platform from an env variable (the watcher env may be empty)');
    assert.doesNotMatch(src, /UseOzonePlatform/);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.doesNotMatch(pkg.scripts.start, /ozone-platform/, 'the decision is in pickOzonePlatform(), in one place');
    assert.equal(pkg.scripts.start, 'node bin/start.js');
    const starter = fs.readFileSync(path.join(root, 'bin', 'start.js'), 'utf8');
    assert.match(starter, /pickOzonePlatform\(\)/);
    assert.match(starter, /`--ozone-platform=\$\{ozone\.platform\}`/);
});
