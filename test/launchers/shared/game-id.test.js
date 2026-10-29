'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pathHashId, cleanFilenameLabel } = require('../../../lib/launchers/shared/game-id.js');

test('pathHashId — for a single argument byte-identical to the old sha1 formula', () => {
    const filePath = '/home/user/roms/foo.iso';
    const expected = `p:${crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16)}`;
    assert.equal(pathHashId(filePath), expected);
});

test('pathHashId — with an extra parameter (e.g. zip inner file name) it hashes the key joined with "|"', () => {
    const filePath = '/home/user/roms/archive.zip';
    const extra = 'game.nds';
    const expected = `p:${crypto.createHash('sha1').update(`${filePath}|${extra}`).digest('hex').slice(0, 16)}`;
    assert.equal(pathHashId(filePath, extra), expected);
});

test('pathHashId — a missing/empty extra gives the same as the one-argument call', () => {
    const filePath = '/home/user/roms/foo.iso';
    assert.equal(pathHashId(filePath, ''), pathHashId(filePath));
    assert.equal(pathHashId(filePath, null), pathHashId(filePath));
    assert.equal(pathHashId(filePath, undefined), pathHashId(filePath));
});

test('pathHashId — always a "p:" prefix + 16 hex characters', () => {
    assert.match(pathHashId('x'), /^p:[0-9a-f]{16}$/);
});

// cleanFilenameLabel — the shared core of the file-name cleanup fallback of 6 launcher modules
// (cemu/dolphin/duckstation/melonds/pcsx2/ppsspp).
test('cleanFilenameLabel — extension stripped (default), _/. -> space, double spaces collapsed', () => {
    assert.equal(cleanFilenameLabel('Shadow_of_the_Colossus.iso'), 'Shadow of the Colossus');
    assert.equal(cleanFilenameLabel('God.of.War.II.bin'), 'God of War II');
    assert.equal(cleanFilenameLabel('Some__Game...Name.rvz'), 'Some Game Name');
});

test('cleanFilenameLabel — with stripExtension:false the extension (dots) turns into a space too', () => {
    assert.equal(cleanFilenameLabel('Some_Game.Folder', { stripExtension: false }), 'Some Game Folder');
});

test('cleanFilenameLabel — for an empty result falls back to the raw, trimmed name; empty string for empty input', () => {
    assert.equal(cleanFilenameLabel('...'), '...');
    assert.equal(cleanFilenameLabel(''), '');
    assert.equal(cleanFilenameLabel(null), '');
});
