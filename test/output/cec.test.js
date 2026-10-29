'use strict';

// The `parseCecAdapter()` parser of lib/output/cec.js — on recorded `cec-ctl` (no args) output.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCecAdapter, hasCecDevice, cecTarget } = require('../../lib/output/cec.js');

// Real `cec-ctl` output (on the author's machine, shortened).
const CEC_CTL = `Driver Info:
	Driver Name                : amdgpu
	Adapter Name               : DP-2
	Capabilities               : 0x0000037e
		Logical Addresses
		Transmit
	Physical Address           : 1.0.0.0
	CEC Version                : 2.0
	OSD Name                   : 'PC'
`;

test('parseCecAdapter — gives the connector of the Adapter Name', () => {
    assert.equal(parseCecAdapter(CEC_CTL), 'DP-2');
});

test('parseCecAdapter — another connector name works too', () => {
    assert.equal(parseCecAdapter('\tAdapter Name : HDMI-A-1\n'), 'HDMI-A-1');
});

test('parseCecAdapter — missing line / bad input -> null', () => {
    assert.equal(parseCecAdapter('Driver Name : amdgpu\n'), null);
    assert.equal(parseCecAdapter(''), null);
    assert.equal(parseCecAdapter(null), null);
    assert.equal(parseCecAdapter(undefined), null);
});

test('hasCecDevice — recognizes the cec0/cec1 node from a /dev entry list', () => {
    assert.equal(hasCecDevice(['null', 'zero', 'cec0', 'dri']), true);
    assert.equal(hasCecDevice(['cec12']), true);
    assert.equal(hasCecDevice(['null', 'ceca', 'ceclog', 'seccomp']), false);
    assert.equal(hasCecDevice([]), false);
    assert.equal(hasCecDevice(null), false);
    assert.equal(hasCecDevice(undefined), false);
});

test('cecTarget — clamps to 0..15, bad value -> 0', () => {
    assert.equal(cecTarget(0), 0);
    assert.equal(cecTarget(5), 5);
    assert.equal(cecTarget(15), 15);
    assert.equal(cecTarget(-1), 0);
    assert.equal(cecTarget(16), 0);
    assert.equal(cecTarget(3.5), 0);
    assert.equal(cecTarget('5'), 0);
    assert.equal(cecTarget(undefined), 0);
});
