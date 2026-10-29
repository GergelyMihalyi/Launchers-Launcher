'use strict';

// lib/launch/foreground-guard.js — the foreground guard's state machine.
// Fake window + `windowActivate` mock, modeled on the `lib/launch/launch-controller.js`
// test. `schedule()` gets a short `delayMs` to keep the test fast.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createForegroundGuard } = require('../../lib/launch/foreground-guard.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeWindow(over = {}) {
    return {
        destroyed: false,
        visible: true,
        focused: false,
        calls: [],
        isDestroyed() { return this.destroyed; },
        isVisible() { return this.visible; },
        isFocused() { return this.focused; },
        moveTop() { this.calls.push('moveTop'); },
        focus() { this.calls.push('focus'); },
        ...over,
    };
}

function makeGuard(over = {}) {
    const logs = [];
    const activateCalls = [];
    const win = 'window' in over ? over.window : fakeWindow();
    const deps = {
        getWindow: () => win,
        getAlwaysOnTop: over.getAlwaysOnTop || (() => true),
        isLaunchSequenceActive: over.isLaunchSequenceActive || (() => false),
        windowActivate: {
            activateWindow: (query) => {
                activateCalls.push(query);
                return over.activateWindowResult ? over.activateWindowResult() : Promise.resolve();
            },
        },
        log: (msg) => logs.push(msg),
        delayMs: over.delayMs ?? 20,
    };
    return { guard: createForegroundGuard(deps), win, logs, activateCalls };
}

test('guard() — no window: no-op', () => {
    const { guard, logs } = makeGuard({ window: null });
    assert.doesNotThrow(() => guard.guard());
    assert.equal(logs.length, 0);
});

test('guard() — the window is destroyed: no-op', () => {
    const { guard, logs } = makeGuard({ window: fakeWindow({ destroyed: true }) });
    guard.guard();
    assert.equal(logs.length, 0);
});

test('guard() — alwaysOnTop turned off: no-op', () => {
    const { guard, win, logs } = makeGuard({ getAlwaysOnTop: () => false });
    guard.guard();
    assert.deepEqual(win.calls, []);
    assert.equal(logs.length, 0);
});

test('guard() — launchSequenceActive: no-op (the screen belongs to the game)', () => {
    const { guard, win } = makeGuard({ isLaunchSequenceActive: () => true });
    guard.guard();
    assert.deepEqual(win.calls, []);
});

test('guard() — the window is hidden (game running): no-op', () => {
    const { guard, win } = makeGuard({ window: fakeWindow({ visible: false }) });
    guard.guard();
    assert.deepEqual(win.calls, []);
});

test('guard() — the window is already focused: no-op', () => {
    const { guard, win } = makeGuard({ window: fakeWindow({ focused: true }) });
    guard.guard();
    assert.deepEqual(win.calls, []);
});

test('guard() — every condition met: moveTop+focus+activateWindow(\'Launchers Launcher\') + logs', async () => {
    const { guard, win, logs, activateCalls } = makeGuard();
    guard.guard();
    assert.deepEqual(win.calls, ['moveTop', 'focus']);
    assert.deepEqual(activateCalls, ['Launchers Launcher']);
    assert.ok(logs.some((l) => l.includes('taking it back')));
    await delay(5); // the activateWindow promise resolves in a microtask round
});

test('guard() — a throw of moveTop/focus does not propagate, logged', () => {
    const win = fakeWindow();
    win.moveTop = () => { throw new Error('moveTop error'); };
    const { guard, logs } = makeGuard({ window: win });
    assert.doesNotThrow(() => guard.guard());
    assert.ok(logs.some((l) => l.includes('moveTop error')));
});

test('guard() — the rejection of activateWindow is logged, does not throw (async)', async () => {
    const { guard, logs } = makeGuard({ activateWindowResult: () => Promise.reject(new Error('dbus error')) });
    guard.guard();
    await delay(10);
    assert.ok(logs.some((l) => l.includes('dbus error')));
});

test('schedule() — debounce: several quick calls run the guard only once', async () => {
    const { guard, win } = makeGuard({ delayMs: 15 });
    guard.schedule();
    guard.schedule();
    guard.schedule();
    await delay(40);
    assert.deepEqual(win.calls, ['moveTop', 'focus']);
});

test('cancel() — cancels a schedule that has not run yet', async () => {
    const { guard, win } = makeGuard({ delayMs: 15 });
    guard.schedule();
    guard.cancel();
    await delay(40);
    assert.deepEqual(win.calls, []);
});
