'use strict';

// The pure parsers extracted from main.js (lib/parse.js) — on recorded sample outputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseSinks, findSinkNameByPattern, parseVolumePercent, clampVolume, stepVolume,
    btInfoField, parseBattery, parseUpowerBattery, parsePairedMacs, parseMonitors,
    escapeRegExp,
} = require('../lib/parse.js');

// --- pactl list sinks (LC_ALL=C) ---
const SINKS = `Sink #42
	State: RUNNING
	Name: alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra2
	Description: LG ULTRAWIDE
	Driver: PipeWire

Sink #55
	State: SUSPENDED
	Name: bluez_output.AC_80_0A.1
	Description: WH-1000XM4
	Driver: PipeWire
`;

test('parseSinks — name/description/isDefault', () => {
    const sinks = parseSinks(SINKS, 'bluez_output.AC_80_0A.1');
    assert.equal(sinks.length, 2);
    assert.deepEqual(sinks[0], {
        name: 'alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra2',
        description: 'LG ULTRAWIDE',
        isDefault: false,
    });
    assert.equal(sinks[1].isDefault, true);
});

test('parseSinks — the name in the absence of a description', () => {
    const sinks = parseSinks('Sink #1\n\tName: foo\n', '');
    assert.equal(sinks[0].description, 'foo');
});

test('parseSinks — empty / garbage input', () => {
    assert.deepEqual(parseSinks('', 'x'), []);
    assert.deepEqual(parseSinks('nothing meaningful', 'x'), []);
});

test('findSinkNameByPattern', () => {
    assert.equal(
        findSinkNameByPattern(SINKS, /LG ULTRAWIDE|hdmi-stereo-extra/i),
        'alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra2',
    );
    assert.equal(findSinkNameByPattern(SINKS, /no such/), null);
});

// --- volume ---
test('parseVolumePercent', () => {
    assert.equal(parseVolumePercent('Volume: front-left: 45000 /  69% / -9.30 dB'), 69);
    assert.equal(parseVolumePercent('no percent'), 100);
});

test('clampVolume', () => {
    assert.equal(clampVolume(50), 50);
    assert.equal(clampVolume(-10), 0);
    assert.equal(clampVolume(150), 100);
});

test('stepVolume — ceiling upward, always steps downward; a value above the ceiling does not jump down', () => {
    assert.equal(stepVolume(40, 5), 45);
    assert.equal(stepVolume(98, 5), 100);
    assert.equal(stepVolume(3, -5), 0);
    assert.equal(stepVolume(68, 5, 70), 70);
    assert.equal(stepVolume(70, 5, 70), 70);
    assert.equal(stepVolume(90, 5, 70), 90); // turned up with the TV remote: does not pull it down
    assert.equal(stepVolume(90, -5, 70), 85);
});

// --- bluetoothctl info ---
const BT_INFO = `Device AC:80:0A:12:34:56 (public)
	Name: DualSense Wireless Controller
	Icon: input-gaming
	Connected: yes
	Modalias: usb:v054Cp0CE6d0100
	Battery Percentage: 0x5a (90)
`;

test('btInfoField', () => {
    assert.equal(btInfoField(BT_INFO, 'Name'), 'DualSense Wireless Controller');
    assert.equal(btInfoField(BT_INFO, 'Connected'), 'yes');
    assert.equal(btInfoField(BT_INFO, 'Icon'), 'input-gaming');
    assert.equal(btInfoField(BT_INFO, 'No such field'), null);
    assert.equal(btInfoField(null, 'Name'), null);
});

test('parseBattery', () => {
    assert.equal(parseBattery(BT_INFO), 90);
    assert.equal(parseBattery('Name: Foo\nConnected: no\n'), null); // no battery line
    assert.equal(parseBattery('Battery Percentage: 77\n'), 77);     // without parentheses too
});

test('parseUpowerBattery', () => {
    const dump = [
        'Device: /org/freedesktop/UPower/devices/battery_ps_controller_battery_7co66oefo10oa4o39',
        '  native-path:          ps-controller-battery-02:00:00:00:00:b2',
        '  serial:               02:00:00:00:00:b2',
        '  gaming-input',
        '    percentage:          25%',
        '',
        'Device: /org/freedesktop/UPower/devices/gaming_input_dev_02_00_00_00_00_C3',
        '  serial:               02:00:00:00:00:C3',
        '    percentage:          89%',
        '',
        'Device: /org/freedesktop/UPower/devices/battery_hidpp_battery_0',
        '  serial:               0c-96-5c-4f',
        '    percentage:          55% (should be ignored)',
    ].join('\n');
    // UPower sees the DualSense, bluetoothctl does not (no GATT Battery Service over BT)
    assert.equal(parseUpowerBattery(dump, '02:00:00:00:00:B2'), 25);
    // the MAC is separated by : in some places and - in others in the dump - normalized matching
    assert.equal(parseUpowerBattery(dump, '02:00:00:00:00:c3'), 89);
    // unknown MAC / empty input -> null
    assert.equal(parseUpowerBattery(dump, '00:11:22:33:44:55'), null);
    assert.equal(parseUpowerBattery('', '02:00:00:00:00:B2'), null);
    assert.equal(parseUpowerBattery(dump, ''), null);
});

test('parsePairedMacs', () => {
    const out = 'Device AC:80:0A:12:34:56 DualSense Wireless Controller\nDevice 11:22:33:44:55:66 WH-1000XM4\n';
    assert.deepEqual(parsePairedMacs(out), ['AC:80:0A:12:34:56', '11:22:33:44:55:66']);
    assert.deepEqual(parsePairedMacs(''), []);
    // No Bluetooth adapter (a desktop PC): bluetoothctl prints this instead of a device list — it is not a device.
    assert.deepEqual(parsePairedMacs('No default controller available\n'), []);
    assert.deepEqual(parsePairedMacs('Device AC:80:0A:12:34:56\r\n[CHG] Controller default\n'), ['AC:80:0A:12:34:56']);
});

// --- kscreen-doctor -j ---
const KSCREEN = {
    outputs: [
        {
            name: 'DP-3', connected: true, enabled: true, priority: 1, currentModeId: 'm1',
            modes: [{ id: 'm1', size: { width: 2560, height: 1080 } }],
        },
        { name: 'DP-2', connected: false, enabled: false, priority: 0, modes: [] },
        {
            name: 'DP-1', connected: true, enabled: false, priority: 0, currentModeId: 'x',
            modes: [{ id: 'y', size: { width: 3840, height: 2160 } }],
        },
    ],
};

test('parseMonitors — only the connected ones, connector + resolution label', () => {
    const mons = parseMonitors(KSCREEN);
    assert.equal(mons.length, 2);
    assert.deepEqual(mons[0], { name: 'DP-3', width: 2560, height: 1080, active: true, priority: 1, label: 'DP-3 — 2560×1080' });
    // DP-1: no mode matching currentModeId -> no resolution, label = connector
    assert.deepEqual(mons[1], { name: 'DP-1', width: null, height: null, active: false, priority: 0, label: 'DP-1' });
});

test('parseMonitors — missing priority -> 0', () => {
    const mons = parseMonitors({ outputs: [{ name: 'HDMI-A-1', connected: true, enabled: true, modes: [] }] });
    assert.equal(mons[0].priority, 0);
});

test('parseMonitors — bad input', () => {
    assert.deepEqual(parseMonitors(null), []);
    assert.deepEqual(parseMonitors({}), []);
});

// --- string helpers ---
test('escapeRegExp — regex metacharacters escaped, a dynamic pattern can be matched safely', () => {
    assert.equal(escapeRegExp('a.b-c'), 'a\\.b-c');
    assert.equal(new RegExp(escapeRegExp('x.y')).test('x.y'), true);
    assert.equal(new RegExp(escapeRegExp('x.y')).test('xzy'), false);
    assert.equal(escapeRegExp('SCUS-97472'), 'SCUS-97472'); // "-" is not a regex metacharacter, no escape needed
});
