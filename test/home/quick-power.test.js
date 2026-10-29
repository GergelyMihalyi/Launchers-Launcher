'use strict';

// The pure helpers of the Start menu quick settings — renderer/home/quick-power.js is a
// classic <script> in the browser, here via the guarded module.exports.
const test = require('node:test');
const assert = require('node:assert/strict');
// A createOverlay/createArmedActionList call runs at the top of the module (globals of util.js in
// the browser): here we only check the pure helpers, so empty stubs are enough.
Object.assign(globalThis, {
    createOverlay: () => ({ isOpen: () => false, open() {}, close() {}, states: {} }),
    createArmedActionList: () => ({}),
});
const { QP_ROWS, QP_SLEEP_STEPS, qpNext } = require('../../renderer/home/quick-power.js');

test('qpNext — cycles, for an unknown value it lands on the first', () => {
    assert.equal(qpNext(QP_SLEEP_STEPS, 0), 30);
    assert.equal(qpNext(QP_SLEEP_STEPS, 90), 0);
    assert.equal(qpNext(QP_SLEEP_STEPS, 45), 0);
    assert.equal(qpNext([0, 1, 2], 2), 0);
});

test('QP_ROWS — shutdown/restart/sleep ask for arming, closing does not', () => {
    assert.deepEqual(QP_ROWS.map((r) => [r.id, r.armed]), [['poweroff', true], ['reboot', true], ['suspend', true], ['quit', false]]);
});
