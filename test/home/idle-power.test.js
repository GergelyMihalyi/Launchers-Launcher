'use strict';

// The idle sleep / controller disconnect decision (`idlePowerActions`) — renderer/home/idle-power.js
// is a classic <script> in the browser, module.exports guard at the bottom of the file.

const test = require('node:test');
const assert = require('node:assert/strict');
const { idlePowerActions, AUTO_SUSPEND_WARN_MS } = require('../../renderer/home/idle-power.js');

const MIN = 60 * 1000;
const none = () => ({ warn: false, suspend: false, disconnect: false });

test('idlePowerActions — both off: never anything', () => {
    assert.deepEqual(idlePowerActions(999 * MIN, { suspendMs: 0, disconnectMs: 0 }, none()), []);
});

test('idlePowerActions — no action before the threshold', () => {
    assert.deepEqual(idlePowerActions(5 * MIN, { suspendMs: 30 * MIN, disconnectMs: 10 * MIN }, none()), []);
});

test('idlePowerActions — disconnect at its own threshold', () => {
    assert.deepEqual(idlePowerActions(10 * MIN, { suspendMs: 30 * MIN, disconnectMs: 10 * MIN }, none()), ['disconnect']);
});

test('idlePowerActions — warning 1 minute before sleep, then sleep', () => {
    const cfg = { suspendMs: 30 * MIN, disconnectMs: 0 };
    assert.equal(AUTO_SUSPEND_WARN_MS, MIN);
    assert.deepEqual(idlePowerActions(29 * MIN, cfg, none()), ['warn']);
    assert.deepEqual(idlePowerActions(30 * MIN, cfg, { ...none(), warn: true }), ['suspend']);
});

test('idlePowerActions — once per phase: an action that already ran does not repeat', () => {
    const cfg = { suspendMs: 30 * MIN, disconnectMs: 10 * MIN };
    assert.deepEqual(idlePowerActions(40 * MIN, cfg, { warn: true, suspend: true, disconnect: true }), []);
    assert.deepEqual(idlePowerActions(40 * MIN, cfg, { warn: true, suspend: false, disconnect: true }), ['suspend']);
});

test('idlePowerActions — jump after wake-up (the warning was skipped): the sleep does not repeat', () => {
    // The time spent in suspend gives a huge idle time — but it already ran in this stretch.
    const cfg = { suspendMs: 30 * MIN, disconnectMs: 0 };
    assert.deepEqual(idlePowerActions(600 * MIN, cfg, { warn: false, suspend: true, disconnect: false }), []);
});

test('idlePowerActions — beyond the threshold, without warning: sleep right away (no warn)', () => {
    assert.deepEqual(idlePowerActions(31 * MIN, { suspendMs: 30 * MIN, disconnectMs: 0 }, none()), ['suspend']);
});
