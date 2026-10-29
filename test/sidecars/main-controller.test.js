'use strict';

// lib/sidecars/main-controller.js — the "main controller" sidecar file (towards the trigger chain,
// bin/launchers-launcher-bt-trigger.sh). HOME is pointed at a temp directory BEFORE the require, so
// writeSidecar does not write into the real ~/.local/share.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');

process.env.HOME = tmpDir('gl-mainctrl-');
const mc = require('../../lib/sidecars/main-controller.js');

function reset() {
    try { fs.rmSync(path.dirname(mc.sidecarPath()), { recursive: true, force: true }); } catch (e) { /* noop */ }
}

test('isMac — colon-separated 6-octet, upper/lower case OK; nothing else', () => {
    assert.ok(mc.isMac('A0:AB:51:12:34:56'));
    assert.ok(mc.isMac('a0:ab:51:12:34:56'));
    assert.ok(!mc.isMac('A0-AB-51-12-34-56'));
    assert.ok(!mc.isMac('A0:AB:51:12:34'));
    assert.ok(!mc.isMac(''));
    assert.ok(!mc.isMac(null));
});

test('writeSidecar + readSidecar — valid MAC round trip, uppercased', () => {
    reset();
    assert.equal(mc.writeSidecar('a0:ab:51:12:34:56'), 'A0:AB:51:12:34:56');
    assert.equal(fs.readFileSync(mc.sidecarPath(), 'utf8'), 'A0:AB:51:12:34:56\n');
    assert.equal(mc.readSidecar(), 'A0:AB:51:12:34:56');
});

test('writeSidecar(null / invalid) — empty file, readSidecar null', () => {
    reset();
    mc.writeSidecar('A0:AB:51:12:34:56');
    assert.equal(mc.writeSidecar(null), null);
    assert.equal(fs.readFileSync(mc.sidecarPath(), 'utf8'), '');
    assert.equal(mc.readSidecar(), null);
    assert.equal(mc.writeSidecar('not-a-mac'), null);
    assert.equal(mc.readSidecar(), null);
});

test('readSidecar — missing file -> null (does not throw)', () => {
    reset();
    assert.equal(mc.readSidecar(), null);
});
