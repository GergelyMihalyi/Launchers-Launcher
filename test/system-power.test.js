'use strict';

// lib/system-power.js — the system-action whitelist + the sleep timer's state machine.
// The actual `systemctl` call is NOT tested (like the repo's other libs calling real system
// binaries, e.g. lib/output/cec.js / lib/bluetooth/bluetooth.js — GUI/Electron logic is not
// tested, see docs/dev/testing.md), only the state machine: the guard of an unknown `system-action` +
// the synchronous arm/clear state transitions of the sleep timer. Every `armSleepTimer`/
// `setSleepTimer` call is closed IMMEDIATELY with `clearSleepTimer()`, so no live
// `setTimeout` stays in the test runner's event loop (30-90 minute real timers).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemPower, SYSTEM_ACTIONS, SLEEP_TIMER_OPTIONS } = require('../lib/system-power.js');

function fakeDeps() {
    const logs = [];
    const sent = [];
    return {
        logs,
        sent,
        log: (msg) => logs.push(msg),
        sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    };
}

test('SYSTEM_ACTIONS / SLEEP_TIMER_OPTIONS — the whitelist is exported', () => {
    assert.deepEqual(SYSTEM_ACTIONS, { poweroff: 'poweroff', reboot: 'reboot', suspend: 'suspend' });
    assert.deepEqual(SLEEP_TIMER_OPTIONS, [0, 30, 60, 90]);
});

test('dispatchSystemAction — unknown action: logs, but calls nothing, does not throw', () => {
    const deps = fakeDeps();
    const power = createSystemPower(deps);
    assert.doesNotThrow(() => power.dispatchSystemAction('bogus'));
    assert.equal(deps.sent.length, 0);
    assert.ok(deps.logs.some((l) => l.includes('unknown action')));
});

test('getSleepTimerState — initially off', () => {
    const power = createSystemPower(fakeDeps());
    assert.deepEqual(power.getSleepTimerState(), { minutes: 0, endsAt: null });
});

test('armSleepTimer(0) — no-op, stays off', () => {
    const power = createSystemPower(fakeDeps());
    power.armSleepTimer(0);
    assert.deepEqual(power.getSleepTimerState(), { minutes: 0, endsAt: null });
});

test('armSleepTimer(30) — sets minutes/endsAt immediately (about now + 30 minutes), then clearSleepTimer resets it', () => {
    const power = createSystemPower(fakeDeps());
    const before = Date.now();
    power.armSleepTimer(30);
    const state = power.getSleepTimerState();
    assert.equal(state.minutes, 30);
    assert.ok(state.endsAt >= before + 30 * 60000 && state.endsAt <= Date.now() + 30 * 60000 + 1000);
    power.clearSleepTimer();
    assert.deepEqual(power.getSleepTimerState(), { minutes: 0, endsAt: null });
});

test('armSleepTimer — a repeated call replaces the previous one (does not accumulate), then clear', () => {
    const power = createSystemPower(fakeDeps());
    power.armSleepTimer(30);
    power.armSleepTimer(60);
    assert.equal(power.getSleepTimerState().minutes, 60);
    power.clearSleepTimer();
});

test('setSleepTimer — accepts only the whitelisted minute values, everything else as 0 (off)', () => {
    const power = createSystemPower(fakeDeps());
    assert.deepEqual(power.setSleepTimer(999), { minutes: 0, endsAt: null });
    const state = power.setSleepTimer(90);
    assert.equal(state.minutes, 90);
    power.clearSleepTimer();
});
