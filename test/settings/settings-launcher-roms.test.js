'use strict';

// renderer/settings/settings-launcher-roms.js — the pure parts of setting up the custom ROM-folder
// source.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROM_EXT_PRESETS, parseRomExts } = require('../../renderer/settings/settings-launcher-roms.js');

test('parseRomExts — without a dot too, lowercase, comma/space separated, dedup, the bad one dropped', () => {
    assert.deepEqual(parseRomExts('iso, .CHD  cso;iso bad.ext x'), ['.iso', '.chd', '.cso', '.x']);
    assert.deepEqual(parseRomExts(''), []);
    assert.deepEqual(parseRomExts('.verylongextension'), []);
});

test('ROM_EXT_PRESETS — every preset is valid, the main normalizer accepts it too', () => {
    const { normalizeCustomGameSource } = require('../../lib/launchers/custom-roms-library.js');
    for (const p of ROM_EXT_PRESETS) {
        assert.ok(p.label && p.exts.length, p.label);
        const src = normalizeCustomGameSource({ launcherId: 'x', dirs: ['/r'], exts: p.exts });
        assert.deepEqual(src.exts, p.exts, p.label);
    }
});
