// @ts-check
'use strict';

// Shared helper infrastructure for every external command (pactl / kscreen-doctor / cec-ctl /
// bluetoothctl). No `BrowserWindow` reference.

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const timings = require('./timings.js');
const { pickOzonePlatform } = require('./ozone-platform.js');

const execFileAsync = promisify(execFile);

// The launcher often starts as a systemd --user service with a minimal PATH (no `~/.local/bin`) — in production this broke native
// launchers installed into `~/.local/bin` (RPCS3 AppImage: `spawn rpcs3 ENOENT`) and the `which`-based detection. Hence a one-off,
// process-wide PATH extension at module load; it affects every `execFileAsync`/`spawn` call.
const localBin = path.join(os.homedir(), '.local', 'bin');
if (!(process.env.PATH || '').split(path.delimiter).includes(localBin)) {
    process.env.PATH = process.env.PATH ? `${localBin}${path.delimiter}${process.env.PATH}` : localBin;
}

// Uniform timeout for every external command (value in lib/timings.js). Without it a stuck helper
// process causes a forever-hanging ipcMain.handle -> the UI is stuck on "LOADING..." with no way out.
const { EXEC_TIMEOUT_MS } = timings;

// LC_ALL=C: pactl prints field names in the system language (e.g. Hungarian "Név:"/"Leírás:"); this forces
// English output for parsing, regardless of the locale.
const PACTL_OPTS = { env: { ...process.env, LC_ALL: 'C' }, timeout: EXEC_TIMEOUT_MS };

// The KDE Plasma / Wayland profile of the target PC — ONLY used when the real session variable is
// missing (under the systemd/udev-triggered watcher the Wayland/D-Bus env is sometimes empty).
const DESKTOP_ENV_FALLBACK = {
    display: ':0',
    waylandDisplay: 'wayland-0',
    desktop: 'KDE',
};

function runtimeDir() {
    if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    return `/run/user/${uid}`;
}

// The session env needed by external commands / the spawned game. `full: false` — the minimal Wayland/DBus trio; `full: true` — with
// the extras needed to spawn a game. Every field comes from the real `process.env`, the fallback ONLY fills in what is missing. The
// session-type fallback is `platform` (default: `lib/ozone-platform.js`); on X11 `WAYLAND_DISPLAY` is not filled in (it would lure SDL3 to Wayland).
/** @param {{ full?: boolean, platform?: 'wayland' | 'x11' }} [opts] */
function sessionEnv({ full = false, platform } = {}) {
    const plat = platform || pickOzonePlatform().platform;
    /** @type {NodeJS.ProcessEnv} */
    const base = {
        ...process.env,
        DISPLAY: process.env.DISPLAY || DESKTOP_ENV_FALLBACK.display,
        XDG_RUNTIME_DIR: runtimeDir(),
    };
    const waylandDisplay = process.env.WAYLAND_DISPLAY
        || (plat === 'wayland' ? DESKTOP_ENV_FALLBACK.waylandDisplay : undefined);
    if (waylandDisplay) base.WAYLAND_DISPLAY = waylandDisplay;
    if (!full) return base;
    const sessionType = ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE || '')
        ? process.env.XDG_SESSION_TYPE : plat;
    return {
        ...base,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        XDG_SESSION_TYPE: sessionType,
        XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || DESKTOP_ENV_FALLBACK.desktop,
        XDG_SESSION_DESKTOP: process.env.XDG_SESSION_DESKTOP || DESKTOP_ENV_FALLBACK.desktop,
        XAUTHORITY: process.env.XAUTHORITY,
    };
}

// Backward compat: most callers expect a ready object (`{ env: SESSION_ENV }`).
const SESSION_ENV = sessionEnv();

// A successful BT connect usually returns within ~1 s; for an unreachable device BlueZ's internal
// "page timeout" makes it fail by itself after ~5 s. The longer timeout (lib/timings.js
// `BT_CONNECT_TIMEOUT_MS`) is only a safety net against a rarer (e.g. "connection busy") hang.
const BT_TIMEOUT_OPTS = { timeout: timings.BT_CONNECT_TIMEOUT_MS };

// Clear the losing (not expired) timer once the race is decided — otherwise every call would leave a
// useless timer alive for up to `ms`.
function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Async logging with size-based rotation (one .1 backup). Callers pass a plain message, this prepends
// the timestamp. `createLogger(file, maxBytes)` keeps the `logBytes` state in a closure so several
// instances (tests) stay independent.
function createLogger(logFile, maxBytes) {
    let logBytes = 0;
    try { logBytes = fs.statSync(logFile).size; } catch (err) { /* no file yet */ }

    function log(msg) {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        logBytes += Buffer.byteLength(line);
        if (logBytes > maxBytes) {
            try { fs.renameSync(logFile, logFile + '.1'); } catch (err) { /* best effort */ }
            logBytes = Buffer.byteLength(line);
        }
        fs.appendFile(logFile, line, () => { });
    }
    // Explicit levels: `WARN`/`ERROR` after the timestamp — the Log subview filters on it
    // (lib/log-lines.js `classifyLogLine`; unmarked lines are classified by keyword).
    log.warn = (msg) => log(`WARN ${msg}`);
    log.error = (msg) => log(`ERROR ${msg}`);
    return log;
}

// Uniform error logging for best-effort `catch` branches: `logError(log, 'audio.applyStartupSink', err)`
// -> `log('audio.applyStartupSink: <message>')`. No-op for a falsy `log` (some `lib/*` functions take an
// optional `log` — then the caller asked for no logging). Pure parse fallbacks (`return null`) stay silent.
function logError(log, context, err) {
    if (typeof log !== 'function') return;
    const msg = err && err.message ? err.message : String(err);
    const emit = typeof log.error === 'function' ? log.error : log;
    emit(`${context}: ${msg}`);
}

// A logger that is always callable from an optional `log` parameter: function → itself; anything else
// (missing / `undefined`) → silent no-op. The best-effort `lib/*` functions (displays / audio / bluetooth /
// tv-mode / startup-outputs) take an optional `log`.
/**
 * @param {unknown} log
 * @returns {(msg: string) => void}
 */
function toLogger(log) {
    return typeof log === 'function' ? /** @type {(msg: string) => void} */ (log) : () => {};
}

module.exports = {
    execFileAsync, EXEC_TIMEOUT_MS, PACTL_OPTS, SESSION_ENV, sessionEnv, BT_TIMEOUT_OPTS,
    withTimeout, createLogger, logError, toLogger,
};
