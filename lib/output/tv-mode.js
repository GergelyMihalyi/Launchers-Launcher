// @ts-check
'use strict';

// Orchestrates the TV-mode exit (hold Circle 5 s) — the launcher runs as the desktop user, so the monitor/audio restore happens
// directly here, without sudo or a shell script. No `BrowserWindow` reference.

const { parseSinks, findSinkNameByPattern, escapeRegExp } = require('../parse.js');
const { execFileAsync, PACTL_OPTS, withTimeout, toLogger } = require('../exec.js');
const { TV_EXIT_STEP_TIMEOUT_MS, TV_EXIT_GAMEPAD_TIMEOUT_MS } = require('../timings.js');
const displays = require('./displays.js');
const audio = require('./audio.js');
const bluetooth = require('../bluetooth/bluetooth.js');

// Pure decision: which sink to switch to, from the saved `desktop.sink` + the `pactl list sinks` output. Exact NAME match (on the
// `parseSinks` list — not a substring: a saved `…extra2` must not "find itself" in an `…extra20` sink) → that one; missing + the prefix
// without trailing digits (>= 12 characters, so it is not too generic) matches another sink → that one; otherwise `null` (no-op). The
// prefix is derived from the SAVED name itself, not a machine-specific pattern.
function resolveDesktopSink(saved, sinksOutput) {
    if (!saved || typeof saved !== 'string') return null;
    if (parseSinks(sinksOutput).some((s) => s.name === saved)) return saved;
    const prefix = saved.replace(/\d+$/, '');
    if (prefix === saved || prefix.length < 12) return null;
    return findSinkNameByPattern(sinksOutput, new RegExp(escapeRegExp(prefix)));
}

// Restores the desktop audio output when LEAVING TV mode. The ONLY source is `desktop.sink` of the `display` config key
// (`captureDesktopSnapshot()` records the real default sink at startup). **No hard-coded sink-name fallback** — without `desktop.sink`
// this is a logged no-op, exactly like the monitor branch (`displays.restoreMonitors`).
//
// If the saved name is not in `pactl list sinks` (device numbering may shift if the TV connected meanwhile — e.g.
// `...hdmi-stereo-extra2` → `...extra3`), match on the name's prefix without trailing digits. Derived from the saved name itself, not a
// machine-specific pattern.
async function restoreDesktopAudio(log) {
    const emit = toLogger(log);
    const { desktop } = displays.readDisplayConfig();
    const saved = desktop && typeof desktop.sink === 'string' && desktop.sink ? desktop.sink : null;
    if (!saved) {
        emit('TV mode exit (audio): no desktop.sink profile — skipped');
        return null;
    }

    let target = saved;
    try {
        const { stdout } = await execFileAsync('pactl', ['list', 'sinks'], PACTL_OPTS);
        target = resolveDesktopSink(saved, stdout);
        if (!target) {
            emit(`TV mode exit (audio): the saved sink (${saved}) is not in the list — skipped`);
            return null;
        }
        if (target !== saved) {
            emit(`TV mode exit (audio): the saved sink (${saved}) is gone → ${target}`);
        }
    } catch (err) {
        // pactl error → keep `saved`, try to apply it
        target = saved;
    }
    await audio.setAudioSink(target);
    return target;
}

// The 3 steps (monitor / audio / controller disconnect) are independent, best effort - none failing blocks the others, and a stuck
// command (e.g. bluetoothctl) does not block the exit. `log` for logging errors (optional); the caller calls `app.quit()` after this.
async function exitTvModeCleanup(log) {
    const emit = toLogger(log);
    const results = await Promise.allSettled([
        withTimeout(displays.restoreMonitors(emit), TV_EXIT_STEP_TIMEOUT_MS, 'monitor'),
        withTimeout(restoreDesktopAudio(emit), TV_EXIT_STEP_TIMEOUT_MS, 'audio'),
        withTimeout(bluetooth.disconnectGamepads(), TV_EXIT_GAMEPAD_TIMEOUT_MS, 'gamepad'),
    ]);
    const labels = ['monitor', 'audio', 'gamepad'];
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            emit(`TV mode exit (${labels[i]}) error: ${r.reason}`);
        }
    });
}

module.exports = { resolveDesktopSink, restoreDesktopAudio, exitTvModeCleanup };
