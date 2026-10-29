'use strict';

// Pure helper of the home-screen controller badge: `controllerChips(btItems, pads)`
// -> the chips to show (BT controllers from the list-bt-devices payload + the extra USB ones
// from the Gamepad API). renderer/controller/controller-status.js is a classic <script> in the
// browser, module.exports guard at the bottom of the file (like carousel.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { controllerChips, pickBatteryWarnings, chipIndexForPad, chipIndexForMac } = require('../../renderer/controller/controller-status.js');

test('controllerChips — empty input -> [] (hidden bar)', () => {
    assert.deepEqual(controllerChips([], []), []);
    assert.deepEqual(controllerChips(null, null), []);
});

test('controllerChips — 1 BT DualSense, connected, battery 82', () => {
    const chips = controllerChips([{ connected: true, type: 'dualsense', battery: 82, mac: 'AA' }], []);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].type, 'dualsense');
    assert.equal(chips[0].battery, 82);
    assert.equal(chips[0].source, 'bt');
});

test('controllerChips — 2 BT (DualSense + Xbox), one of them has no battery -> stays null', () => {
    const chips = controllerChips([
        { connected: true, type: 'dualsense', battery: 82, mac: 'AA' },
        { connected: true, type: 'xbox', battery: null, mac: 'BB' },
    ], []);
    assert.equal(chips.length, 2);
    assert.equal(chips[1].type, 'xbox');
    assert.equal(chips[1].battery, null);
});

test('controllerChips — a connected:false BT device is skipped', () => {
    const chips = controllerChips([{ connected: false, type: 'dualsense', battery: 50, mac: 'AA' }], []);
    assert.deepEqual(chips, []);
});

test('controllerChips — 1 BT connected + 2 pads -> 1 BT chip + 1 USB chip', () => {
    const chips = controllerChips(
        [{ connected: true, type: 'dualsense', battery: 82, mac: 'AA' }],
        [{ id: 'DualSense Wireless Controller' }, { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)' }],
    );
    assert.equal(chips.length, 2);
    assert.equal(chips[0].source, 'bt');
    assert.equal(chips[1].source, 'usb');
    assert.equal(chips[1].type, 'xbox');
    assert.equal(chips[1].battery, null);
});

test('controllerChips — 0 BT + 1 pad -> 1 USB chip (type from pad.id)', () => {
    const chips = controllerChips([], [{ id: 'Sony Interactive DualSense' }]);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].source, 'usb');
    assert.equal(chips[0].type, 'dualsense');
});

test('controllerChips — BT device of unknown type -> generic', () => {
    const chips = controllerChips([{ connected: true, mac: 'AA' }], []);
    assert.equal(chips[0].type, 'generic');
});

// --- pickBatteryWarnings (controller battery warning, hysteresis) ---

test('pickBatteryWarnings — a connected controller below LOW warns once', () => {
    const items = [{ mac: 'AA', name: 'DualSense', connected: true, battery: 12 }];
    const r1 = pickBatteryWarnings(items, {});
    assert.deepEqual(r1.warn, [{ name: 'DualSense', battery: 12 }]);
    assert.equal(r1.warned.AA, true);
    // the same query again: no warning any more
    const r2 = pickBatteryWarnings(items, r1.warned);
    assert.deepEqual(r2.warn, []);
});

test('pickBatteryWarnings — re-arms only after climbing above CLEAR', () => {
    let warned = { AA: true };
    // 20% (above LOW, below CLEAR) — neither warning nor reset
    ({ warned } = pickBatteryWarnings([{ mac: 'AA', name: 'x', connected: true, battery: 20 }], warned));
    assert.equal(warned.AA, true);
    // 30% (above CLEAR) — reset
    ({ warned } = pickBatteryWarnings([{ mac: 'AA', name: 'x', connected: true, battery: 30 }], warned));
    assert.equal(warned.AA, undefined);
    // drains again — warns again
    const r = pickBatteryWarnings([{ mac: 'AA', name: 'x', connected: true, battery: 10 }], warned);
    assert.equal(r.warn.length, 1);
});

test('pickBatteryWarnings — skips a device without battery / disconnected', () => {
    const items = [
        { mac: 'AA', name: 'no battery', connected: true, battery: null },
        { mac: 'BB', name: 'offline', connected: false, battery: 5 },
    ];
    assert.deepEqual(pickBatteryWarnings(items, {}).warn, []);
});

// --- chipIndexForPad (position of the PS+Square "which controller is which" flash) ---

test('chipIndexForPad — finds the position of pad.index', () => {
    const pads = [{ index: 0 }, { index: 2 }, { index: 5 }];
    assert.equal(chipIndexForPad(2, pads), 1);
    assert.equal(chipIndexForPad(5, pads), 2);
});

test('chipIndexForPad — pad not found -> -1', () => {
    assert.equal(chipIndexForPad(9, [{ index: 0 }]), -1);
    assert.equal(chipIndexForPad(0, []), -1);
    assert.equal(chipIndexForPad(0, null), -1);
});

// --- chipIndexForMac (PS+Square: the pressing controller's MAC from evdev, exact flash) ---

test('chipIndexForMac — finds the BT chip by MAC (with lowercase input too)', () => {
    const chips = controllerChips([
        { connected: true, type: 'dualsense', mac: 'aa:aa:aa:aa:aa:aa' },
        { connected: true, type: 'dualsense', mac: 'BB:BB:BB:BB:BB:BB' },
    ], [{ id: 'x' }, { id: 'y' }, { id: 'Xbox Wireless Controller' }]);
    assert.equal(chips[0].mac, 'AA:AA:AA:AA:AA:AA');
    assert.equal(chips[2].mac, null); // extra USB chip
    assert.equal(chipIndexForMac('bb:bb:bb:bb:bb:bb', chips), 1);
    assert.equal(chipIndexForMac('AA:AA:AA:AA:AA:AA', chips), 0);
});

test('chipIndexForMac — no MAC / no such chip -> -1', () => {
    assert.equal(chipIndexForMac(null, [{ mac: null }]), -1);
    assert.equal(chipIndexForMac('CC:CC:CC:CC:CC:CC', [{ mac: 'AA:AA:AA:AA:AA:AA' }]), -1);
    assert.equal(chipIndexForMac('AA:AA:AA:AA:AA:AA', null), -1);
});

test('noPadHintVisible: only without a pad, after the delay elapsed, not dismissed, with a visible window', () => {
    const { noPadHintVisible } = require('../../renderer/controller/controller-status.js');
    assert.equal(noPadHintVisible(0, true, false, false), true);
    assert.equal(noPadHintVisible(1, true, false, false), false);
    assert.equal(noPadHintVisible(0, false, false, false), false);
    assert.equal(noPadHintVisible(0, true, true, false), false);
    assert.equal(noPadHintVisible(0, true, false, true), false);
});
