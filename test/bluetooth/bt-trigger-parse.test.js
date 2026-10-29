'use strict';

// `parseConnectEvent()` of lib/bluetooth/bt-trigger-parse.js — on recorded
// `gdbus monitor --system --dest org.bluez` output verified on the author's machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConnectEvent, macFromDevSegment } = require('../../lib/bluetooth/bt-trigger-parse.js');

// Real lines recorded on the machine.
const CONNECT_TRUE =
    "/org/bluez/hci0/dev_02_00_00_00_00_B2: org.freedesktop.DBus.Properties.PropertiesChanged ('org.bluez.Device1', {'Connected': <true>}, @as [])";
const CONNECT_FALSE =
    "/org/bluez/hci0/dev_02_00_00_00_00_A1: org.freedesktop.DBus.Properties.PropertiesChanged ('org.bluez.Device1', {'Connected': <false>}, @as [])";
const BEARER_DISC =
    "/org/bluez/hci0/dev_02_00_00_00_00_A1: org.bluez.Bearer.BREDR1.Disconnected ('org.bluez.Reason.Remote', 'Connection terminated by remote user')";
const DEVICE1_DISC =
    "/org/bluez/hci0/dev_02_00_00_00_00_A1: org.bluez.Device1.Disconnected ('org.bluez.Reason.Remote', 'Connection terminated by remote user')";

test('parseConnectEvent — Connected: <true> -> MAC', () => {
    assert.equal(parseConnectEvent(CONNECT_TRUE), '02:00:00:00:00:B2');
});

test('parseConnectEvent — Connected: <false> -> null', () => {
    assert.equal(parseConnectEvent(CONNECT_FALSE), null);
});

test('parseConnectEvent — other BlueZ signals / header line -> null', () => {
    assert.equal(parseConnectEvent(BEARER_DISC), null);
    assert.equal(parseConnectEvent(DEVICE1_DISC), null);
    assert.equal(parseConnectEvent('Monitoring signals from all objects owned by org.bluez'), null);
    assert.equal(parseConnectEvent('The name org.bluez is owned by :1.7'), null);
    assert.equal(parseConnectEvent(''), null);
    assert.equal(parseConnectEvent(null), null);
    assert.equal(parseConnectEvent(undefined), null);
});

test('parseConnectEvent — another adapter (hci1) works too', () => {
    assert.equal(
        parseConnectEvent(
            "/org/bluez/hci1/dev_AA_BB_CC_DD_EE_FF: org.freedesktop.DBus.Properties.PropertiesChanged ('org.bluez.Device1', {'Connected': <true>}, @as [])",
        ),
        'AA:BB:CC:DD:EE:FF',
    );
});

test('parseConnectEvent — non-Connected property change (RSSI) -> null', () => {
    assert.equal(
        parseConnectEvent(
            "/org/bluez/hci0/dev_02_00_00_00_00_B2: org.freedesktop.DBus.Properties.PropertiesChanged ('org.bluez.Device1', {'RSSI': <int16 -55>}, @as [])",
        ),
        null,
    );
});

test('parseConnectEvent — property batch containing Connected: <true> -> MAC', () => {
    assert.equal(
        parseConnectEvent(
            "/org/bluez/hci0/dev_02_00_00_00_00_B2: org.freedesktop.DBus.Properties.PropertiesChanged ('org.bluez.Device1', {'Connected': <true>, 'ServicesResolved': <false>}, @as [])",
        ),
        '02:00:00:00:00:B2',
    );
});

test('macFromDevSegment — underscore -> colon, uppercase', () => {
    assert.equal(macFromDevSegment('02_00_00_00_00_b2'), '02:00:00:00:00:B2');
});
