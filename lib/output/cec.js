// @ts-check
'use strict';

// CEC control: the TV "remote button" messages (volume/mute), powering the TV on at startup and standby on exit. `cec-ctl`/
// `cec-toolbox` can be called without sudo (`video` group, `/dev/cec0`). Most DESKTOP GPUs have NO CEC — then `cecAvailable()` is false.
// Background: docs/dev/output-tv.md#cec

const fs = require('fs');
const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');

// Decides from a `/dev` entry list whether there is a CEC device node (cec0 / cec1 / …). Pure.
function hasCecDevice(devEntries) {
    return Array.isArray(devEntries) && devEntries.some((n) => /^cec[0-9]+$/.test(n));
}

// Is there CEC on this machine at all: a `/dev/cec*` node EXISTS AND `cec-ctl` is on PATH. One-off, cached (the CEC adapter does
// not change at runtime). The caller is best effort — an error (e.g. unreadable `/dev`) = "no CEC".
let cecAvailableCache = null;
async function cecAvailable() {
    if (cecAvailableCache !== null) return cecAvailableCache;
    let node = false;
    try {
        node = hasCecDevice(fs.readdirSync('/dev'));
    } catch (err) {
        node = false;
    }
    let cli = false;
    if (node) {
        try {
            await execFileAsync('which', ['cec-ctl'], { timeout: EXEC_TIMEOUT_MS });
            cli = true;
        } catch (err) {
            cli = false;
        }
    }
    cecAvailableCache = node && cli;
    return cecAvailableCache;
}

// `cec-ctl` (without arguments) prints driver info, including:
//     Adapter Name               : DP-2
// = the display connector the CEC device (the TV) hangs on. This decides whether the startup monitor is the TV (see
// cecAdapterConnector). No match / bad output -> null.
function parseCecAdapter(output) {
    if (typeof output !== 'string') return null;
    const m = output.match(/^\s*Adapter Name\s*:\s*(\S+)/m);
    return m ? m[1] : null;
}

// Which display connector the CEC adapter (the TV) is on. Best effort, error -> null.
async function cecAdapterConnector() {
    try {
        const { stdout } = await execFileAsync('cec-ctl', [], { timeout: EXEC_TIMEOUT_MS });
        return parseCecAdapter(stdout);
    } catch (err) {
        return null;
    }
}

// Powers the TV on over CEC. Primarily via the proven `cec-toolbox on` wrapper (installed on the target machine — unchanged
// behavior); if `cec-toolbox` is NOT on the machine, a raw `cec-ctl --image-view-on` to the `target` logical address (default 0 = TV).
async function powerOnTv(target = 0) {
    try {
        await execFileAsync('cec-toolbox', ['on'], { timeout: EXEC_TIMEOUT_MS });
        return;
    } catch (err) {
        // no `cec-toolbox` on PATH (ENOENT) OR it failed -> raw cec-ctl
    }
    await execFileAsync(
        'cec-ctl',
        ['-s', `-t${cecTarget(target)}`, '--image-view-on'],
        { timeout: EXEC_TIMEOUT_MS },
    );
}

// TV standby (power off) over CEC — the `display.standbyOnExit` option on TV-mode exit.
async function standbyTv(target = 0) {
    await execFileAsync(
        'cec-ctl',
        ['-s', `-t${cecTarget(target)}`, '--standby'],
        { timeout: EXEC_TIMEOUT_MS },
    );
}

// A standard CEC "remote button" message to the `target` logical address (default 0 = TV; for an AVR/soundbar setup
// 5 = "Audio System" — `display.cecTarget`). `ui-cmd`: volume-up / volume-down / mute (mute is a toggle on the TV, not a settable value).
async function cecUserControl(uiCmd, target = 0) {
    await execFileAsync(
        'cec-ctl',
        ['-s', `-t${cecTarget(target)}`, '--user-control-pressed', `ui-cmd=${uiCmd}`, '--user-control-released'],
        { timeout: EXEC_TIMEOUT_MS },
    );
}

// The CEC logical address clamped to 0..15 (bad config -> 0 = TV).
function cecTarget(v) {
    return Number.isInteger(v) && v >= 0 && v <= 15 ? v : 0;
}

module.exports = {
    hasCecDevice, cecAvailable, parseCecAdapter, cecAdapterConnector,
    powerOnTv, standbyTv, cecUserControl, cecTarget,
};
