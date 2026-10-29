'use strict';

// lib/output/displays-gnome.js — the Mutter `DisplayConfig` state parser and the config builder
// (pure functions). The fixtures follow the shape of `busctl --user --json=short call … GetCurrentState`
// observed on the machine (GNOME Shell 48.7: the T410's X11 session + a headless
// `gnome-shell --virtual-monitor` with two virtual monitors). The real D-Bus call was
// measured there, it is not called here.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseMutterState, mutterMonitorList, buildMutterConfig, applyConfigArgs,
} = require('../../lib/output/displays-gnome.js');

const b = (v) => ({ type: 'b', data: v });

// A mode: [id, w, h, refresh, preferred_scale, supported_scales, props].
function mode(w, h, { current = false, preferred = false, scales = [1, 1.25, 1.5, 2], pref = 1 } = {}) {
    const props = {};
    if (current) props['is-current'] = b(true);
    if (preferred) props['is-preferred'] = b(true);
    return [`${w}x${h}@60.000`, w, h, 60, pref, scales, props];
}
function monitor(connector, modes, name = 'Display') {
    return [[connector, 'VND', 'PRD', '0x00'], modes, { 'is-builtin': b(false), 'display-name': { type: 's', data: name } }];
}
function logical(x, y, scale, primary, connectors, transform = 0) {
    return [x, y, scale, transform, primary, connectors.map((c) => [c, 'VND', 'PRD', '0x00']), {}];
}
function state(monitors, logicals, props = { 'layout-mode': { type: 'u', data: 1 }, 'supports-changing-layout-mode': b(true) }) {
    return parseMutterState({ type: 'ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv}', data: [7, monitors, logicals, props] });
}

// Desktop (DP-1, 2560×1440) + TV (HDMI-A-1, 4K, 2× scale available); both active at startup.
const DESK = monitor('DP-1', [mode(2560, 1440, { current: true, preferred: true })], 'Dell');
const TV = monitor('HDMI-A-1', [mode(3840, 2160, { current: true, preferred: true, pref: 2 }), mode(1920, 1080)], 'LG TV');
const TV_OFF = monitor('HDMI-A-1', [mode(3840, 2160, { preferred: true, pref: 2 }), mode(1920, 1080)], 'LG TV');

test('parseMutterState — the JSON fields of busctl', () => {
    const s = state([DESK, TV], [logical(0, 0, 1, true, ['DP-1']), logical(2560, 0, 2, false, ['HDMI-A-1'])]);
    assert.equal(s.serial, 7);
    assert.equal(s.layoutMode, 1);
    assert.equal(s.supportsChangingLayoutMode, true);
    assert.equal(s.globalScaleRequired, false);
    assert.equal(s.monitors[1].displayName, 'LG TV');
    assert.deepEqual(s.monitors[1].modes[0], {
        id: '3840x2160@60.000', width: 3840, height: 2160, refresh: 60, preferredScale: 2,
        scales: [1, 1.25, 1.5, 2], current: true, preferred: true,
    });
    assert.deepEqual(s.logical[1], { x: 2560, y: 0, scale: 2, transform: 0, primary: false, connectors: ['HDMI-A-1'] });
});

test('parseMutterState — throws on a bad response', () => {
    assert.throws(() => parseMutterState({}), /GetCurrentState/);
    assert.throws(() => parseMutterState({ data: [1, []] }), /GetCurrentState/);
});

test('mutterMonitorList — the kscreen-style Monitor shape: primary = priority 1, disabled = 0', () => {
    const s = state([DESK, TV_OFF], [logical(0, 0, 1, true, ['DP-1'])]);
    assert.deepEqual(mutterMonitorList(s), [
        { name: 'DP-1', width: 2560, height: 1440, active: true, priority: 1, label: 'DP-1 — 2560×1440' },
        // the disabled one has no is-current mode → its preferred size shows
        { name: 'HDMI-A-1', width: 3840, height: 2160, active: false, priority: 0, label: 'HDMI-A-1 — 3840×2160' },
    ]);
    const both = state([DESK, TV], [logical(0, 0, 1, false, ['DP-1']), logical(2560, 0, 2, true, ['HDMI-A-1'])]);
    assert.deepEqual(mutterMonitorList(both).map((m) => [m.name, m.priority]), [['DP-1', 2], ['HDMI-A-1', 1]]);
});

test('buildMutterConfig — TV mode: only the TV, the others off; the TV keeps its own scale, goes to (0,0)', () => {
    const s = state([DESK, TV], [logical(0, 0, 1, true, ['DP-1']), logical(2560, 0, 2, false, ['HDMI-A-1'])]);
    assert.deepEqual(buildMutterConfig(s, { order: ['HDMI-A-1'], disable: ['DP-1'] }), [
        { x: 0, y: 0, scale: 2, transform: 0, primary: true, monitors: [{ connector: 'HDMI-A-1', modeId: '3840x2160@60.000' }] },
    ]);
});

test('buildMutterConfig — turning on a disabled TV: the preferred mode + preferred scale', () => {
    const s = state([DESK, TV_OFF], [logical(0, 0, 1, true, ['DP-1'])]);
    assert.deepEqual(buildMutterConfig(s, { order: ['HDMI-A-1'], disable: ['DP-1'] }), [
        { x: 0, y: 0, scale: 2, transform: 0, primary: true, monitors: [{ connector: 'HDMI-A-1', modeId: '3840x2160@60.000' }] },
    ]);
});

test('buildMutterConfig — keepOthers: the existing layout stays, the new one goes to the right edge (logical size = mode / scale)', () => {
    const s = state([DESK, TV_OFF], [logical(0, 0, 1.25, true, ['DP-1'])]);
    assert.deepEqual(buildMutterConfig(s, { order: ['HDMI-A-1'], disable: [] }), [
        { x: 2048, y: 0, scale: 2, transform: 0, primary: true, monitors: [{ connector: 'HDMI-A-1', modeId: '3840x2160@60.000' }] },
        { x: 0, y: 0, scale: 1.25, transform: 0, primary: false, monitors: [{ connector: 'DP-1', modeId: '2560x1440@60.000' }] },
    ]);
});

test('buildMutterConfig — both active, only the primary changes: the positions do not change', () => {
    const s = state([DESK, TV], [logical(1920, 0, 1, true, ['DP-1']), logical(0, 0, 2, false, ['HDMI-A-1'])]);
    const cfg = buildMutterConfig(s, { order: ['HDMI-A-1'], disable: [] });
    assert.deepEqual(cfg.map((l) => [l.monitors[0].connector, l.x, l.y, l.primary]), [['HDMI-A-1', 0, 0, true], ['DP-1', 1920, 0, false]]);
});

test('buildMutterConfig — restoring the desktop: the order = left to right, the TV off', () => {
    const DP2 = monitor('DP-2', [mode(1920, 1080, { current: true, preferred: true })]);
    const s = state([DESK, DP2, TV], [logical(0, 0, 2, true, ['HDMI-A-1'])]);
    // DESK and DP2 are not active → no is-current → their preferred mode
    const cfg = buildMutterConfig(s, { order: ['DP-2', 'DP-1'], disable: ['HDMI-A-1'] });
    assert.deepEqual(cfg.map((l) => [l.monitors[0].connector, l.x, l.y, l.scale, l.primary]), [
        ['DP-2', 0, 0, 1, true], ['DP-1', 1920, 0, 1, false],
    ]);
});

test('buildMutterConfig — when switching off, the remaining ones close up into a row (no gap, no offset)', () => {
    const DP2 = monitor('DP-2', [mode(1920, 1080, { current: true })]);
    const s = state([DESK, TV, DP2], [
        logical(0, 0, 1, true, ['DP-1']), logical(2560, 0, 1, false, ['HDMI-A-1']), logical(6400, 0, 1, false, ['DP-2']),
    ]);
    const cfg = buildMutterConfig(s, { order: ['DP-1'], disable: ['HDMI-A-1'] });
    assert.deepEqual(cfg.map((l) => [l.monitors[0].connector, l.x, l.y]), [['DP-1', 0, 0], ['DP-2', 2560, 0]]);
});

test('buildMutterConfig — physical layout mode (X11): the size is the mode size, common scale', () => {
    const s = state([DESK, TV_OFF], [logical(0, 0, 1, true, ['DP-1'])], {
        'layout-mode': { type: 'u', data: 2 }, 'global-scale-required': b(true),
    });
    const cfg = buildMutterConfig(s, { order: ['HDMI-A-1'], disable: [] });
    assert.deepEqual(cfg.map((l) => [l.monitors[0].connector, l.x, l.scale]), [['HDMI-A-1', 2560, 1], ['DP-1', 0, 1]]);
});

test('buildMutterConfig — rotated monitor: the width is the height of the mode', () => {
    const s = state([DESK, TV_OFF], [logical(0, 0, 1, true, ['DP-1'], 1)]);
    const cfg = buildMutterConfig(s, { order: ['HDMI-A-1'], disable: [] });
    assert.equal(cfg[0].x, 1440);
    assert.equal(cfg[1].transform, 1);
});

test('buildMutterConfig — nonexistent / unconnected connector → null (we do not black out everything)', () => {
    const s = state([DESK], [logical(0, 0, 1, true, ['DP-1'])]);
    assert.equal(buildMutterConfig(s, { order: ['HDMI-A-9'], disable: ['DP-1'] }), null);
});

test('applyConfigArgs — the busctl syntax (shape verified on the machine); TEMPORARY (1) by default — for the persistent one GNOME Shell shows a confirmation window', () => {
    const s = state([DESK, TV], [logical(0, 0, 1, true, ['DP-1']), logical(2560, 0, 2, false, ['HDMI-A-1'])]);
    const cfg = buildMutterConfig(s, { order: ['DP-1', 'HDMI-A-1'], disable: [] });
    assert.deepEqual(applyConfigArgs(s, cfg), [
        'uua(iiduba(ssa{sv}))a{sv}', '7', '1', '2',
        '0', '0', '1', '0', 'true', '1', 'DP-1', '2560x1440@60.000', '0',
        '2560', '0', '2', '0', 'false', '1', 'HDMI-A-1', '3840x2160@60.000', '0',
        '1', 'layout-mode', 'u', '1',
    ]);
    // X11: the layout mode cannot be switched → empty properties; method 0 = verify only
    const x11 = state([DESK], [logical(0, 0, 1, true, ['DP-1'])], { 'layout-mode': { type: 'u', data: 2 } });
    const args = applyConfigArgs(x11, buildMutterConfig(x11, { order: ['DP-1'], disable: [] }), 0);
    assert.equal(args[2], '0');
    assert.equal(args[args.length - 1], '0');
});

const { outputGeometryFromState } = require('../../lib/output/displays-gnome.js');

test('outputGeometryFromState — X11 (physical mode): the layout measured on the T410 = the Electron bounds', () => {
    const LVDS = monitor('LVDS-1', [mode(1280, 800, { current: true, preferred: true, scales: [1] })]);
    const VGA = monitor('VGA-1', [mode(1600, 1200, { current: true, preferred: true, scales: [1] })]);
    const s = state([LVDS, VGA], [logical(1600, 0, 1, true, ['LVDS-1']), logical(0, 0, 1, false, ['VGA-1'])],
        { 'layout-mode': { type: 'u', data: 2 }, 'global-scale-required': b(true) });
    assert.deepEqual(outputGeometryFromState(s, 'LVDS-1'), { x: 1600, y: 0, width: 1280, height: 800 });
    assert.deepEqual(outputGeometryFromState(s, 'VGA-1'), { x: 0, y: 0, width: 1600, height: 1200 });
});

test('outputGeometryFromState — logical mode: size/scale; not active → null', () => {
    const s = state([DESK, TV_OFF], [logical(0, 0, 1.25, true, ['DP-1'])]);
    assert.deepEqual(outputGeometryFromState(s, 'DP-1'), { x: 0, y: 0, width: 2048, height: 1152 });
    assert.equal(outputGeometryFromState(s, 'HDMI-A-1'), null);
    assert.equal(outputGeometryFromState(s, 'NONE'), null);
});
