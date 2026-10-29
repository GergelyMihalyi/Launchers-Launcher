'use strict';

// The core of the gamepad merge-all: `aggregatePad` makes one synthetic pad from several pads
// (buttons[i].pressed = pressed on any, axes[i] = the largest absolute deflection).
// renderer/gamepad.js is a classic <script> in the browser; module.exports guard at the bottom of the file.

const test = require('node:test');
const assert = require('node:assert/strict');
require('../controller-id.js'); // globalThis.classifyController — detectActivePadType calls it
const { BTN } = require('../renderer/util.js');
const {
    aggregatePad, detectActivePadType, shouldThrottlePoll,
    detectPsCombos, maskChordButtons, resolveDisconnectTarget, disconnectDecision,
} = require('../renderer/gamepad.js');

const pad = (buttons, axes = []) => ({
    buttons: buttons.map((b) => (typeof b === 'number' ? { pressed: b > 0.5, value: b } : b)),
    axes,
});

test('no pad -> null', () => {
    assert.equal(aggregatePad([]), null);
});

test('one pad -> the same buttons/axes', () => {
    const gp = aggregatePad([pad([0, 1, 0], [0.3, -0.2])]);
    assert.equal(gp.buttons[1].pressed, true);
    assert.equal(gp.buttons[0].pressed, false);
    assert.deepEqual(gp.axes, [0.3, -0.2]);
});

test('buttons[i].pressed = OR over all pads', () => {
    const gp = aggregatePad([pad([0, 0]), pad([1, 0]), pad([0, 0])]);
    assert.equal(gp.buttons[0].pressed, true);
    assert.equal(gp.buttons[1].pressed, false);
});

test('axes[i] = the value with the largest absolute deflection', () => {
    const gp = aggregatePad([pad([], [0.1, -0.9]), pad([], [-0.4, 0.2])]);
    assert.equal(gp.axes[0], -0.4); // |−0.4| > |0.1|
    assert.equal(gp.axes[1], -0.9); // |−0.9| > |0.2|
});

test('different button/axis count: aligns to the longest', () => {
    const gp = aggregatePad([pad([1]), pad([0, 0, 1], [0.5])]);
    assert.equal(gp.buttons.length, 3);
    assert.equal(gp.buttons[2].pressed, true);
    assert.equal(gp.axes.length, 1);
});

// detectActivePadType — which connected pad is showing activity right now (button OR
// stick above the deadzone), its type via classifyController(). The button labels follow it
// when no main controller is set (renderer/controller/controller-labels.js).
const idPad = (id, buttons = [], axes = []) => ({
    id,
    buttons: buttons.map((b) => ({ pressed: b > 0.5, value: b })),
    axes,
});

test('detectActivePadType — no active pad -> null', () => {
    assert.equal(detectActivePadType([]), null);
    assert.equal(detectActivePadType([idPad('Xbox Wireless Controller', [0, 0], [0.05])]), null);
});

test('detectActivePadType — a button press marks the pad active', () => {
    assert.equal(
        detectActivePadType([idPad('Xbox Wireless Controller (Vendor: 045e Product: 0b13)', [0, 1])]),
        'xbox',
    );
});

test('detectActivePadType — stick deflection above the deadzone counts as activity too', () => {
    assert.equal(
        detectActivePadType([idPad('DualSense Wireless Controller (Vendor: 054c Product: 0ce6)', [], [0.9, 0])]),
        'dualsense',
    );
});

test('detectActivePadType — gives the type of the FIRST active pad', () => {
    const pads = [
        idPad('DualSense Wireless Controller (Vendor: 054c Product: 0ce6)', [0, 0]),
        idPad('Xbox Wireless Controller (Vendor: 045e Product: 0b13)', [1, 0]),
    ];
    assert.equal(detectActivePadType(pads), 'xbox');
});

test('shouldThrottlePoll — throttle after 2 s of idleness, fresh input / hidden window does not', () => {
    const now = 100000;
    // Fresh input (< 2 s) → no throttle.
    assert.equal(shouldThrottlePoll(false, now - 500, now, 2000), false);
    // Input older than 2 s, visible window → throttle.
    assert.equal(shouldThrottlePoll(false, now - 3000, now, 2000), true);
    // Hidden window (a game is running) → never throttle (the browser stops rAF).
    assert.equal(shouldThrottlePoll(true, now - 3000, now, 2000), false);
    // Exactly at the threshold → not yet.
    assert.equal(shouldThrottlePoll(false, now - 2000, now, 2000), false);
});

// --- PS combo (PS + Circle/Triangle/Square) ---
// `mkPad` builds a buttons array set exactly at the BTN indexes,
// every other index "not pressed".
function mkPad(index, { ps = false, circle = false, triangle = false, square = false, id = 'test-pad' } = {}) {
    const buttons = new Array(17).fill(null).map(() => ({ pressed: false, value: 0 }));
    buttons[BTN.ps] = { pressed: ps, value: ps ? 1 : 0 };
    buttons[BTN.circle] = { pressed: circle, value: circle ? 1 : 0 };
    buttons[BTN.triangle] = { pressed: triangle, value: triangle ? 1 : 0 };
    buttons[BTN.square] = { pressed: square, value: square ? 1 : 0 };
    return { index, id, buttons, axes: [] };
}

test('detectPsCombos — nothing fires without PS', () => {
    detectPsCombos([]); // reset the module-level state
    const { fired, heldIndices } = detectPsCombos([mkPad(0, { circle: true, triangle: true, square: true })]);
    assert.deepEqual(fired, []);
    assert.equal(heldIndices.size, 0);
});

test('detectPsCombos — PS+Circle/Triangle/Square fires on the rising edge, does not repeat while held', () => {
    detectPsCombos([]);
    let r = detectPsCombos([mkPad(0, { ps: true })]);
    assert.deepEqual(r.fired, []); // only PS, no combo yet
    assert.deepEqual([...r.heldIndices], [0]);

    r = detectPsCombos([mkPad(0, { ps: true, circle: true })]);
    assert.deepEqual(r.fired, [{ padIndex: 0, padId: 'test-pad', combo: 'quit' }]);

    // Circle held, PS held too -> does not fire again.
    r = detectPsCombos([mkPad(0, { ps: true, circle: true })]);
    assert.deepEqual(r.fired, []);

    r = detectPsCombos([mkPad(0, { ps: true, triangle: true })]);
    assert.deepEqual(r.fired, [{ padIndex: 0, padId: 'test-pad', combo: 'disconnect' }]);

    r = detectPsCombos([mkPad(0, { ps: true, square: true })]);
    assert.deepEqual(r.fired, [{ padIndex: 0, padId: 'test-pad', combo: 'identify' }]);
});

test('detectPsCombos — only the Circle/Triangle/Square of the pad holding PS counts as a combo', () => {
    detectPsCombos([]);
    // Pad 0 holds PS, pad 1 (a separate one) now presses Circle -> not a combo.
    const r = detectPsCombos([mkPad(0, { ps: true }), mkPad(1, { circle: true })]);
    assert.deepEqual(r.fired, []);
    assert.deepEqual([...r.heldIndices], [0]);
});

test('detectPsCombos — the state of a disconnected pad is cleared', () => {
    detectPsCombos([]);
    detectPsCombos([mkPad(0, { ps: true, circle: true })]);
    detectPsCombos([]); // the pad disappeared
    // If it "reconnected" with the same index and pressed Circle next to PS right away,
    // that counts as a rising edge again (no "stuck" previous-Circle state).
    const r = detectPsCombos([mkPad(0, { ps: true, circle: true })]);
    assert.deepEqual(r.fired, [{ padIndex: 0, padId: 'test-pad', combo: 'quit' }]);
});

test('maskChordButtons — only the Circle/Triangle/Square of the given pad indices is masked', () => {
    const pads = [mkPad(0, { ps: true, circle: true, triangle: true, square: true }), mkPad(1, { circle: true })];
    const masked = maskChordButtons(pads, new Set([0]));
    assert.equal(masked[0].buttons[BTN.circle].pressed, false);
    assert.equal(masked[0].buttons[BTN.triangle].pressed, false);
    assert.equal(masked[0].buttons[BTN.square].pressed, false);
    assert.equal(masked[0].buttons[BTN.ps].pressed, true); // PS itself is NOT masked
    assert.equal(masked[1].buttons[BTN.circle].pressed, true); // other pad untouched
});

test('maskChordButtons — with empty heldIndices it returns the same array', () => {
    const pads = [mkPad(0, { circle: true })];
    assert.equal(maskChordButtons(pads, new Set()), pads);
});

// Regression test (a production crash): the native Gamepad `axes`/`id`/`index` fields are
// GETTERS on Gamepad.prototype, not own enumerable properties — a `{ ...p, buttons }`
// spread would silently drop them, and aggregatePad() would crash on `.length`. The `mkPad()`
// helper returns a plain object (where the spread would be fine), so this test explicitly builds a
// native-Gamepad-like object with getters.
function nativeLikePad(index, buttons) {
    class FakeGamepad {
        get index() { return index; }
        get id() { return 'native-pad'; }
        get buttons() { return buttons; }
        get axes() { return [0.1, -0.2]; }
    }
    return new FakeGamepad();
}

test('maskChordButtons — preserves axes/id/index for a native Gamepad-like (getter-based) pad too', () => {
    const buttons = new Array(17).fill(null).map(() => ({ pressed: false, value: 0 }));
    buttons[BTN.ps] = { pressed: true, value: 1 };
    buttons[BTN.circle] = { pressed: true, value: 1 };
    const pads = [nativeLikePad(0, buttons)];
    const masked = maskChordButtons(pads, new Set([0]));
    assert.equal(masked[0].index, 0);
    assert.equal(masked[0].id, 'native-pad');
    assert.deepEqual(masked[0].axes, [0.1, -0.2]);
    assert.equal(masked[0].buttons[BTN.circle].pressed, false);
    // A downstream aggregatePad() ne haljon el a maszkolt padon.
    assert.doesNotThrow(() => aggregatePad(masked));
});

// --- resolveDisconnectTarget (PS+Triangle disconnect target) ---
// Agreed: on disconnect we err on the SAFE side — it only disconnects in an unambiguous case.
const btDev = (mac, type, connected = true) => ({ mac, type, connected });

test('resolveDisconnectTarget — no connected BT controller -> null (probably USB)', () => {
    assert.equal(resolveDisconnectTarget('dualsense', []), null);
    assert.equal(resolveDisconnectTarget('dualsense', [btDev('AA:BB', 'dualsense', false)]), null);
});

test('resolveDisconnectTarget — exactly 1 BT controller -> unambiguous, regardless of type', () => {
    const only = btDev('AA:BB', 'xbox');
    assert.equal(resolveDisconnectTarget('dualsense', [only]), only);
});

test('resolveDisconnectTarget — 2+ BT controllers, a unique type match -> that one', () => {
    const ds = btDev('AA:BB', 'dualsense');
    const xb = btDev('CC:DD', 'xbox');
    assert.equal(resolveDisconnectTarget('xbox', [ds, xb]), xb);
});

test('resolveDisconnectTarget — 2+ BT controllers of the same type -> null (we do not guess)', () => {
    const ds1 = btDev('AA:BB', 'dualsense');
    const ds2 = btDev('CC:DD', 'dualsense');
    assert.equal(resolveDisconnectTarget('dualsense', [ds1, ds2]), null);
});

// --- disconnectDecision (PS+Triangle, by evdev MAC) ---

test('disconnectDecision — the evdev MAC is that of a connected BT controller -> exactly that one', () => {
    const bt = [
        { mac: 'AA:AA:AA:AA:AA:AA', connected: true, type: 'dualsense' },
        { mac: 'BB:BB:BB:BB:BB:BB', connected: true, type: 'dualsense' },
    ];
    assert.deepEqual(disconnectDecision({ ok: true, matched: true, mac: 'bb:bb:bb:bb:bb:bb' }, bt),
        { action: 'disconnect', mac: 'BB:BB:BB:BB:BB:BB' });
});

test('disconnectDecision — hit without MAC / non-BT MAC / disconnected -> wired', () => {
    const bt = [{ mac: 'AA:AA:AA:AA:AA:AA', connected: false }];
    assert.deepEqual(disconnectDecision({ ok: true, matched: true, mac: null }, bt), { action: 'wired' });
    assert.deepEqual(disconnectDecision({ ok: true, matched: true, mac: 'CC:CC:CC:CC:CC:CC' }, bt), { action: 'wired' });
    assert.deepEqual(disconnectDecision({ ok: true, matched: true, mac: 'AA:AA:AA:AA:AA:AA' }, bt), { action: 'wired' });
});

test('disconnectDecision — no unambiguous evdev hit -> fallback', () => {
    assert.deepEqual(disconnectDecision({ ok: true, matched: false, mac: null }, []), { action: 'fallback' });
    assert.deepEqual(disconnectDecision({ ok: false, matched: false, mac: null }, []), { action: 'fallback' });
    assert.deepEqual(disconnectDecision(null, []), { action: 'fallback' });
});
