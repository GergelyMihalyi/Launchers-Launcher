'use strict';

// lib/bluetooth/bluetooth.js — pure helper of the device discovery started from the UI.
// `discoverDevices` / `performBtPair` call a live `bluetoothctl` (not testable in the sandbox);
// the `isDiscoverCandidate` filter logic is.

const test = require('node:test');
const assert = require('node:assert/strict');
const bt = require('../../lib/bluetooth/bluetooth.js');

const controllerInfo = 'Device AA:BB\n\tName: Xbox Wireless Controller\n\tPaired: no\n\tIcon: input-gaming\n';
const headsetInfo = 'Device CC:DD\n\tName: WH-1000XM4\n\tPaired: no\n\tIcon: audio-headset\n';
const pairedInfo = 'Device EE:FF\n\tName: Old Pad\n\tPaired: yes\n\tIcon: input-gaming\n';
const phoneInfo = 'Device 11:22\n\tName: Pixel\n\tPaired: no\n\tIcon: phone\n';

test('isDiscoverCandidate — controller kind: only input-gaming + Paired: no', () => {
    const paired = new Set();
    assert.equal(bt.isDiscoverCandidate('controller', 'AA:BB', controllerInfo, paired), true);
    assert.equal(bt.isDiscoverCandidate('controller', 'EE:FF', pairedInfo, paired), false); // Paired: yes
    assert.equal(bt.isDiscoverCandidate('controller', '11:22', phoneInfo, paired), false);  // wrong Icon
    assert.equal(bt.isDiscoverCandidate('controller', 'CC:DD', headsetInfo, paired), false); // headphones
});

test('isDiscoverCandidate — headset kind: audio-* accepted', () => {
    const paired = new Set();
    assert.equal(bt.isDiscoverCandidate('headset', 'CC:DD', headsetInfo, paired), true);
    assert.equal(bt.isDiscoverCandidate('headset', 'AA:BB', controllerInfo, paired), false);
});

test('isDiscoverCandidate — an already paired MAC drops out', () => {
    const paired = new Set(['AA:BB']);
    assert.equal(bt.isDiscoverCandidate('controller', 'AA:BB', controllerInfo, paired), false);
});

test('isDiscoverCandidate — missing info / unknown kind → false', () => {
    assert.equal(bt.isDiscoverCandidate('controller', 'AA:BB', null, new Set()), false);
    assert.equal(bt.isDiscoverCandidate('no-such', 'AA:BB', controllerInfo, new Set()), false);
});

test('DISCOVER_ICONS — both kinds defined', () => {
    assert.ok(bt.DISCOVER_ICONS.controller.includes('input-gaming'));
    assert.ok(bt.DISCOVER_ICONS.headset.includes('audio-headset'));
});
