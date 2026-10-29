'use strict';

// The shared controller type detection (controller-id.js) — main + renderer call the same.
// On fixed sample strings: bluetoothctl Modalias / Chromium gamepad id / plain name.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyController, controllerSymbols, CONTROLLER_SYMBOLS } = require('../controller-id.js');

test('DualSense — Modalias (bluetoothctl)', () => {
    assert.equal(classifyController('usb:v054Cp0CE6d0100 DualSense Wireless Controller'), 'dualsense');
});

test('DualSense — Chromium gamepad id', () => {
    assert.equal(
        classifyController('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'),
        'dualsense',
    );
});

test('DualShock 4 — Sony vendor, different product code', () => {
    assert.equal(classifyController('usb:v054Cp09CCd8100 Wireless Controller'), 'dualshock');
    assert.equal(
        classifyController('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'),
        'dualshock',
    );
});

test('Sony BT controller with the anonymous name "Wireless Controller" → dualshock (not generic)', () => {
    assert.equal(classifyController('Wireless Controller'), 'dualshock');
});

test('Xbox — vendor 045e / name', () => {
    assert.equal(classifyController('usb:v045Ep0B13d0513 Xbox Wireless Controller'), 'xbox');
    assert.equal(classifyController('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
    assert.equal(classifyController('Microsoft X-Box 360 pad (XInput)'), 'xbox');
});

test('unknown → generic', () => {
    assert.equal(classifyController('8BitDo Pro 2'), 'generic');
    assert.equal(classifyController(''), 'generic');
    assert.equal(classifyController(null), 'generic');
    assert.equal(classifyController(undefined), 'generic');
});

test('non-Sony device whose product code is 054c → NOT dualshock', () => {
    // the regex takes the vendor group (045e), not a 054c occurring anywhere in the string
    assert.equal(classifyController('Foo Pad (STANDARD GAMEPAD Vendor: 045e Product: 054c)'), 'xbox');
});

// --- controllerSymbols: the output of classifyController -> button glyph set ---

test('controllerSymbols — the Sony pads get the PlayStation symbols', () => {
    assert.deepEqual(controllerSymbols('dualsense'), CONTROLLER_SYMBOLS.playstation);
    assert.deepEqual(controllerSymbols('dualshock'), CONTROLLER_SYMBOLS.playstation);
    assert.equal(controllerSymbols('dualsense').confirm, '✕');
});

test('controllerSymbols — Xbox: A / B / Y / X (by physical position)', () => {
    const s = controllerSymbols('xbox');
    assert.equal(s.confirm, 'A'); // buttons[0], bottom
    assert.equal(s.back, 'B');    // buttons[1], right
    assert.equal(s.menu, 'Y');    // buttons[3], top
    assert.equal(s.alt, 'X');     // buttons[2], left
});

test('controllerSymbols — generic: circled numbers', () => {
    assert.equal(controllerSymbols('generic').confirm, '①');
    assert.equal(controllerSymbols('generic').back, '②');
});

test('controllerSymbols — unknown / undefined -> playstation (the current default)', () => {
    assert.deepEqual(controllerSymbols('something'), CONTROLLER_SYMBOLS.playstation);
    assert.deepEqual(controllerSymbols(undefined), CONTROLLER_SYMBOLS.playstation);
});

test('controllerSymbols — every type has the 7 action keys', () => {
    for (const type of ['playstation', 'xbox', 'nintendo', 'generic']) {
        const s = CONTROLLER_SYMBOLS[type];
        for (const k of ['confirm', 'back', 'menu', 'alt', 'home', 'view', 'start']) {
            assert.equal(typeof s[k], 'string', `${type}.${k}`);
            assert.ok(s[k].length >= 1);
        }
    }
});

test('controllerSymbols — view/start (Share/View + Options/Menu button, see quick-buttons.md)', () => {
    assert.equal(controllerSymbols('dualsense').view, '⧉');
    assert.equal(controllerSymbols('xbox').view, '⧉');
    assert.equal(controllerSymbols('generic').start, '☰');
});
