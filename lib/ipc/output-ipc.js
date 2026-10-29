// @ts-check
'use strict';

// Bodies of the "Audio" + "Display" (monitor) IPC handlers; the module does not know Electron. The TV CEC power-on + applying
// the startup profile live in `lib/output/startup-outputs.js`; the `set-startup-monitor` handler calls it too (fire-and-forget).

// "Keep this display?": if the chosen monitor was not active BEFORE the switch, the picture may go dark with no way back
// by controller. So the switch stays pending for `MONITOR_CONFIRM_MS` (✕ = `confirm-startup-monitor`, ○ = `revert-startup-monitor`);
// without confirmation the previous layout + `display.monitor` are restored. The timer runs on the MAIN side (the renderer may be dark).
// Background: docs/dev/renderer/settings.md#notable-sub-views
const { MONITOR_CONFIRM_MS, MONITOR_REVERT_RETRY_MS: REVERT_RETRY_MS } = require('../timings.js');
const { stepVolume } = require('../parse.js');
const { requireDeps } = require('./require-deps.js');
const { str } = require('../validate.js');

/**
 * @param {Object} deps
 * @param {Object} deps.audio
 * @param {Object} deps.displays
 * @param {Object} deps.startupOutputs
 * @param {(msg: string) => void} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {(label: string, fn: () => Promise<any>) => Promise<{ok: boolean, items: any[]}>} deps.safeList
 * @param {number} [deps.confirmMs] length of the "Keep?" window (overridable for tests)
 * @param {number} [deps.revertRetryMs] wait before the 2nd restore attempt (the output of a TV just woken
 *   over CEC may appear within this; overridable for tests)
 * @param {(output: string) => Promise<boolean>} [deps.moveWindowToOutput] moves the launcher window
 *   (lib/launch/window-to-output.js) — needed with `keepOtherMonitors`, because the old output stays on
 *   and KWin does not move the window by itself.
 * @param {() => number} [deps.getVolumeMax] cap of the L1/R1 volume in % (`volumeMax` pref;
 *   missing → 100 (no cap))
 */
function createOutputHandlers(deps) {
    const {
        audio, displays, startupOutputs, log, sendToRenderer, safeList, confirmMs = MONITOR_CONFIRM_MS,
        moveWindowToOutput = null, revertRetryMs = REVERT_RETRY_MS, getVolumeMax = null,
    } = deps;
    requireDeps(deps, ['audio', 'displays', 'startupOutputs', 'log', 'sendToRenderer', 'safeList'], 'createOutputHandlers');
    /** @type {{ timer: any, prevActive: string[], prevMonitor: string|null, name: string } | null} */
    let pendingMonitor = null;
    // --- Audio ---
    function listAudioSinks() {
        return safeList('Audio sink list error', audio.listAudioSinks);
    }

    // Switching the sink (+ an optional preceding step, e.g. writing the startup profile) and the
    // `audio-sink-changed` notification with the fresh description — the shared core of `setAudioSink` and
    // `setStartupSink`.
    async function switchSinkAndNotify(sinkName, errLabel, before = () => {}) {
        try {
            before();
            await audio.setAudioSink(sinkName);
            const sinks = await audio.listAudioSinks();
            const chosen = sinks.find((s) => s.name === sinkName);
            sendToRenderer('audio-sink-changed', {
                success: true, name: sinkName, description: chosen ? chosen.description : sinkName,
            });
        } catch (err) {
            log(`${errLabel}: ${err.message}`);
            sendToRenderer('audio-sink-changed', { success: false, name: sinkName });
        }
    }

    function setAudioSink(sinkName) {
        return switchSinkAndNotify(sinkName, 'Audio sink switch error');
    }

    function setStartupSink(sinkName) {
        return switchSinkAndNotify(sinkName, 'Startup audio device switch error',
            () => displays.writeDisplayConfig({ sink: sinkName }));
    }

    async function changeVolume(delta) {
        try {
            const current = await audio.getVolume();
            const next = await audio.setVolume(stepVolume(current, delta, getVolumeMax ? getVolumeMax() : 100));
            sendToRenderer('volume-changed', { volume: next });
        } catch (err) {
            log(`Volume change error: ${err.message}`);
        }
    }

    // --- Display (monitor) ---
    function listMonitors() {
        return safeList('Monitor list error', displays.listMonitors);
    }

    function getDisplayConfig() {
        return displays.readDisplayConfig();
    }

    // "Output behavior" subview: the 3 flags of the `display` config. `keepOtherMonitors` takes effect on the next
    // start / output choice, `standbyOnExit`/`cecPowerOn` on TV-mode exit / at boot.
    function setOutputBehavior(patch) {
        try {
            const p = patch && typeof patch === 'object' ? patch : {};
            const next = displays.writeDisplayConfig({
                ...('keepOtherMonitors' in p ? { keepOtherMonitors: p.keepOtherMonitors === true } : {}),
                ...('standbyOnExit' in p ? { standbyOnExit: p.standbyOnExit === true } : {}),
                ...('cecPowerOn' in p ? { cecPowerOn: p.cecPowerOn !== false } : {}),
            });
            sendToRenderer('output-behavior-changed', {
                keepOtherMonitors: next.keepOtherMonitors === true,
                standbyOnExit: next.standbyOnExit === true,
                cecPowerOn: next.cecPowerOn !== false,
                ok: true,
            });
        } catch (err) {
            log(`Output behavior save error: ${err.message}`);
            sendToRenderer('output-behavior-changed', { ok: false });
        }
    }

    // Only ONE monitor switch runs at a time: `kscreen-doctor` + the TV's mode change take seconds, and meanwhile the
    // user presses ✕ again — in production 7 parallel switches ran within 1.5 s, and after the racing kscreen calls
    // several monitors stayed active. Of the requests arriving while one runs, only the LATEST is kept and runs after
    // the current one. The restore (`revertStartupMonitor`) waits for the running one too.
    let switchRun = null; // Promise of the switch in progress
    let queuedMonitor = null;

    function setStartupMonitor(name) {
        if (switchRun) {
            queuedMonitor = name;
            log(`Startup monitor: switch in progress — ${name} queued`);
            return switchRun;
        }
        switchRun = (async () => {
            try {
                let next = name;
                while (next) {
                    queuedMonitor = null;
                    await switchMonitor(next);
                    next = queuedMonitor;
                }
            } finally {
                switchRun = null;
            }
        })();
        return switchRun;
    }

    // Names of the active monitors in priority order.
    const activeNames = (monitors) => monitors.filter((m) => m.active)
        .sort((a, b) => (a.priority || 99) - (b.priority || 99)).map((m) => m.name);

    async function switchMonitor(name) {
        try {
            const before = await displays.listMonitors();
            const cfgBefore = displays.readDisplayConfig();
            const keepOthers = cfgBefore.keepOtherMonitors === true;
            const chosen = before.find((m) => m.name === name);
            const label = chosen ? chosen.label : name;
            const activeBefore = activeNames(before);
            // Already exactly this situation (saved + the only/active monitor) → no kscreen call, no CEC spam,
            // no "Keep?" — just acknowledge.
            const alreadyThere = cfgBefore.monitor === name && activeBefore.includes(name)
                && (keepOthers || activeBefore.length === 1);
            if (alreadyThere && !pendingMonitor) {
                sendToRenderer('monitor-config-changed', { success: true, name, label });
                return;
            }
            // The provably visible state BEFORE the switch — during an already pending switch the very first
            // (pre-unconfirmed-switch) state stays the restore target.
            const prev = pendingMonitor
                ? { prevActive: pendingMonitor.prevActive, prevMonitor: pendingMonitor.prevMonitor }
                : { prevActive: activeBefore, prevMonitor: cfgBefore.monitor };
            clearPending();
            const wasActive = activeBefore.includes(name);

            displays.writeDisplayConfig({ monitor: name });
            await displays.applyStartupMonitor(name, log, { keepOthers, monitors: before });
            await verifyLayout(name, keepOthers);
            // The other outputs stayed on → the window does not move by itself ("the TV turned on, but the
            // launcher stayed on the original monitor").
            if (keepOthers && moveWindowToOutput) await moveWindowToOutput(name);
            // If the monitor just chosen is the TV (the CEC adapter's connector), turn it on too — guarded by
            // itself, fire-and-forget (cec-ctl may take 8 s, do not wait for it).
            startupOutputs.maybePowerOnTv(log);
            const needsConfirm = !wasActive && prev.prevActive.length > 0;
            if (needsConfirm) {
                const timer = setTimeout(() => { revertStartupMonitor('timeout'); }, confirmMs);
                if (timer && typeof timer.unref === 'function') timer.unref();
                pendingMonitor = { timer, name, ...prev };
            }
            sendToRenderer('monitor-config-changed', {
                success: true, name, label,
                ...(needsConfirm ? { confirmMs } : {}),
            });
        } catch (err) {
            log(`Startup monitor switch error: ${err.message}`);
            sendToRenderer('monitor-config-changed', { success: false, name });
        }
    }

    // After kscreen-doctor returns KWin may still adjust — check that the chosen monitor really is active (and
    // without `keepOthers` ONLY that one); if not, apply it once more. The result is logged (traceable on the
    // machine if it still drifts).
    async function verifyLayout(name, keepOthers) {
        const ok = (mons) => {
            const act = activeNames(mons);
            return act.includes(name) && (keepOthers || act.length === 1);
        };
        let after = await displays.listMonitors();
        if (ok(after)) return;
        log(`Startup monitor: active after the switch: ${activeNames(after).join(', ') || '—'} (expected: ${name}) — retrying`);
        await displays.applyStartupMonitor(name, log, { keepOthers, monitors: after });
        after = await displays.listMonitors();
        if (!ok(after)) log(`Startup monitor: still active after the retry: ${activeNames(after).join(', ') || '—'}`);
    }

    function clearPending() {
        if (pendingMonitor) clearTimeout(pendingMonitor.timer);
        pendingMonitor = null;
    }

    // ✕ on the "Keep?" bar — the switch is final.
    function confirmStartupMonitor() {
        if (!pendingMonitor) return;
        log(`Startup monitor confirmed: ${pendingMonitor.name}`);
        clearPending();
    }

    // The countdown expired (`reason: 'timeout'`) OR ○ (`'user'`) — back to the previous layout + the previous
    // `display.monitor` (`null` → the key is deleted).
    async function revertStartupMonitor(reason = 'user') {
        if (switchRun) await switchRun.catch(() => {}); // after a switch currently running
        if (!pendingMonitor) return;
        const { prevActive, prevMonitor, name } = pendingMonitor;
        clearPending();
        log(`Startup monitor restored (${reason}): ${name} -> ${prevActive.join(', ')}`);
        try {
            displays.writeDisplayConfig({ monitor: prevMonitor });
            // If the previous startup monitor is the TV, WAKE it over CEC too — it may have been turned off during
            // the "Keep?" window (in production the TV stayed dark after switching back). `maybePowerOnTv` decides
            // from the config just written back (only acts for the CEC adapter's connector), in parallel with the
            // kscreen step.
            const powerOn = startupOutputs.maybePowerOnTv(log);
            let restored = await displays.restoreActiveMonitors(prevActive, log);
            if (!restored) {
                // The TV that was off may have removed its output too — one more attempt after the wake-up.
                await powerOn;
                await new Promise((r) => setTimeout(r, revertRetryMs));
                restored = await displays.restoreActiveMonitors(prevActive, log);
            }
            if (!restored) {
                // Nothing to restore to: the currently VISIBLE monitor stays, and so does the config — otherwise the
                // next start would switch to a dark display.
                displays.writeDisplayConfig({ monitor: name });
                log(`Startup monitor: the previous output (${prevActive.join(', ')}) is unavailable — ${name} stays`);
                sendToRenderer('monitor-config-reverted', { name, reason, kept: true });
                return;
            }
            sendToRenderer('monitor-config-reverted', { name: prevMonitor, reason });
        } catch (err) {
            log(`Startup monitor restore error: ${err.message}`);
            sendToRenderer('monitor-config-reverted', { name: prevMonitor, reason, error: true });
        }
    }

    // Quitting during a pending switch (PS combo, TV-mode exit): no time left for the kscreen step, but the
    // CONFIG must not stay on the unconfirmed monitor — otherwise the next start's `applyStartupOutputs()`
    // would switch to the (possibly dark) display again. Synchronous.
    function abandonPendingMonitor() {
        if (!pendingMonitor) return;
        const { prevMonitor, name } = pendingMonitor;
        clearPending();
        try {
            displays.writeDisplayConfig({ monitor: prevMonitor });
            log(`Startup monitor unconfirmed (${name}) — config restored on exit`);
        } catch (err) {
            log(`Startup monitor config restore error: ${err.message}`);
        }
    }

    return {
        listAudioSinks, setAudioSink, setStartupSink, changeVolume,
        listMonitors, getDisplayConfig, setOutputBehavior, setStartupMonitor,
        confirmStartupMonitor, revertStartupMonitor, abandonPendingMonitor,
    };
}

/**
 * @param {Parameters<typeof createOutputHandlers>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerOutputIpc(deps) {
    const { ipcMain } = deps;
    requireDeps(deps, ['ipcMain'], 'registerOutputIpc');
    const h = createOutputHandlers(deps);
    // --- Audio ---
    ipcMain.handle('list-audio-sinks', () => h.listAudioSinks());
    // Sink/monitor names go into the `pactl` / `kscreen-doctor` arguments and the config: short, non-empty
    // strings (the handler checks actual existence against the list / the command rejects it).
    ipcMain.on('set-audio-sink', (event, sinkName) => { const n = str(sinkName, 300); if (n) h.setAudioSink(n); });
    ipcMain.on('set-startup-sink', (event, sinkName) => { const n = str(sinkName, 300); if (n) h.setStartupSink(n); });
    ipcMain.on('change-volume', (event, delta) => { if (Number.isFinite(delta)) h.changeVolume(delta); });
    // --- Display ---
    ipcMain.handle('list-monitors', () => h.listMonitors());
    ipcMain.handle('get-display-config', () => h.getDisplayConfig());
    ipcMain.on('set-output-behavior', (event, patch) => h.setOutputBehavior(patch));
    ipcMain.on('set-startup-monitor', (event, name) => { const n = str(name, 300); if (n) h.setStartupMonitor(n); });
    ipcMain.on('confirm-startup-monitor', () => h.confirmStartupMonitor());
    ipcMain.on('revert-startup-monitor', () => h.revertStartupMonitor('user'));
    return h;
}

module.exports = { createOutputHandlers, registerOutputIpc, MONITOR_CONFIRM_MS };
