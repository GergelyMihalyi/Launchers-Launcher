'use strict';

// lib/launch/window-activate.js — parser of the KWin `WindowsRunner` (`gdbus call ... Match`) output.
// The sample strings follow the format of the `gdbus` output actually observed on the machine
// (Python-repr-like tuples, `icon-data`/`subtext` prop). `activateWindow` itself calls
// `gdbus`, that is not tested here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWindowsRunnerMatches, pickMatch } = require('../../lib/launch/window-activate.js');

// A single match, `icon-data` prop (the real blob is hundreds of thousands of bytes — shortened here).
const ONE_MATCH = "([('0_{f90206a5-5201-40b2-9028-d9099fae27f4}', 'Steam', '', 100, 0.8, "
    + "{'icon-data': <(64, 64, 256, true, 8, 4, [byte 0x00, 0x00, 0x00])>})],)";

// Several matches, `subtext` prop.
const TWO_MATCHES = "([('0_{a1d45788-b1d7-4a1a-8dcd-eacf20cabefe}', 'RetroArch', 'wayland', 100, 0.8, "
    + "{'subtext': <'A(z) 1. asztal'>}), "
    + "('0_{b2e56899-c2e8-5b2b-9ede-fbe0cabefe11}', 'RetroArch - Sega Genesis', '', 30, 0.5, "
    + "{'subtext': <'asztal'>})],)";

test('parseWindowsRunnerMatches — one match id + caption', () => {
    assert.deepEqual(parseWindowsRunnerMatches(ONE_MATCH), [
        { id: '0_{f90206a5-5201-40b2-9028-d9099fae27f4}', caption: 'Steam' },
    ]);
});

test('parseWindowsRunnerMatches — several matches in order', () => {
    const m = parseWindowsRunnerMatches(TWO_MATCHES);
    assert.equal(m.length, 2);
    assert.equal(m[0].id, '0_{a1d45788-b1d7-4a1a-8dcd-eacf20cabefe}');
    assert.equal(m[0].caption, 'RetroArch');
    assert.equal(m[1].caption, 'RetroArch - Sega Genesis');
});

test('parseWindowsRunnerMatches — escaped apostrophe in the caption', () => {
    const s = "([('0_{11111111-1111-1111-1111-111111111111}', 'Tom\\'s Game', '', 100, 0.8, {})],)";
    assert.deepEqual(parseWindowsRunnerMatches(s), [
        { id: '0_{11111111-1111-1111-1111-111111111111}', caption: "Tom's Game" },
    ]);
});

test('parseWindowsRunnerMatches — an empty array when there is no match', () => {
    assert.deepEqual(parseWindowsRunnerMatches('([],)'), []);
    assert.deepEqual(parseWindowsRunnerMatches(''), []);
});

test('pickMatch — null for an empty list', () => {
    assert.equal(pickMatch([], 'steam'), null);
});

test('pickMatch — prefers the caption match over the first element of the relevance order', () => {
    const matches = [
        { id: 'a', caption: 'Some other window' },
        { id: 'b', caption: 'Heroic Games Launcher' },
    ];
    assert.equal(pickMatch(matches, 'heroic'), 'b');
});

test('pickMatch — in the absence of a caption match gives the first (most relevant)', () => {
    const matches = [{ id: 'a', caption: 'First' }, { id: 'b', caption: 'Second' }];
    assert.equal(pickMatch(matches, 'no-such'), 'a');
});

const { activateWindow } = require('../../lib/launch/window-activate.js');

test('activateWindow — no window activation on GNOME: false, without a gdbus call (the caller falls back to a normal launch)', async () => {
    assert.equal(await activateWindow('Steam', { desktop: 'gnome' }), false);
});
