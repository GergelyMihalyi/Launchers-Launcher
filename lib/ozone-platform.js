// @ts-check
'use strict';

// Picks the graphics platform of Electron/Chromium (`--ozone-platform`). IMPORTANT: the decision does NOT depend on the
// `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY` env (may be missing under the watcher; a forced `wayland` on an X11 machine is an instant
// SIGTRAP) but on the existence of the Wayland SOCKET (`$WAYLAND_DISPLAY`, else `wayland-0` in `$XDG_RUNTIME_DIR`). Background: docs/dev/platforms.md

const fs = require('fs');
const path = require('path');

const OVERRIDE_ENV = 'LAUNCHERS_LAUNCHER_OZONE';
const PLATFORMS = ['wayland', 'x11'];
const X11_SOCKET_DIR = '/tmp/.X11-unix';

/** @param {Record<string, string | undefined>} env */
function runtimeDirOf(env) {
    if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    return `/run/user/${uid}`;
}

// The socket path libwayland would connect to: absolute `WAYLAND_DISPLAY` → itself; a name → in the
// runtime dir; none → `wayland-0`.
/** @param {Record<string, string | undefined>} env */
function waylandSocketPath(env) {
    const name = env.WAYLAND_DISPLAY || 'wayland-0';
    return path.isAbsolute(name) ? name : path.join(runtimeDirOf(env), name);
}

/** @param {string} p */
function defaultExists(p) {
    try { fs.statSync(p); return true; } catch { return false; }
}

/** @param {string} dir */
function defaultListDir(dir) {
    try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * @param {{ env?: Record<string, string | undefined>, exists?: (p: string) => boolean,
 *           listDir?: (dir: string) => string[] }} [opts]
 * @returns {{ platform: 'wayland' | 'x11', reason: string, display?: string }}
 *   `display`: only if X was found from its socket (no `DISPLAY` env) — the caller fills in
 *   `process.env.DISPLAY` with it, otherwise Chromium's X11 backend could not connect.
 */
function pickOzonePlatform({ env = process.env, exists = defaultExists, listDir = defaultListDir } = {}) {
    const override = (env[OVERRIDE_ENV] || '').trim().toLowerCase();
    if (PLATFORMS.includes(override)) {
        return { platform: /** @type {'wayland' | 'x11'} */ (override), reason: `${OVERRIDE_ENV}=${override}` };
    }
    const socket = waylandSocketPath(env);
    if (exists(socket)) return { platform: 'wayland', reason: `Wayland-socket: ${socket}` };
    if (env.DISPLAY) return { platform: 'x11', reason: `no Wayland socket (${socket}), DISPLAY=${env.DISPLAY}` };
    const xSockets = listDir(X11_SOCKET_DIR).filter((f) => /^X\d+$/.test(f));
    if (xSockets.length) {
        const display = `:${xSockets.sort()[0].slice(1)}`;
        return { platform: 'x11', reason: `no Wayland socket (${socket}), X socket: ${display}`, display };
    }
    // No trace of either Wayland or X: the old unconditional default.
    return { platform: 'wayland', reason: 'neither a Wayland nor an X socket — default' };
}

module.exports = { pickOzonePlatform, waylandSocketPath, OVERRIDE_ENV };
