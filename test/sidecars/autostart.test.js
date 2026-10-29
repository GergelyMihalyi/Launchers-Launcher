'use strict';

// lib/sidecars/autostart.js — the sidecar file of the "controllerAutostart" config key (towards the
// trigger chain, bin/launchers-launcher-bt-trigger.sh). HOME is pointed at a temp directory BEFORE the
// require, so writeSidecar does not write into the real ~/.local/share.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');

process.env.HOME = tmpDir('gl-autostart-');
const autostart = require('../../lib/sidecars/autostart.js');

function reset() {
    try { fs.rmSync(path.dirname(autostart.sidecarPath()), { recursive: true, force: true }); } catch (e) { /* noop */ }
}

test('readSidecar — missing file -> true (no restriction, default behavior)', () => {
    reset();
    assert.equal(autostart.readSidecar(), true);
});

test('writeSidecar(true) — empty file, readSidecar true', () => {
    reset();
    assert.equal(autostart.writeSidecar(true), true);
    assert.equal(fs.readFileSync(autostart.sidecarPath(), 'utf8'), '');
    assert.equal(autostart.readSidecar(), true);
});

test('writeSidecar(false) — "disabled" content, readSidecar false', () => {
    reset();
    assert.equal(autostart.writeSidecar(false), false);
    assert.equal(fs.readFileSync(autostart.sidecarPath(), 'utf8'), 'disabled\n');
    assert.equal(autostart.readSidecar(), false);
});

test('writeSidecar — enabled -> disabled -> enabled round trip', () => {
    reset();
    autostart.writeSidecar(false);
    assert.equal(autostart.readSidecar(), false);
    autostart.writeSidecar(true);
    assert.equal(autostart.readSidecar(), true);
});
