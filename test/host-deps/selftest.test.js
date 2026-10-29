'use strict';

// lib/host-deps/selftest.js — the pure core of the startup command self-test (`summarizeSelftest`),
// pairing the `Promise.allSettled` results with the command names.

const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_COMMANDS, requiredCommands, summarizeSelftest, checkCommands } = require('../../lib/host-deps/selftest.js');

test('REQUIRED_COMMANDS — the commands called by the launcher, WITHOUT cec-ctl', () => {
    assert.ok(REQUIRED_COMMANDS.includes('pactl'));
    assert.ok(REQUIRED_COMMANDS.includes('kscreen-doctor'));
    assert.ok(REQUIRED_COMMANDS.includes('git'));
    assert.ok(!REQUIRED_COMMANDS.includes('cec-ctl'), 'cec-ctl is handled by cecAvailable(), not this');
});

test('summarizeSelftest — fulfilled -> ok, everything else -> missing', () => {
    const settled = [
        { status: 'fulfilled', value: {} },
        { status: 'rejected', reason: new Error('not found') },
        { status: 'fulfilled', value: {} },
    ];
    assert.deepEqual(summarizeSelftest(settled, ['a', 'b', 'c']), [
        { cmd: 'a', ok: true },
        { cmd: 'b', ok: false },
        { cmd: 'c', ok: true },
    ]);
});

test('summarizeSelftest — missing/short results array: the unpaired command is not ok', () => {
    assert.deepEqual(summarizeSelftest([{ status: 'fulfilled' }], ['a', 'b']), [
        { cmd: 'a', ok: true },
        { cmd: 'b', ok: false },
    ]);
});

test('checkCommands — one surely existing (node) and one surely nonexistent command', async () => {
    const res = await checkCommands(['node', 'this-command-is-surely-not-installed-xyz']);
    assert.equal(res.find((r) => r.cmd === 'node').ok, true);
    assert.equal(res.find((r) => r.cmd === 'this-command-is-surely-not-installed-xyz').ok, false);
});

test('requiredCommands — on GNOME kscreen-doctor is not needed, on KDE / unknown the full list', () => {
    assert.deepEqual(requiredCommands('kde'), REQUIRED_COMMANDS);
    assert.deepEqual(requiredCommands('unknown'), REQUIRED_COMMANDS);
    assert.ok(!requiredCommands('gnome').includes('kscreen-doctor'));
    assert.ok(requiredCommands('gnome').includes('pactl'));
});
