'use strict';

// lib/ipc/output-ipc.js — body of the "Audio" + "Display" IPC handlers, with fake deps. The actual
// pactl/kscreen-doctor/cec-ctl calls are in the lib/output/* modules (their pure parts are tested
// separately) — here the response shape, the error branch and flag normalization matter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutputHandlers, registerOutputIpc } = require('../../lib/ipc/output-ipc.js');
const { fakeIpcMain } = require('../helpers/ipc.js');

const SINKS = [
    { name: 'alsa_output.hdmi', description: 'HDMI / TV' },
    { name: 'alsa_output.usb', description: 'USB headphones' },
];
const MONITORS = [{ name: 'DP-3', label: 'DP-3 — 2560×1080' }, { name: 'HDMI-A-1', label: 'HDMI-A-1 — 3840×2160' }];

function makeHandlers(over = {}) {
    const calls = { sent: [], log: [], setSink: [], writeCfg: [], applyMonitor: [], powerOnTv: 0, setVolume: [], restoreActive: [], moveWindow: [] };
    let displayCfg = { monitor: null, sink: null, ...(over.displayCfg || {}) };
    const monitors = (over.monitors || MONITORS).map((m) => ({ ...m }));
    const deps = {
        audio: {
            listAudioSinks: over.listAudioSinks || (async () => SINKS),
            setAudioSink: over.setAudioSink || (async (name) => { calls.setSink.push(name); }),
            getVolume: async () => 40,
            setVolume: async (v) => { calls.setVolume.push(v); return Math.max(0, Math.min(100, v)); },
        },
        displays: {
            // Live fake display state: apply/restore really switches `active` (the
            // post-switch check — verifyLayout — reads it back).
            listMonitors: async () => monitors.map((m) => ({ ...m })),
            restoreActiveMonitors: async (names) => {
                calls.restoreActive.push(names);
                if (over.restoreResults && over.restoreResults.length) return over.restoreResults.shift();
                monitors.forEach((m) => { m.active = names.includes(m.name); });
                return true;
            },
            readDisplayConfig: () => ({ ...displayCfg }),
            // The real writeDisplayConfig field merge + returns the saved, normalized config.
            writeDisplayConfig: over.writeDisplayConfig || ((patch) => {
                calls.writeCfg.push(patch);
                displayCfg = { ...displayCfg, ...patch };
                return { ...displayCfg };
            }),
            applyStartupMonitor: over.applyStartupMonitor || (async (name, log, opts) => {
                calls.applyMonitor.push({ name, opts });
                if (over.applyNoEffect) return; // KWin "did not accept it" — the check retries
                if (over.applyDelayMs) await new Promise((r) => setTimeout(r, over.applyDelayMs));
                monitors.forEach((m) => {
                    if (m.name === name) m.active = true;
                    else if (!opts.keepOthers) m.active = false;
                });
            }),
        },
        startupOutputs: {
            maybePowerOnTv: async () => { calls.powerOnTv += 1; calls.powerOnCfg = (calls.powerOnCfg || []).concat(displayCfg.monitor); },
        },
        revertRetryMs: 5,
        log: (m) => calls.log.push(m),
        sendToRenderer: (ch, payload) => calls.sent.push({ ch, payload }),
        confirmMs: over.confirmMs || 40,
        moveWindowToOutput: async (output) => { calls.moveWindow.push(output); return true; },
        getVolumeMax: over.getVolumeMax,
        safeList: async (label, fn) => {
            try { return { ok: true, items: await fn() }; } catch (err) { calls.log.push(`${label}: ${err.message}`); return { ok: false, items: [] }; }
        },
    };
    return { h: createOutputHandlers(deps), calls, deps };
}

test('listAudioSinks / listMonitors — through the safeList { ok, items } wrapper', async () => {
    const { h } = makeHandlers();
    assert.deepEqual(await h.listAudioSinks(), { ok: true, items: SINKS });
    assert.deepEqual(await h.listMonitors(), { ok: true, items: MONITORS });
    const failing = makeHandlers({ listAudioSinks: async () => { throw new Error('pactl timeout'); } });
    assert.deepEqual(await failing.h.listAudioSinks(), { ok: false, items: [] });
});

test('setAudioSink — switch + audio-sink-changed with the sink description', async () => {
    const { h, calls } = makeHandlers();
    await h.setAudioSink('alsa_output.usb');
    assert.deepEqual(calls.setSink, ['alsa_output.usb']);
    assert.deepEqual(calls.sent, [{
        ch: 'audio-sink-changed', payload: { success: true, name: 'alsa_output.usb', description: 'USB headphones' },
    }]);
    assert.equal(calls.writeCfg.length, 0, 'a plain switch does NOT write the startup profile');
});

test('setAudioSink — unknown sink without a description: the name is the description', async () => {
    const { h, calls } = makeHandlers();
    await h.setAudioSink('not.in.the.list');
    assert.equal(calls.sent[0].payload.description, 'not.in.the.list');
});

test('setAudioSink — error: logs + success:false, does not throw', async () => {
    const { h, calls } = makeHandlers({ setAudioSink: async () => { throw new Error('pactl failed'); } });
    await h.setAudioSink('alsa_output.usb');
    assert.deepEqual(calls.sent, [{ ch: 'audio-sink-changed', payload: { success: false, name: 'alsa_output.usb' } }]);
    assert.match(calls.log.join(), /Audio sink switch error: pactl failed/);
});

test('setStartupSink — FIRST writes into the startup profile, then switches', async () => {
    const { h, calls } = makeHandlers();
    await h.setStartupSink('alsa_output.hdmi');
    assert.deepEqual(calls.writeCfg, [{ sink: 'alsa_output.hdmi' }]);
    assert.deepEqual(calls.setSink, ['alsa_output.hdmi']);
    assert.equal(calls.sent[0].payload.success, true);
});

test('setStartupSink — failure of the profile write: no switch, success:false', async () => {
    const { h, calls } = makeHandlers({ writeDisplayConfig: () => { throw new Error('EACCES'); } });
    await h.setStartupSink('alsa_output.hdmi');
    assert.equal(calls.setSink.length, 0);
    assert.deepEqual(calls.sent, [{ ch: 'audio-sink-changed', payload: { success: false, name: 'alsa_output.hdmi' } }]);
    assert.match(calls.log.join(), /Startup audio device switch error: EACCES/);
});

test('changeVolume — adds to the current value, sends the (clamped) new value', async () => {
    const { h, calls } = makeHandlers();
    await h.changeVolume(5);
    await h.changeVolume(-100);
    assert.deepEqual(calls.setVolume, [45, 0]);
    assert.deepEqual(calls.sent.map((s) => s.payload.volume), [45, 0]);
});

test('changeVolume — the `volumeMax` ceiling limits upward, not downward (C3)', async () => {
    const { h, calls } = makeHandlers({ getVolumeMax: () => 42 });
    await h.changeVolume(5);  // 40 → 42 instead of 45
    await h.changeVolume(-5); // 40 → 35
    assert.deepEqual(calls.setVolume, [42, 35]);
});

test('setOutputBehavior — writes only the given flags, normalized to bool; the reply is the saved state', () => {
    const { h, calls } = makeHandlers();
    h.setOutputBehavior({ keepOtherMonitors: 'igen', cecPowerOn: 0 });
    assert.deepEqual(calls.writeCfg, [{ keepOtherMonitors: false, cecPowerOn: true }]);
    assert.deepEqual(calls.sent[0], {
        ch: 'output-behavior-changed',
        payload: { keepOtherMonitors: false, standbyOnExit: false, cecPowerOn: true, ok: true },
    });

    h.setOutputBehavior({ standbyOnExit: true, cecPowerOn: false });
    assert.deepEqual(calls.writeCfg[1], { standbyOnExit: true, cecPowerOn: false });
    assert.deepEqual(calls.sent[1].payload, { keepOtherMonitors: false, standbyOnExit: true, cecPowerOn: false, ok: true });
});

test('setOutputBehavior — non-object payload: empty patch, does not throw; write error -> ok:false', () => {
    const { h, calls } = makeHandlers();
    h.setOutputBehavior(null);
    assert.deepEqual(calls.writeCfg, [{}]);

    const failing = makeHandlers({ writeDisplayConfig: () => { throw new Error('EROFS'); } });
    failing.h.setOutputBehavior({ keepOtherMonitors: true });
    assert.deepEqual(failing.calls.sent, [{ ch: 'output-behavior-changed', payload: { ok: false } }]);
});

test('setStartupMonitor — writes, applies (keepOthers from the saved flag), requests TV power-on, replies with the label', async () => {
    const { h, calls } = makeHandlers({ displayCfg: { keepOtherMonitors: true } });
    await h.setStartupMonitor('HDMI-A-1');
    assert.deepEqual(calls.writeCfg, [{ monitor: 'HDMI-A-1' }]);
    assert.equal(calls.applyMonitor.length, 1);
    assert.equal(calls.applyMonitor[0].name, 'HDMI-A-1');
    assert.equal(calls.applyMonitor[0].opts.keepOthers, true);
    assert.equal(calls.powerOnTv, 1);
    assert.deepEqual(calls.sent, [{
        ch: 'monitor-config-changed', payload: { success: true, name: 'HDMI-A-1', label: 'HDMI-A-1 — 3840×2160' },
    }]);
});

test('setStartupMonitor — failure of the apply: success:false, no TV power-on', async () => {
    const { h, calls } = makeHandlers({ applyStartupMonitor: async () => { throw new Error('kscreen-doctor timeout'); } });
    await h.setStartupMonitor('DP-3');
    assert.equal(calls.powerOnTv, 0);
    assert.deepEqual(calls.sent, [{ ch: 'monitor-config-changed', payload: { success: false, name: 'DP-3' } }]);
    assert.match(calls.log.join(), /Startup monitor switch error: kscreen-doctor timeout/);
});

// --- "Keep this display?" ---

const ACTIVE_DP3 = [
    { name: 'DP-3', label: 'DP-3 — 2560×1080', active: true, priority: 1 },
    { name: 'HDMI-A-1', label: 'HDMI-A-1 — 3840×2160', active: false, priority: 0 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('setStartupMonitor — switching to an already active monitor: no confirmation', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3 });
    await h.setStartupMonitor('DP-3');
    assert.equal(calls.sent[0].payload.confirmMs, undefined);
});

test('setStartupMonitor — to an inactive monitor: confirmMs, after confirmation no revert', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3, displayCfg: { monitor: 'DP-3' } });
    await h.setStartupMonitor('HDMI-A-1');
    assert.equal(calls.sent[0].payload.confirmMs, 40);
    h.confirmStartupMonitor();
    await sleep(70);
    assert.deepEqual(calls.restoreActive, []);
    assert.deepEqual(calls.writeCfg, [{ monitor: 'HDMI-A-1' }]);
});

test('setStartupMonitor — countdown expired: previous layout + previous config.monitor', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3, displayCfg: { monitor: 'DP-3' } });
    await h.setStartupMonitor('HDMI-A-1');
    await sleep(70);
    assert.deepEqual(calls.restoreActive, [['DP-3']]);
    assert.deepEqual(calls.writeCfg, [{ monitor: 'HDMI-A-1' }, { monitor: 'DP-3' }]);
    assert.deepEqual(calls.sent.at(-1), { ch: 'monitor-config-reverted', payload: { name: 'DP-3', reason: 'timeout' } });
});

test('revertStartupMonitor — ○ reverts immediately; without a pending switch a no-op', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3, confirmMs: 5000 });
    await h.revertStartupMonitor('user');
    assert.deepEqual(calls.restoreActive, []);
    await h.setStartupMonitor('HDMI-A-1');
    await h.revertStartupMonitor('user');
    assert.deepEqual(calls.restoreActive, [['DP-3']]);
    // config.monitor was not set -> reverts to null (deletion)
    assert.deepEqual(calls.writeCfg.at(-1), { monitor: null });
    assert.equal(calls.sent.at(-1).payload.reason, 'user');
});

test('abandonPendingMonitor — on exit only restores the config, without a timer', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3, displayCfg: { monitor: 'DP-3' }, confirmMs: 5000 });
    await h.setStartupMonitor('HDMI-A-1');
    h.abandonPendingMonitor();
    assert.deepEqual(calls.writeCfg.at(-1), { monitor: 'DP-3' });
    assert.deepEqual(calls.restoreActive, []);
    h.abandonPendingMonitor(); // idempotent
    assert.equal(calls.writeCfg.length, 2);
});

// --- Queued switching + verification (in production: 7 parallel switches → several active monitors) ---

test('setStartupMonitor — quick repeated requests: no parallel kscreen call, the last one wins', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3, applyDelayMs: 20, confirmMs: 5000 });
    const first = h.setStartupMonitor('HDMI-A-1');
    h.setStartupMonitor('DP-3');
    h.setStartupMonitor('HDMI-A-1');
    h.setStartupMonitor('DP-3'); // the very last one
    await first;
    assert.deepEqual(calls.applyMonitor.map((a) => a.name), ['HDMI-A-1', 'DP-3']);
    assert.equal(calls.writeCfg.at(-1).monitor, 'DP-3');
    h.abandonPendingMonitor();
});

test('setStartupMonitor — the chosen one is already the only active + saved: no kscreen, no CEC', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3, displayCfg: { monitor: 'DP-3' } });
    await h.setStartupMonitor('DP-3');
    assert.deepEqual(calls.applyMonitor, []);
    assert.equal(calls.powerOnTv, 0);
    assert.deepEqual(calls.sent, [{ ch: 'monitor-config-changed', payload: { success: true, name: 'DP-3', label: 'DP-3 — 2560×1080' } }]);
});

test('setStartupMonitor — if the switch has no effect, retries once and logs', async () => {
    const { h, calls } = makeHandlers({ monitors: ACTIVE_DP3, applyNoEffect: true, confirmMs: 5000 });
    await h.setStartupMonitor('HDMI-A-1');
    assert.equal(calls.applyMonitor.length, 2);
    assert.match(calls.log.join('\n'), /still active after the retry: DP-3/);
    h.abandonPendingMonitor();
});

test('setStartupMonitor — with keepOtherMonitors puts the window on the chosen output, without it does not', async () => {
    const keep = makeHandlers({ monitors: ACTIVE_DP3, displayCfg: { keepOtherMonitors: true }, confirmMs: 5000 });
    await keep.h.setStartupMonitor('HDMI-A-1');
    assert.deepEqual(keep.calls.moveWindow, ['HDMI-A-1']);
    keep.h.abandonPendingMonitor();

    const exclusive = makeHandlers({ monitors: ACTIVE_DP3, confirmMs: 5000 });
    await exclusive.h.setStartupMonitor('HDMI-A-1');
    assert.deepEqual(exclusive.calls.moveWindow, []); // KWin moves it off the disabled output by itself
    exclusive.h.abandonPendingMonitor();
});

// --- Waking the TV over CEC on revert (in production: a TV switched off during "Keep?" stayed dark) ---

const TV_ACTIVE = [
    { name: 'DP-2', label: 'DP-2 — TV', active: true, priority: 1 },
    { name: 'DP-3', label: 'DP-3 — 2560×1080', active: false, priority: 0 },
];

test('revertStartupMonitor — requests a CEC wake based on the written-back config (TV)', async () => {
    const { h, calls } = makeHandlers({ monitors: TV_ACTIVE, displayCfg: { monitor: 'DP-2' }, confirmMs: 5000 });
    await h.setStartupMonitor('DP-3');
    const before = calls.powerOnTv;
    await h.revertStartupMonitor('timeout');
    assert.equal(calls.powerOnTv, before + 1);
    assert.equal(calls.powerOnCfg.at(-1), 'DP-2', 'maybePowerOnTv sees the ALREADY written-back TV config');
    assert.deepEqual(calls.restoreActive, [['DP-2']]);
    assert.deepEqual(calls.sent.at(-1).payload, { name: 'DP-2', reason: 'timeout' });
});

test('revertStartupMonitor — the TV output appears only after the wake: the second attempt succeeds', async () => {
    const { h, calls } = makeHandlers({
        monitors: TV_ACTIVE, displayCfg: { monitor: 'DP-2' }, confirmMs: 5000, restoreResults: [false, true],
    });
    await h.setStartupMonitor('DP-3');
    await h.revertStartupMonitor('timeout');
    assert.equal(calls.restoreActive.length, 2);
    assert.deepEqual(calls.sent.at(-1).payload, { name: 'DP-2', reason: 'timeout' });
    assert.equal(calls.writeCfg.at(-1).monitor, 'DP-2');
});

test('revertStartupMonitor — the previous output is permanently unavailable: the visible monitor stays (config too)', async () => {
    const { h, calls } = makeHandlers({
        monitors: TV_ACTIVE, displayCfg: { monitor: 'DP-2' }, confirmMs: 5000, restoreResults: [false, false],
    });
    await h.setStartupMonitor('DP-3');
    await h.revertStartupMonitor('timeout');
    assert.equal(calls.writeCfg.at(-1).monitor, 'DP-3');
    assert.deepEqual(calls.sent.at(-1).payload, { name: 'DP-3', reason: 'timeout', kept: true });
});

test('registerOutputIpc — the sink/monitor name and the volume delta are validated on intake', async () => {
    const { deps, calls } = makeHandlers();
    const ipcMain = fakeIpcMain();
    registerOutputIpc({ ...deps, ipcMain });
    for (const bad of [undefined, null, '', 5, {}, 'x'.repeat(301)]) {
        await ipcMain.send('set-audio-sink', bad);
        await ipcMain.send('set-startup-sink', bad);
        await ipcMain.send('set-startup-monitor', bad);
    }
    await ipcMain.send('change-volume', 'NaN');
    await ipcMain.send('change-volume', undefined);
    assert.deepEqual(calls.sent, [], 'no feedback for an invalid payload');
    assert.deepEqual(calls.setSink, []);
    assert.deepEqual(calls.setVolume, []);
});
