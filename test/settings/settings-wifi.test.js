'use strict';

// renderer/settings/settings-wifi.js — the pure helpers: the focus follows the NETWORK across the re-sorted reload (after a switch the
// focus used to stay on the old, now "saved" network, and the next ✕ switched back) + when the password keyboard opens again.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.SETTINGS_VIEWS = {};
const { wifiNavRows, wifiState, wifiRowKey, wifiFocusIndex, wifiRetryWithPassword } = require('../../renderer/settings/settings-wifi.js');

const net = (ssid, active = false) => ({ ssid, signal: 80, active, saved: true });

test('wifiFocusIndex — after a switch the focus stays on the selected network (in the reordered list)', () => {
    Object.assign(wifiState, { device: true, radio: true, scanning: false, refreshing: false, items: [net('MB_5GHz', true), net('MB')] });
    const before = wifiNavRows();
    const key = wifiRowKey(before[1]); // MB focused
    assert.equal(key, 'net:MB');
    wifiState.items = [net('MB', true), net('MB_5GHz')]; // MB is active now → first
    assert.equal(wifiFocusIndex(wifiNavRows(), key, 1), 0);
});

test('wifiFocusIndex — a vanished row → the old index clamped into the list; the non-network rows can be tracked too', () => {
    Object.assign(wifiState, { device: true, radio: true, scanning: false, refreshing: false, items: [net('A'), net('B')] });
    const rows = wifiNavRows(); // A, B, hidden, rescan
    assert.equal(wifiFocusIndex(rows, 'net:Gone', 9), rows.length - 1);
    assert.equal(wifiFocusIndex(rows, 'rescan', 0), 3);
    assert.equal(wifiFocusIndex([], null, 3), 0);
});

test('wifiNavRows — during a background refresh there is no "Rescan" row, during a blocking scan only the networks', () => {
    Object.assign(wifiState, { device: true, radio: true, items: [net('A')], scanning: false, refreshing: true });
    assert.deepEqual(wifiNavRows().map((r) => r.type), ['net', 'hidden']);
    Object.assign(wifiState, { scanning: true, refreshing: false });
    assert.deepEqual(wifiNavRows().map((r) => r.type), ['net']);
});

test('wifiRetryWithPassword — error of a typed password / a saved password is wrong → the keyboard again', () => {
    assert.equal(wifiRetryWithPassword('badPassword', true), true);
    assert.equal(wifiRetryWithPassword('timeout', true), true);
    assert.equal(wifiRetryWithPassword('badPasswordFormat', true), true);
    assert.equal(wifiRetryWithPassword('notFound', true), false);
    assert.equal(wifiRetryWithPassword('badPassword', false), true);
    assert.equal(wifiRetryWithPassword('needPassword', false), true);
    assert.equal(wifiRetryWithPassword('timeout', false), false);
});
