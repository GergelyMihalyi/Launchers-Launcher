// @ts-check
'use strict';

// Startup output application (TV CEC power-on + the monitor/audio "startup" profile) — called from `app.whenReady()` AND the
// `set-startup-monitor` handler. The dependencies (cec/displays/audio) are Electron-free lib modules required directly — no DI
// factory needed, only `log` is a parameter (optional, silent for a missing/non-function `log`). No `BrowserWindow` reference.

const cec = require('./cec.js');
const displays = require('./displays.js');
const audio = require('./audio.js');
const { withTimeout, toLogger } = require('../exec.js');
const { CEC_POWER_ON_TIMEOUT_MS, STARTUP_STEP_TIMEOUT_MS } = require('../timings.js');

// TV power-on over CEC — ONLY if the startup monitor (`display.monitor`) is the connector the CEC adapter (the TV) is on. So in
// desktop mode (startup monitor = the ultrawide) the TV does not blare up needlessly. Best effort, fire-and-forget — the TV's connector
// stays `connected` even with the TV off, so no need to wait for HDMI. Called at startup (`app.whenReady`, as early as possible) AND
// on a manual change of the startup monitor (`set-startup-monitor` handler — if the user picks the TV as the active monitor, it wakes
// up just like at boot).
async function maybePowerOnTv(log) {
    const emit = toLogger(log);
    try {
        if (!await cec.cecAvailable()) {
            emit('TV power-on skipped (no CEC on this machine)');
            return;
        }
        const cfg = displays.readDisplayConfig();
        if (cfg.cecPowerOn === false) {
            emit('TV power-on skipped (display.cecPowerOn = false)');
            return;
        }
        // An explicit "the TV is my startup monitor" overrides the connector-match detection (AVR passthrough / TV already on).
        if (cfg.tvIsStartupMonitor === true) {
            emit('TV power-on over CEC (display.tvIsStartupMonitor)');
            await withTimeout(cec.powerOnTv(cfg.cecTarget), CEC_POWER_ON_TIMEOUT_MS, 'cec-power-on');
            return;
        }
        const { monitor } = cfg;
        if (!monitor) return;
        const cecConn = await cec.cecAdapterConnector();
        if (!cecConn || cecConn !== monitor) {
            emit(`TV power-on skipped (startup monitor: ${monitor || '(none)'}, CEC adapter: ${cecConn || '(none)'})`);
            return;
        }
        emit(`TV power-on over CEC (startup monitor = CEC adapter: ${cecConn})`);
        await withTimeout(cec.powerOnTv(cfg.cecTarget), CEC_POWER_ON_TIMEOUT_MS, 'cec-power-on');
    } catch (err) {
        emit(`TV power-on (CEC) error: ${err.message}`);
    }
}

// At startup (app.whenReady) applies the saved "startup" (TV) profile best effort, after recording the current desktop state (`desktop`
// profile, unless `pinned`). The monitor list (`kscreen-doctor -j`) is queried ONCE and both steps get it — the snapshot runs BEFORE the
// switch to the TV, so it would see the same state (~100–200 ms on the startup path). If the query fails (`null`), both retry themselves.
async function applyStartupOutputs(log) {
    const emit = toLogger(log);
    const monitors = await displays.listMonitors().catch(() => null);
    await displays.captureDesktopSnapshot(emit, { monitors });
    const cfg = displays.readDisplayConfig();
    if (!cfg.monitor && !cfg.sink) return;
    const tasks = [];
    let sinkPending = false;
    if (cfg.monitor) {
        tasks.push(withTimeout(
            displays.applyStartupMonitor(cfg.monitor, emit, { keepOthers: cfg.keepOtherMonitors === true, monitors }),
            STARTUP_STEP_TIMEOUT_MS, 'startup-monitor',
        ));
    }
    if (cfg.sink) {
        tasks.push(withTimeout(audio.applyStartupSink(cfg.sink, emit), STARTUP_STEP_TIMEOUT_MS, 'startup-sink')
            .then((applied) => { sinkPending = !applied; }));
    }
    const results = await Promise.allSettled(tasks);
    results.forEach((r) => {
        if (r.status === 'rejected') {
            emit(`Startup output error: ${r.reason}`);
        }
    });
    // The TV's HDMI sink is missing while the TV is still waking up (CEC): wait for it in the BACKGROUND — the window
    // (the caller awaits only this function) must not be held back.
    if (sinkPending) audio.waitForStartupSink(cfg.sink, emit).catch(() => {});
}

module.exports = { maybePowerOnTv, applyStartupOutputs };
