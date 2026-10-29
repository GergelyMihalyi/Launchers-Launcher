// @ts-check
'use strict';

// VISIBILITY of the flatpak emulators' ROM folders from the sandbox (informational only): the launcher sees everything, the emulator
// only what its `filesystems` permission (+ user override) opens. `resolveFsEntry`/`flatpakSees` — PURE matching
// (`flatpak info --show-permissions`, the most specific entry wins); `readRomDirs(id, args)` — the worker-side core (`scan-sources.js`
// `romDirs`: `readGameDirs` + `realpath`, which blocks in the worker on NFS); `createRomAccessChecker(deps)` — compares the added
// flatpak emulators (TTL-cached). Background: docs/dev/launchers/README.md#flatpak-access-to-rom-folders

const fs = require('fs');
const os = require('os');
const path = require('path');
const { flatpakRunAppId, readFlatpakFilesystems } = require('../flatpak.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');

// `host` does NOT open these (flatpak-metadata(5): "reserved" system folders, the runtime directory) — a ROM folder is practically
// never here, but `host` must not lie about them.
const HOST_RESERVED = ['/app', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc', '/proc', '/sys', '/dev',
    '/run/flatpak', '/run/host', '/run/user'];
const HOST_OS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64'];

// `xdg-<name>` → the `user-dirs.dirs` key + the default folder name (if the file is missing).
const XDG_USER_DIRS = {
    'xdg-desktop': ['XDG_DESKTOP_DIR', 'Desktop'],
    'xdg-documents': ['XDG_DOCUMENTS_DIR', 'Documents'],
    'xdg-download': ['XDG_DOWNLOAD_DIR', 'Downloads'],
    'xdg-music': ['XDG_MUSIC_DIR', 'Music'],
    'xdg-pictures': ['XDG_PICTURES_DIR', 'Pictures'],
    'xdg-public-share': ['XDG_PUBLICSHARE_DIR', 'Public'],
    'xdg-templates': ['XDG_TEMPLATES_DIR', 'Templates'],
    'xdg-videos': ['XDG_VIDEOS_DIR', 'Videos'],
};
const XDG_BASE_DIRS = { 'xdg-config': '.config', 'xdg-data': '.local/share', 'xdg-cache': '.cache' };

/**
 * @typedef {{ home: string, runtimeDir: string, userDirs?: Record<string, string>, appId?: string }} SandboxEnv
 * @typedef {{ roots: string[], negated: boolean, kind: 'host'|'home'|'path', order: number }} FsEntry
 */

/** `~/.config/user-dirs.dirs` → `{ XDG_DOWNLOAD_DIR: '/home/x/Downloads', … }` (missing file → `{}`). */
function readUserDirs(home = os.homedir()) {
    /** @type {Record<string, string>} */
    const out = {};
    let text = '';
    try {
        text = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    } catch (err) {
        return out;
    }
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(XDG_[A-Z]+_DIR)\s*=\s*"(.*)"\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^\$HOME(?=\/|$)/, home);
    }
    return out;
}

/** @param {string} p */
function clean(p) {
    const r = path.resolve(p);
    return r.length > 1 ? r.replace(/\/+$/, '') : r;
}

/** @param {string} dir @param {string} root */
function isUnder(dir, root) {
    return root === '/' || dir === root || dir.startsWith(`${root}/`);
}

/**
 * A `filesystems=` entry → the covered root(s), or `null` (unknown / not folder-like).
 * `!` = deny; a `:ro`/`:rw`/`:create` suffix does not change visibility.
 * @param {string} raw @param {SandboxEnv} env @param {number} [order]
 * @returns {FsEntry|null}
 */
function resolveFsEntry(raw, env, order = 0) {
    let e = String(raw || '').trim();
    const negated = e.startsWith('!');
    if (negated) e = e.slice(1);
    e = e.replace(/:(ro|rw|create)$/, '');
    if (!e) return null;
    const home = clean(env.home);
    const sub = (base, rest) => clean(rest ? path.join(base, rest) : base);
    const [head, ...restParts] = e.split('/');
    const rest = restParts.join('/');
    if (e === 'host') return { roots: ['/'], negated, kind: 'host', order };
    if (e === 'host-os') return { roots: HOST_OS, negated, kind: 'path', order };
    if (e === 'host-etc') return { roots: ['/etc'], negated, kind: 'path', order };
    if (e === 'home' || e === '~') return { roots: [home], negated, kind: 'home', order };
    if (head === '~') return { roots: [sub(home, rest)], negated, kind: 'path', order };
    if (head === 'xdg-run') return { roots: [sub(env.runtimeDir, rest)], negated, kind: 'path', order };
    if (XDG_BASE_DIRS[head]) return { roots: [sub(path.join(home, XDG_BASE_DIRS[head]), rest)], negated, kind: 'path', order };
    if (XDG_USER_DIRS[head]) {
        const [key, fallback] = XDG_USER_DIRS[head];
        const base = (env.userDirs && env.userDirs[key]) || path.join(home, fallback);
        return { roots: [sub(base, rest)], negated, kind: 'path', order };
    }
    if (e.startsWith('/')) return { roots: [clean(e)], negated, kind: 'path', order };
    return null;
}

/**
 * The MOST SPECIFIC entry covering the folder (the longest root; on a tie the later one), or `null`.
 * @param {string} dir @param {FsEntry[]} entries @param {SandboxEnv} env
 */
function bestEntry(dir, entries, env) {
    const runtime = clean(env.runtimeDir);
    let best = null;
    let bestLen = -1;
    for (const entry of entries) {
        for (const root of entry.roots) {
            if (!isUnder(dir, root)) continue;
            if (entry.kind === 'host' && (HOST_RESERVED.some((r) => isUnder(dir, r)) || isUnder(dir, runtime))) continue;
            const len = root === '/' ? 0 : root.length;
            if (len > bestLen || (len === bestLen && best && entry.order > best.order)) {
                best = entry;
                bestLen = len;
            }
        }
    }
    return best;
}

/**
 * Does the sandbox see the folder? The document portal (`<runtimeDir>/doc/…` — a folder opened via the file
 * chooser) and the app's own `~/.var/app/<appId>` are always visible.
 * @param {string} dir @param {string[]} filesystems @param {SandboxEnv} env
 */
function flatpakSees(dir, filesystems, env) {
    return seesWith(clean(dir), parseEntries(filesystems, env), env);
}

/** @param {string[]} filesystems @param {SandboxEnv} env @returns {FsEntry[]} */
function parseEntries(filesystems, env) {
    return (Array.isArray(filesystems) ? filesystems : [])
        .map((f, i) => resolveFsEntry(f, env, i))
        .filter(Boolean);
}

/** @param {string} dir @param {FsEntry[]} entries @param {SandboxEnv} env */
function seesWith(dir, entries, env) {
    if (isUnder(dir, clean(path.join(env.runtimeDir, 'doc')))) return true;
    if (env.appId && isUnder(dir, clean(path.join(env.home, '.var', 'app', env.appId)))) return true;
    const best = bestEntry(dir, entries, env);
    return !!best && !best.negated;
}

/**
 * Visibility per folder. For a symlinked folder (`~/roms → /mnt/ntfs/ROMs`) the TARGET must be visible — the
 * `home` permission opens the link but not the target; unless a specific (non `home`/`host`) entry names the
 * link itself (flatpak resolves it and mounts the target).
 * @param {Array<{ dir: string, real?: string|null }>} dirs @param {string[]} filesystems @param {SandboxEnv} env
 * @returns {Array<{ dir: string, visible: boolean }>}
 */
function checkRomDirAccess(dirs, filesystems, env) {
    const entries = parseEntries(filesystems, env);
    return (Array.isArray(dirs) ? dirs : []).map(({ dir, real }) => {
        const d = clean(dir);
        const r = real ? clean(real) : d;
        let visible = seesWith(r, entries, env);
        if (!visible && r !== d) {
            const direct = bestEntry(d, entries, env);
            visible = !!direct && !direct.negated && direct.kind === 'path';
        }
        return { dir, visible };
    });
}

// --- worker-side core ---

/** @param {string} dir */
function realpathOrNull(dir) {
    try {
        return fs.realpathSync.native(dir);
    } catch (err) {
        return null;
    }
}

/**
 * An emulator's ROM folders + their `realpath` (the `romDirs` source of `lib/scan/scan-sources.js` — the library's
 * `readGameDirs` filters on existence, which would freeze the main process on a hanging NFS).
 * @param {string} id @param {any[]} args the descriptor's `romDirArgs()`
 */
function readRomDirs(id, args) {
    const { DEFAULT_LIBS } = require('./emulator-sources.js');
    const load = DEFAULT_LIBS[id];
    if (!load) throw new Error(`unknown emulator: ${id}`);
    const lib = load();
    if (typeof lib.readGameDirs !== 'function') return [];
    const res = lib.readGameDirs(...(Array.isArray(args) ? args : []));
    const dirs = Array.isArray(res) ? res : (res && Array.isArray(res.dirs) ? res.dirs : []);
    return dirs.filter((d) => typeof d === 'string' && d).map((dir) => ({ dir, real: realpathOrNull(dir) }));
}

// --- comparison ---

/**
 * @param {Object} deps
 * @param {Record<string, any>} deps.emulatorSources the descriptor (entries with `romDirArgs`)
 * @param {() => Array<{ id: string, cmd?: string, args?: string[] }>} deps.getLaunchers the added launchers
 * @param {(id: string, args: any[]) => Promise<Array<{ dir: string, real?: string|null }>>} deps.loadRomDirs
 * @param {(appId: string) => Promise<string[]|null>} [deps.readFilesystems]
 * @param {() => void} [deps.invalidateRomDirs] clears `loadRomDirs`'s own cache (on `refresh`)
 * @param {() => SandboxEnv} [deps.sandboxEnv]
 * @param {(msg: string) => void} [deps.log]
 */
function createRomAccessChecker(deps) {
    const {
        emulatorSources, getLaunchers, loadRomDirs,
        readFilesystems = readFlatpakFilesystems,
        invalidateRomDirs = () => {},
        sandboxEnv = defaultSandboxEnv,
        log = () => {},
    } = deps;

    async function checkOne(launcher, source) {
        const appId = flatpakRunAppId(launcher.args);
        if (!appId) return [];
        const [dirs, filesystems] = await Promise.all([
            loadRomDirs(launcher.id, source.romDirArgs()),
            readFilesystems(appId),
        ]);
        if (!filesystems) return []; // the query failed → no judgement
        const env = { ...sandboxEnv(), appId };
        return checkRomDirAccess(dirs, filesystems, env).map((r) => ({
            source: launcher.id, name: source.label || launcher.id, appId, dir: r.dir, visible: r.visible,
        }));
    }

    // The cache key is the list of targets (id + args) — a variant switch (native ↔ flatpak) / a new launcher gives a new key.
    /** @param {Array<{ id: string, args?: string[] }>} targets */
    async function compute(targets) {
        const results = await Promise.allSettled(targets.map((l) => checkOne(l, emulatorSources[l.id])));
        const items = [];
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') items.push(...r.value);
            else log(`[rom-access] ${targets[i].id}: ${r.reason && r.reason.message}`);
        });
        const hidden = items.filter((it) => !it.visible);
        if (hidden.length) {
            log(`[rom-access] the sandbox cannot see: ${hidden.map((h) => `${h.name} → ${h.dir}`).join('; ')}`);
        }
        return items;
    }

    const cached = createTtlCache(compute, GAMES_CACHE_TTL_MS);

    /** @param {{ refresh?: boolean }} [opts] */
    async function check(opts = {}) {
        if (opts.refresh) { cached.invalidate(); invalidateRomDirs(); }
        try {
            const targets = getLaunchers().filter((l) => l && l.cmd === 'flatpak'
                && emulatorSources[l.id] && typeof emulatorSources[l.id].romDirArgs === 'function')
                .map((l) => ({ id: l.id, args: l.args }));
            return { ok: true, items: await cached(targets) };
        } catch (err) {
            log(`[rom-access] error: ${err.message}`);
            return { ok: false, items: [] };
        }
    }

    return { check, invalidate: () => cached.invalidate() };
}

/** @returns {SandboxEnv} */
function defaultSandboxEnv() {
    const home = os.homedir();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return { home, runtimeDir: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`, userDirs: readUserDirs(home) };
}

module.exports = {
    resolveFsEntry, flatpakSees, checkRomDirAccess, readUserDirs, readRomDirs, createRomAccessChecker,
};
