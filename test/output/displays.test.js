'use strict';

// lib/output/displays.js — `parseDesktopProfile` (pure function).

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../lib/config.js');
const { parseDesktopProfile, normalizeDisplayConfig, activeLayoutArgs, restoreMonitors } = require('../../lib/output/displays.js');

test('parseDesktopProfile — valid profile, disableOthers default true, pinned default false', () => {
    assert.deepEqual(parseDesktopProfile({ monitors: ['DP-3', 'DP-1'], sink: 'alsa_output.x' }), {
        monitors: ['DP-3', 'DP-1'], sink: 'alsa_output.x', disableOthers: true, pinned: false,
    });
});

test('parseDesktopProfile — an explicit false disableOthers is kept', () => {
    assert.equal(parseDesktopProfile({ monitors: ['DP-3'], disableOthers: false }).disableOthers, false);
});

test('parseDesktopProfile — pinned is true only for an explicit true', () => {
    assert.equal(parseDesktopProfile({ monitors: ['DP-3'] }).pinned, false);
    assert.equal(parseDesktopProfile({ monitors: ['DP-3'], pinned: false }).pinned, false);
    assert.equal(parseDesktopProfile({ monitors: ['DP-3'], pinned: 'igen' }).pinned, false);
    assert.equal(parseDesktopProfile({ monitors: ['DP-3'], pinned: true }).pinned, true);
});

test('parseDesktopProfile — null for missing/bad input', () => {
    assert.equal(parseDesktopProfile(null), null);
    assert.equal(parseDesktopProfile(undefined), null);
    assert.equal(parseDesktopProfile('not an object'), null);
    assert.equal(parseDesktopProfile([]), null);
});

test('parseDesktopProfile — null without empty monitors AND sink', () => {
    assert.equal(parseDesktopProfile({ monitors: [], sink: null }), null);
});

test('parseDesktopProfile — a sink alone is enough too (monitors may stay empty)', () => {
    assert.deepEqual(parseDesktopProfile({ monitors: [], sink: 'alsa_output.x' }), {
        monitors: [], sink: 'alsa_output.x', disableOthers: true, pinned: false,
    });
});

test('parseDesktopProfile — filters out the non-string elements of the monitors array', () => {
    assert.deepEqual(parseDesktopProfile({ monitors: ['DP-3', 1, null, 'DP-1'] }).monitors, ['DP-3', 'DP-1']);
});

// --- normalizeDisplayConfig (a readDisplayConfig magja) ---

test('normalizeDisplayConfig — missing/bad -> monitor/sink/desktop null, the TV keys are ABSENT', () => {
    for (const bad of [null, undefined, 'x', [], 42]) {
        assert.deepEqual(normalizeDisplayConfig(bad), { monitor: null, sink: null, desktop: null });
    }
    assert.deepEqual(normalizeDisplayConfig({}), { monitor: null, sink: null, desktop: null });
});

test('normalizeDisplayConfig — monitor/sink only a string, otherwise null', () => {
    assert.equal(normalizeDisplayConfig({ monitor: 'DP-3', sink: 42 }).monitor, 'DP-3');
    assert.equal(normalizeDisplayConfig({ monitor: 'DP-3', sink: 42 }).sink, null);
});

test('normalizeDisplayConfig — the TV keys are included ONLY for a non-default value', () => {
    // default: none of the keys (so writeDisplayConfig does not litter defaults)
    assert.deepEqual(
        Object.keys(normalizeDisplayConfig({ monitor: 'DP-3', tvIsStartupMonitor: false, standbyOnExit: false, cecTarget: 0 })).sort(),
        ['desktop', 'monitor', 'sink'],
    );
    // on
    const on = normalizeDisplayConfig({ tvIsStartupMonitor: true, standbyOnExit: true, cecTarget: 5 });
    assert.equal(on.tvIsStartupMonitor, true);
    assert.equal(on.standbyOnExit, true);
    assert.equal(on.cecTarget, 5);
});

test('normalizeDisplayConfig — keepOtherMonitors only as true, cecPowerOn only as false (roadmap 3.1)', () => {
    // default: none
    assert.deepEqual(
        Object.keys(normalizeDisplayConfig({ keepOtherMonitors: false, cecPowerOn: true })).sort(),
        ['desktop', 'monitor', 'sink'],
    );
    const on = normalizeDisplayConfig({ keepOtherMonitors: true, cecPowerOn: false });
    assert.equal(on.keepOtherMonitors, true);
    assert.equal(on.cecPowerOn, false);
    // wrong type -> skipped
    assert.equal('keepOtherMonitors' in normalizeDisplayConfig({ keepOtherMonitors: 'igen' }), false);
    assert.equal('cecPowerOn' in normalizeDisplayConfig({ cecPowerOn: 0 }), false);
});
test('normalizeDisplayConfig — cecTarget only an integer 1..15 (0 / >15 / fractional / string -> dropped)', () => {
    assert.equal('cecTarget' in normalizeDisplayConfig({ cecTarget: 0 }), false);
    assert.equal('cecTarget' in normalizeDisplayConfig({ cecTarget: 16 }), false);
    assert.equal('cecTarget' in normalizeDisplayConfig({ cecTarget: 5.5 }), false);
    assert.equal('cecTarget' in normalizeDisplayConfig({ cecTarget: '5' }), false);
    assert.equal(normalizeDisplayConfig({ cecTarget: 1 }).cecTarget, 1);
    assert.equal(normalizeDisplayConfig({ cecTarget: 15 }).cecTarget, 15);
});

test('activeLayoutArgs — priority from the order, a connected output outside the list is disabled', () => {
    const mons = [{ name: 'DP-1' }, { name: 'DP-3' }, { name: 'HDMI-A-1' }];
    assert.deepEqual(activeLayoutArgs(['DP-3', 'DP-1'], mons), [
        'output.DP-3.enable', 'output.DP-3.priority.1',
        'output.DP-1.enable', 'output.DP-1.priority.2',
        'output.HDMI-A-1.disable',
    ]);
});

test('activeLayoutArgs — a name that is not connected is dropped; none present -> null', () => {
    const mons = [{ name: 'DP-3' }, { name: 'HDMI-A-1' }];
    assert.deepEqual(activeLayoutArgs(['DP-2', 'DP-3'], mons),
        ['output.DP-3.enable', 'output.DP-3.priority.1', 'output.HDMI-A-1.disable']);
    assert.equal(activeLayoutArgs(['DP-2'], mons), null);
    assert.equal(activeLayoutArgs([], mons), null);
});

const { startupPlan, activeLayoutPlan } = require('../../lib/output/displays.js');

test('startupPlan — the chosen one is primary, the others off; with keepOthers nothing turns off', () => {
    const mons = [{ name: 'DP-3' }, { name: 'HDMI-A-1' }, { name: 'DP-1' }];
    assert.deepEqual(startupPlan('HDMI-A-1', mons, false), { order: ['HDMI-A-1'], disable: ['DP-3', 'DP-1'] });
    assert.deepEqual(startupPlan('HDMI-A-1', mons, true), { order: ['HDMI-A-1'], disable: [] });
});

test('activeLayoutPlan — the same as activeLayoutArgs, in a DE-independent shape', () => {
    const mons = [{ name: 'DP-1' }, { name: 'DP-3' }, { name: 'HDMI-A-1' }];
    assert.deepEqual(activeLayoutPlan(['DP-3', 'DP-9', 'DP-1'], mons), { order: ['DP-3', 'DP-1'], disable: ['HDMI-A-1'] });
    assert.equal(activeLayoutPlan(['DP-9'], mons), null);
});

// --- restoreMonitors: re-checks while the saved monitor flaps its hotplug line ---

const mon = (name) => ({ name, width: 3840, height: 2160, active: false, priority: 0, label: name });

async function restoreWith({ lists, applyFails = 0 }) {
    config.set('display', { monitor: 'DP-2', sink: null, desktop: { monitors: ['HDMI-A-1'], sink: null, disableOthers: true } });
    const applied = [];
    const lines = [];
    let calls = 0;
    let applyCalls = 0;
    await restoreMonitors((m) => lines.push(m), {
        list: async () => { const r = lists[Math.min(calls, lists.length - 1)]; calls += 1; return r; },
        apply: async (plan) => { applyCalls += 1; if (applyCalls <= applyFails) throw new Error('output gone'); applied.push(plan); },
        sleep: async () => {}, tries: 5, intervalMs: 1,
    });
    return { applied, lines, calls };
}

test('restoreMonitors — the saved monitor is connected at once → one switch, no retry', async () => {
    const r = await restoreWith({ lists: [[mon('DP-2'), mon('HDMI-A-1')]] });
    assert.deepEqual(r.applied, [{ order: ['HDMI-A-1'], disable: ['DP-2'] }]);
    assert.equal(r.calls, 1);
});

test('restoreMonitors — the saved monitor is in a hotplug gap → retries until it is back', async () => {
    const r = await restoreWith({ lists: [[mon('DP-2')], [mon('DP-2')], [mon('DP-2'), mon('HDMI-A-1')]] });
    assert.deepEqual(r.applied, [{ order: ['HDMI-A-1'], disable: ['DP-2'] }]);
    assert.equal(r.calls, 3);
    assert.match(r.lines.at(-1), /after 3 attempt/);
});

test('restoreMonitors — never comes back → logged no-op that names what IS connected', async () => {
    const r = await restoreWith({ lists: [[mon('DP-2')]] });
    assert.deepEqual(r.applied, []);
    assert.equal(r.calls, 5);
    assert.match(r.lines.at(-1), /none of the saved monitors \(HDMI-A-1\) is connected after 5 check\(s\) \(connected now: DP-2\)/);
});

test('restoreMonitors — the switch itself fails once (output dropped meanwhile) → tried again', async () => {
    const r = await restoreWith({ lists: [[mon('DP-2'), mon('HDMI-A-1')]], applyFails: 1 });
    assert.equal(r.applied.length, 1);
    assert.equal(r.calls, 2);
});
