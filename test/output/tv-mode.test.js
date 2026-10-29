'use strict';

// lib/output/tv-mode.js — restoring the desktop audio on TV-mode EXIT. `resolveDesktopSink`
// is a pure decision helper; the no-op branch of `restoreDesktopAudio` (no desktop.sink) is covered too.
// XDG_CONFIG_HOME to a temp directory BEFORE the `require` (like config.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useTempConfigHome } = require('../helpers/fs.js');

const { reset } = useTempConfigHome('gl-tvmode-exit-');
const config = require('../../lib/config.js');
const { resolveDesktopSink, restoreDesktopAudio } = require('../../lib/output/tv-mode.js');

const SINKS = `Sink #40
	State: SUSPENDED
	Name: alsa_output.usb-Generic_USB_Audio-00.analog-stereo
	Description: USB Headset
Sink #42
	State: RUNNING
	Name: alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra3
	Description: LG ULTRAWIDE Digital Stereo (HDMI 3)`;

test('resolveDesktopSink — gives the exact match if there is one', () => {
    assert.equal(
        resolveDesktopSink('alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra3', SINKS),
        'alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra3',
    );
});

test('resolveDesktopSink — shifted numbering: the prefix fits another sink', () => {
    // saved: ...extra2 (not in the list), present: ...extra3
    assert.equal(
        resolveDesktopSink('alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra2', SINKS),
        'alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra3',
    );
});

test('resolveDesktopSink — the exact match is NAME-level, not a substring (extra2 ≠ extra20)', () => {
    const sinks = `Sink #1
	Name: alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra20
	Description: HDMI 20`;
    // The saved ...extra2 is not there exactly — the prefix match gives ...extra20, NOT the
    // saved name (the old `includes` would have returned the nonexistent ...extra2).
    assert.equal(
        resolveDesktopSink('alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra2', sinks),
        'alsa_output.pci-0000_0a_00.1.hdmi-stereo-extra20',
    );
});

test('resolveDesktopSink — no match and no prefix hit -> null', () => {
    assert.equal(resolveDesktopSink('alsa_output.pci-0000_ff_00.9.hdmi-stereo-extra7', SINKS), null);
});

test('resolveDesktopSink — a name without a trailing number that is missing -> null (no blind prefix)', () => {
    assert.equal(resolveDesktopSink('alsa_output.some.removed-device', SINKS), null);
});

test('resolveDesktopSink — a too short prefix does not match (>=12 guard)', () => {
    assert.equal(resolveDesktopSink('sink9', 'Sink #1\n\tName: sink-other\n'), null);
});

test('resolveDesktopSink — empty/null input -> null', () => {
    assert.equal(resolveDesktopSink('', SINKS), null);
    assert.equal(resolveDesktopSink(null, SINKS), null);
    assert.equal(resolveDesktopSink(undefined, SINKS), null);
});

test('restoreDesktopAudio — no desktop.sink profile -> logged no-op, null', async () => {
    reset();
    config.set('display', { monitor: 'DP-3' }); // has display, but no desktop
    const logs = [];
    const result = await restoreDesktopAudio((m) => logs.push(m));
    assert.equal(result, null);
    assert.ok(logs.some((m) => /no desktop\.sink profile/.test(m)), `log: ${logs.join(' | ')}`);
});
