'use strict';

// lib/launch/window-to-output.js — building the KWin script + parsing the loadScript response.
// (The live gdbus/KWin call is not tested — like window-activate.js; verified on the machine.)

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildMoveScript, parseLoadScriptId, isKwinMissingError, shouldMoveToStartupMonitor,
} = require('../../lib/launch/window-to-output.js');

test('buildMoveScript — pid + output in the script, the name is a JSON literal', () => {
    const s = buildMoveScript(1234, 'DP-2');
    assert.match(s, /w\.pid === 1234 && w\.normalWindow/);
    assert.match(s, /s\.name === "DP-2"/);
    assert.match(s, /if \(win\.output !== target\) workspace\.sendClientToScreen\(win, target\)/);
    // it ONLY turns fullscreen back on, never off (on the machine toggling it off and on
    // caused an async race)
    assert.match(s, /if \(!win\.fullScreen\) win\.fullScreen = true;/);
    assert.doesNotMatch(s, /fullScreen = false/);
});

test('buildMoveScript — against injection: a quote in the name is escaped; invalid input throws', () => {
    const s = buildMoveScript(1, 'x"); evil(); ("');
    assert.match(s, /s\.name === "x\\"\); evil\(\); \(\\""/);
    assert.throws(() => buildMoveScript(0, 'DP-1'));
    assert.throws(() => buildMoveScript(1.5, 'DP-1'));
    assert.throws(() => buildMoveScript(5, ''));
});

test('parseLoadScriptId — gdbus tuple output', () => {
    assert.equal(parseLoadScriptId('(3,)\n'), 3);
    assert.equal(parseLoadScriptId('(0,)'), 0);
    assert.equal(parseLoadScriptId('(-1,)'), -1);
    assert.equal(parseLoadScriptId('something'), null);
});

test('shouldMoveToStartupMonitor — only if the target is active AND there is another active output beside it', () => {
    const m = (name, active) => ({ name, active });
    assert.equal(shouldMoveToStartupMonitor([m('LVDS-1', true)], 'LVDS-1'), false);          // laptop, 1 monitor
    assert.equal(shouldMoveToStartupMonitor([m('LVDS-1', true), m('HDMI-1', false)], 'LVDS-1'), false);
    assert.equal(shouldMoveToStartupMonitor([m('DP-1', true), m('HDMI-1', true)], 'HDMI-1'), true);
    assert.equal(shouldMoveToStartupMonitor([m('DP-1', true), m('HDMI-1', true)], 'DP-9'), false);
    assert.equal(shouldMoveToStartupMonitor(null, 'x'), false);
});

test('isKwinMissingError — the gdbus error of a non-KDE session (live: GNOME/X11)', () => {
    const err = Object.assign(new Error('Command failed: gdbus call ...'), {
        stderr: 'Hiba: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.kde.KWin was not provided by any .service files',
    });
    assert.equal(isKwinMissingError(err), true);
    assert.equal(isKwinMissingError(new Error('Timeout')), false);
    assert.equal(isKwinMissingError(null), false);
});

const { pickDisplayForGeometry } = require('../../lib/launch/window-to-output.js');

// `screen.getAllDisplays()` measured on the T410 (GNOME X11): the label is the monitor name, not the connector.
const T410_DISPLAYS = [
    { id: 1, label: 'Built-in display', bounds: { x: 1600, y: 0, width: 1280, height: 800 }, scaleFactor: 1 },
    { id: 2, label: 'VP201b', bounds: { x: 0, y: 0, width: 1600, height: 1200 }, scaleFactor: 1 },
];

test('pickDisplayForGeometry — a top-left corner match decides', () => {
    assert.equal(pickDisplayForGeometry(T410_DISPLAYS, { x: 0, y: 0, width: 1600, height: 1200 }).id, 2);
    assert.equal(pickDisplayForGeometry(T410_DISPLAYS, { x: 1600, y: 0, width: 1280, height: 800 }).id, 1);
});

test('pickDisplayForGeometry — scaled display (DIP × scaleFactor); center containment as a fallback; none → null', () => {
    const hidpi = [{ id: 3, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }];
    assert.equal(pickDisplayForGeometry(hidpi, { x: 0, y: 0, width: 3840, height: 2160 }).id, 3);
    assert.equal(pickDisplayForGeometry(T410_DISPLAYS, { x: 1601, y: 1, width: 1280, height: 800 }).id, 1);
    assert.equal(pickDisplayForGeometry(T410_DISPLAYS, { x: 5000, y: 0, width: 1920, height: 1080 }), null);
    assert.equal(pickDisplayForGeometry(T410_DISPLAYS, null), null);
});

// --- createLauncherMover ---
const { EventEmitter } = require('node:events');
const { createLauncherMover } = require('../../lib/launch/window-to-output.js');

const DISPLAYS = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 3840, height: 2160 }, scaleFactor: 1 },
];

function fakeWin({ onDisplay = 1, fullscreen = true } = {}) {
    const w = new EventEmitter();
    w.fs = fullscreen;
    w.bounds = DISPLAYS[onDisplay - 1].bounds;
    w.calls = [];
    w.isDestroyed = () => false;
    w.getBounds = () => w.bounds;
    w.isFullScreen = () => w.fs;
    w.setFullScreen = (v) => {
        w.calls.push(`fs:${v}`);
        const was = w.fs;
        w.fs = v;
        if (was && !v) setImmediate(() => w.emit('leave-full-screen'));
    };
    w.setBounds = (b) => { w.calls.push(`bounds:${b.x}`); w.bounds = b; };
    return w;
}

function mover({ desktop = 'gnome', platform = 'x11', win = fakeWin(), geom = { x: 1920, y: 0, width: 3840, height: 2160 }, monitors = [] } = {}) {
    const logs = [];
    const kwin = [];
    const m = createLauncherMover({
        desktop, platform, getWindow: () => win, log: (l) => logs.push(l),
        screen: {
            getAllDisplays: () => DISPLAYS,
            getDisplayMatching: (b) => DISPLAYS.find((d) => d.bounds.x === b.x),
        },
        displays: {
            outputGeometry: async () => geom,
            readDisplayConfig: () => ({ monitor: 'HDMI-A-1' }),
            listMonitors: async () => monitors,
        },
        kwinMove: async (output) => { kwin.push(output); return true; },
    });
    return { m, logs, kwin, win };
}

test('createLauncherMover — KDE: the KWin script moves', async () => {
    const { m, kwin } = mover({ desktop: 'kde', platform: 'wayland' });
    assert.equal(await m.moveTo('DP-1'), true);
    assert.deepEqual(kwin, ['DP-1']);
});

test('createLauncherMover — GNOME Wayland: skipped, logged once', async () => {
    const { m, logs, kwin } = mover({ platform: 'wayland' });
    assert.equal(await m.moveTo('DP-1'), false);
    assert.equal(await m.moveTo('DP-1'), false);
    assert.equal(logs.length, 1);
    assert.deepEqual(kwin, []);
});

test('createLauncherMover — GNOME X11: fullscreen off → setBounds → fullscreen on; already there → only fullscreen', async () => {
    const moving = mover();
    assert.equal(await moving.m.moveTo('HDMI-A-1'), true);
    assert.deepEqual(moving.win.calls, ['fs:false', 'bounds:1920', 'fs:true']);

    const there = mover({ win: fakeWin({ onDisplay: 2, fullscreen: false }) });
    assert.equal(await there.m.moveTo('HDMI-A-1'), true);
    assert.deepEqual(there.win.calls, ['fs:true']);

    const inactive = mover({ geom: null });
    assert.equal(await inactive.m.moveTo('HDMI-A-1'), false);
});

test('createLauncherMover — at startup moves only with more than one active output', async () => {
    const single = mover({ monitors: [{ name: 'HDMI-A-1', active: true }] });
    assert.equal(await single.m.moveToStartupMonitor(), false);
    assert.deepEqual(single.win.calls, []);
    const multi = mover({ monitors: [{ name: 'HDMI-A-1', active: true }, { name: 'eDP-1', active: true }] });
    assert.equal(await multi.m.moveToStartupMonitor(), true);
});
