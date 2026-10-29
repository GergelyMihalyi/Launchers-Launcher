// @ts-check
'use strict';

// RECORD + grant/revoke of the flatpak permissions granted by the launcher (`flatpak override --user --filesystem=<folder> <app-id>`).
// The record is the `flatpakGrants` key `[{ appId, path, at }]` — ONLY permissions granted by the launcher; revoking (`--nofilesystem`)
// works from it and never touches the user's own overrides (Flatseal). The automatic melonDS override is booked here too
// (`record`/`forget`, `adoptExisting` at startup). `grant` is DELIBERATELY narrow: only a sensible, absolute, not too broad folder
// (`isSafeGrantDir`), and the caller only calls it for a pair the ROM access check reported as "not visible".
// Background: docs/dev/launchers/README.md#flatpak-access-to-rom-folders

const os = require('os');
const path = require('path');
const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
const { flatpakAppId, PATH_MAX } = require('../validate.js');

/** System folders on (or under) which we never grant access. */
const FORBIDDEN_ROOTS = ['/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/proc', '/sys', '/dev', '/boot', '/root', '/opt'];
/** Below this folder depth (e.g. `/mnt`, `/media`) it is too broad. */
const MIN_DEPTH = 2;

/**
 * Is it a sensible, narrow folder for a grant: absolute, normalized, no `:`/control characters (flatpak's
 * `path[:mode]` syntax), at least `MIN_DEPTH` deep, not a system folder, not `$HOME` itself.
 * @param {unknown} dir @param {string} [home]
 * @returns {string | null} the (unchanged) folder or `null`
 */
function isSafeGrantDir(dir, home = os.homedir()) {
    if (typeof dir !== 'string' || !dir || dir.length > PATH_MAX) return null;
    if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) return null;
    // eslint-disable-next-line no-control-regex
    if (/[:\u0000-\u001f\u007f]/.test(dir)) return null;
    const depth = dir.split('/').filter(Boolean).length;
    if (depth < MIN_DEPTH) return null;
    if (dir === home) return null;
    for (const root of FORBIDDEN_ROOTS) {
        if (dir === root || dir.startsWith(`${root}/`)) return null;
    }
    if (dir === '/run' || dir === '/run/user' || /^\/run\/user\/\d+$/.test(dir)) return null;
    return dir;
}

/**
 * @param {Object} deps
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void }} deps.config
 * @param {(msg: string) => void} [deps.log]
 * @param {(file: string, args: string[], opts?: any) => Promise<any>} [deps.exec] teszthez
 * @param {() => number} [deps.now]
 */
function createFlatpakGrants(deps) {
    const { config, log = () => {}, exec = execFileAsync, now = Date.now } = deps;

    /** @returns {Array<{ appId: string, path: string, at: number }>} */
    function list() {
        const raw = config.get('flatpakGrants', []);
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const g of raw) {
            const appId = g && flatpakAppId(g.appId);
            if (!appId || typeof g.path !== 'string' || !g.path) continue;
            if (out.some((x) => x.appId === appId && x.path === g.path)) continue;
            out.push({ appId, path: g.path, at: Number(g.at) || 0 });
        }
        return out;
    }

    const has = (appId, dir) => list().some((g) => g.appId === appId && g.path === dir);

    /** Records it (does not call flatpak) — for melonDS's own override. */
    function record(appId, dir) {
        if (!flatpakAppId(appId) || typeof dir !== 'string' || !dir || has(appId, dir)) return;
        config.set('flatpakGrants', [...list(), { appId, path: dir, at: now() }]);
    }

    function forget(appId, dir) {
        const next = list().filter((g) => !(g.appId === appId && g.path === dir));
        if (next.length !== list().length) config.set('flatpakGrants', next);
    }

    /**
     * Grants a folder to the app and records it.
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async function grant(appId, dir) {
        const id = flatpakAppId(appId);
        const safe = isSafeGrantDir(dir);
        if (!id || !safe) return { ok: false, reason: 'invalid app or folder' };
        try {
            await exec('flatpak', ['override', '--user', `--filesystem=${safe}`, id], { timeout: EXEC_TIMEOUT_MS });
        } catch (err) {
            log(`flatpak permission error (${id} → ${safe}): ${err.message}`);
            return { ok: false, reason: err.message };
        }
        record(id, safe);
        log(`flatpak permission granted: ${id} → ${safe}`);
        return { ok: true };
    }

    /**
     * Revokes a permission granted by the launcher (only recorded ones).
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async function revoke(appId, dir) {
        const id = flatpakAppId(appId);
        if (!id || typeof dir !== 'string' || !has(id, dir)) return { ok: false, reason: 'not a permission granted by the launcher' };
        try {
            await exec('flatpak', ['override', '--user', `--nofilesystem=${dir}`, id], { timeout: EXEC_TIMEOUT_MS });
        } catch (err) {
            log(`flatpak permission revoke error (${id} → ${dir}): ${err.message}`);
            return { ok: false, reason: err.message };
        }
        forget(id, dir);
        log(`flatpak permission revoked: ${id} → ${dir}`);
        return { ok: true };
    }

    /**
     * Startup adoption: the overrides melonDS granted automatically earlier (manual ROM folders outside `$HOME`)
     * are added to the record so they can be revoked.
     * @param {string} appId @param {string[]} dirs
     * @param {string} [home]
     */
    function adoptExisting(appId, dirs, home = os.homedir()) {
        for (const d of Array.isArray(dirs) ? dirs : []) {
            if (typeof d !== 'string' || !d) continue;
            const inside = d === home || d.startsWith(`${home}/`);
            if (!inside) record(appId, d);
        }
    }

    return { list, has, record, forget, grant, revoke, adoptExisting };
}

module.exports = { createFlatpakGrants, isSafeGrantDir };
