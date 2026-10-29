'use strict';

// lib/sidecars/tv-mode-enter.js — the `tvMode` config key → bin/tv-mode-enter.sh sidecar text.
// HOME is pointed at a temp directory BEFORE the `require` (like main-controller.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');

const TMP_HOME = tmpDir('gl-tvmode-');
process.env.HOME = TMP_HOME;
const tv = require('../../lib/sidecars/tv-mode-enter.js');

test('serialize — empty / missing tvMode -> empty string', () => {
    assert.equal(tv.serialize(undefined), '');
    assert.equal(tv.serialize(null), '');
    assert.equal(tv.serialize({}), '');
    assert.equal(tv.serialize({ closeFlatpak: [], closeNative: [], preCommands: [] }), '');
});

test('serialize — the three types in the correct line format, in order', () => {
    const body = tv.serialize({
        closeFlatpak: [{ id: 'com.google.Chrome' }, 'com.vscodium.codium'],
        closeNative: ['firefox', 'soffice'],
        preCommands: ['cd ~/x && ./y down'],
    });
    assert.equal(body,
        'flatpak com.google.Chrome\n'
        + 'flatpak com.vscodium.codium\n'
        + 'native firefox\n'
        + 'native soffice\n'
        + 'cmd cd ~/x && ./y down\n');
});

test('serialize — both a string and an object flatpak entry are fine; empty/bad dropped', () => {
    const body = tv.serialize({
        closeFlatpak: ['com.foo.Bar', { id: '  ' }, { missing: 'id' }, 42, { id: 'com.baz.Qux' }],
    });
    assert.equal(body, 'flatpak com.foo.Bar\nflatpak com.baz.Qux\n');
});

test('serialize — the `pkill` field (if someone writes it in) is ignored', () => {
    const body = tv.serialize({ closeFlatpak: [{ id: 'com.visualstudio.code', pkill: 'vscode|VSCode' }] });
    assert.equal(body, 'flatpak com.visualstudio.code\n');
});

test('serialize — an entry containing a newline/CR is dropped (protecting the line format)', () => {
    const body = tv.serialize({
        closeNative: ['firefox\nrm -rf', 'ok'],
        preCommands: ['line1\nline2'],
    });
    assert.equal(body, 'native ok\n');
});

test('writeSidecar / readSidecar — round trip in the temp HOME', () => {
    const written = tv.writeSidecar({ closeNative: ['firefox'], preCommands: ['x'] });
    assert.equal(written, 'native firefox\ncmd x\n');
    assert.equal(tv.readSidecar(), 'native firefox\ncmd x\n');
    assert.equal(require('fs').statSync(tv.sidecarPath()).mode & 0o777, 0o600, 'the sidecar is 0600 (the script runs the cmd lines)');
    assert.equal(tv.sidecarPath(), path.join(TMP_HOME, '.local', 'share', 'launchers-launcher-tvmode'));
    // empty tvMode -> empty file
    assert.equal(tv.writeSidecar({}), '');
    assert.equal(tv.readSidecar(), '');
});

test('readSidecar — missing file -> empty string (does not throw)', () => {
    fs.rmSync(tv.sidecarPath(), { force: true });
    assert.equal(tv.readSidecar(), '');
});
