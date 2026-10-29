'use strict';

// lib/sidecars/xdg-autostart.js — the XDG autostart `.desktop` entry of the "startWithSystem"
// config key. HOME is pointed at a temp directory BEFORE the require, so the write does not go to
// the real ~/.config/autostart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir } = require('../helpers/fs.js');

process.env.HOME = tmpDir('gl-xdg-autostart-');
delete process.env.XDG_CONFIG_HOME;
const xdgAutostart = require('../../lib/sidecars/xdg-autostart.js');

const REPO_ROOT = '/home/x/launchers-launcher';

function reset() {
    try { fs.rmSync(xdgAutostart.autostartDir(), { recursive: true, force: true }); } catch (e) { /* noop */ }
}

test('desktopEntryContent — Exec points to repoRoot/bin/launchers-launcher-show.sh', () => {
    const content = xdgAutostart.desktopEntryContent(REPO_ROOT);
    assert.match(content, /^\[Desktop Entry\]/);
    assert.match(content, /^Type=Application$/m);
    assert.match(content, new RegExp(`^Exec=${REPO_ROOT}/bin/launchers-launcher-show\\.sh$`, 'm'));
});

test('isAutostartEntryPresent — missing file -> false', () => {
    reset();
    assert.equal(xdgAutostart.isAutostartEntryPresent(), false);
});

test('writeAutostartEntry — creates the file, isAutostartEntryPresent true', () => {
    reset();
    xdgAutostart.writeAutostartEntry(REPO_ROOT);
    assert.equal(xdgAutostart.isAutostartEntryPresent(), true);
    const content = fs.readFileSync(xdgAutostart.autostartDesktopPath(), 'utf8');
    assert.match(content, /launchers-launcher-show\.sh/);
});

test('removeAutostartEntry — deletes the file; a no-op on a missing file, does not throw', () => {
    reset();
    xdgAutostart.writeAutostartEntry(REPO_ROOT);
    xdgAutostart.removeAutostartEntry();
    assert.equal(xdgAutostart.isAutostartEntryPresent(), false);
    assert.doesNotThrow(() => xdgAutostart.removeAutostartEntry());
});

test('writeAutostartEntry — enable -> disable -> enable round trip', () => {
    reset();
    xdgAutostart.writeAutostartEntry(REPO_ROOT);
    assert.equal(xdgAutostart.isAutostartEntryPresent(), true);
    xdgAutostart.removeAutostartEntry();
    assert.equal(xdgAutostart.isAutostartEntryPresent(), false);
    xdgAutostart.writeAutostartEntry(REPO_ROOT);
    assert.equal(xdgAutostart.isAutostartEntryPresent(), true);
});
