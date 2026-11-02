// @ts-check
'use strict';

// Picks the graphics platform of Electron/Chromium (`--ozone-platform`). IMPORTANT: the decision does NOT depend on the
// `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY` env (may be missing under the watcher; a forced `wayland` on an X11 machine is an instant
// SIGTRAP) but on the existence of the Wayland SOCKET (`$WAYLAND_DISPLAY`, else `wayland-0`, else any `wayland-<n>` found in `$XDG_RUNTIME_DIR` — a compositor
// whose `wayland-0` is taken at login gets `wayland-1`). Background: docs/dev/platforms.md

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

// Without `WAYLAND_DISPLAY` and without a `wayland-0`: the lowest-numbered `wayland-<n>` socket in the runtime dir (null = none).
/**
 * @param {Record<string, string | undefined>} env
 * @param {(p: string) => boolean} exists
 * @param {(dir: string) => string[]} listDir
 */
function findWaylandSocketName(env, exists, listDir) {
    const dir = runtimeDirOf(env);
    const names = listDir(dir)
        .filter((f) => /^wayland-\d+$/.test(f))
        .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    return names.find((n) => exists(path.join(dir, n))) || null;
}

/**
 * @param {{ env?: Record<string, string | undefined>, exists?: (p: string) => boolean,
 *           listDir?: (dir: string) => string[] }} [opts]
 * @returns {{ platform: 'wayland' | 'x11', reason: string, display?: string, waylandDisplay?: string }}
 *   `display`: only if X was found from its socket (no `DISPLAY` env) — the caller fills in
 *   `process.env.DISPLAY` with it, otherwise Chromium's X11 backend could not connect.
 *   `waylandDisplay`: only if the Wayland socket was FOUND by scanning (no `WAYLAND_DISPLAY` env, not `wayland-0`) — the
 *   caller fills in `process.env.WAYLAND_DISPLAY`, otherwise Chromium and `kscreen-doctor` would look for `wayland-0`.
 */
function pickOzonePlatform({ env = process.env, exists = defaultExists, listDir = defaultListDir } = {}) {
    const override = (env[OVERRIDE_ENV] || '').trim().toLowerCase();
    if (PLATFORMS.includes(override)) {
        return { platform: /** @type {'wayland' | 'x11'} */ (override), reason: `${OVERRIDE_ENV}=${override}` };
    }
    const socket = waylandSocketPath(env);
    if (exists(socket)) return { platform: 'wayland', reason: `Wayland-socket: ${socket}` };
    if (!env.WAYLAND_DISPLAY) {
        const found = findWaylandSocketName(env, exists, listDir);
        if (found) {
            return { platform: 'wayland', reason: `Wayland-socket: ${path.join(runtimeDirOf(env), found)} (no ${socket})`, waylandDisplay: found };
        }
    }
    if (env.DISPLAY) return { platform: 'x11', reason: `no Wayland socket (${socket}), DISPLAY=${env.DISPLAY}` };
    const xSockets = listDir(X11_SOCKET_DIR).filter((f) => /^X\d+$/.test(f));
    if (xSockets.length) {
        const display = `:${xSockets.sort()[0].slice(1)}`;
        return { platform: 'x11', reason: `no Wayland socket (${socket}), X socket: ${display}`, display };
    }
    // No trace of either Wayland or X: the old unconditional default.
    return { platform: 'wayland', reason: 'neither a Wayland nor an X socket — default' };
}

module.exports = { pickOzonePlatform, waylandSocketPath, findWaylandSocketName, OVERRIDE_ENV };
