// @ts-check
'use strict';

// XDG / flatpak path helpers. No `BrowserWindow` reference.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Config root of a flatpak app. The flatpak sandbox does NOT use the native `~/.config/<app>` but
// `~/.var/app/<appId>/config/<appName>` (`<appName>` often, but not always, matches the last segment of the
// appId — e.g. `org.libretro.RetroArch` → `retroarch`, `com.heroicgameslauncher.hgl` → `heroic`). For a new
// flatpak integration look for THIS pattern, not the native one.
function flatpakConfigRoot(appId, appName, homeDir = os.homedir()) {
    return path.join(homeDir, '.var', 'app', appId, 'config', appName);
}

// Data root of a flatpak app — `~/.var/app/<appId>/data/<appName>` (Cemu puts its large non-config content
// here: the `mlc01` virtual NAND, `title_list_cache.xml`) — the `flatpakConfigRoot` pattern with `data`.
function flatpakDataRoot(appId, appName, homeDir = os.homedir()) {
    return path.join(homeDir, '.var', 'app', appId, 'data', appName);
}

// Cache root of a flatpak app — `~/.var/app/<appId>/cache/<appName>` (the `flatpakConfigRoot` pattern with
// `cache/` — Dolphin keeps its GameTDB cover cache here, `cache/dolphin-emu/GameCovers/<GameID>.png`;
// called by `dolphinCacheRoot()` in `lib/launchers/dolphin-library.js`).
function flatpakCacheRoot(appId, appName, homeDir = os.homedir()) {
    return path.join(homeDir, '.var', 'app', appId, 'cache', appName);
}

// Host-side counterpart (`/run/user/<uid>/doc/<token>/...`, the same portal instance) of a document-portal path
// seen INSIDE the sandbox (`/run/flatpak/doc/<token>/...`). Non-portal paths are returned unchanged.
// Background: docs/dev/infrastructure.md#paths-files-and-downloads
function translateFlatpakDocPath(p, uid) {
    const prefix = '/run/flatpak/doc/';
    if (typeof p !== 'string' || !p.startsWith(prefix)) return p;
    let resolvedUid = uid;
    if (resolvedUid == null) {
        try {
            resolvedUid = typeof process.getuid === 'function' ? process.getuid() : null;
        } catch (err) {
            resolvedUid = null;
        }
    }
    if (resolvedUid == null) return p;
    return path.join('/run/user', String(resolvedUid), 'doc', p.slice(prefix.length));
}

// The launcher's own data root: `~/.local/share` — the log, the sidecar files
// (`launchers-launcher-{main-controller,autostart,tvmode}`), the cover and scan caches all live under it.
// DELIBERATELY not `$XDG_DATA_HOME`: the `bin/*.sh` scripts (with a minimal env, from the systemd --user
// unit) `cat` this fixed path, and the tests isolate by pointing `$HOME` to a temp dir — a set
// `XDG_DATA_HOME` would overwrite the machine's REAL files. Reads `os.homedir()` on every call (not at
// module load), for the tests.
function dataHome(homeDir = os.homedir()) {
    return path.join(homeDir, '.local', 'share');
}

// --- App root by native / flatpak variant ---
// Inside the sandbox flatpak puts the XDG folders under `~/.var/app/<appId>/{config,data,cache}`; natively
// the same lives under `~/.config` / `~/.local/share` / `~/.cache`, with the SAME `<appName>`. `main.js`
// `loadLaunchers()` loads the added launchers' variants here (`setAppVariants`, flatpak appid → 'native' |
// 'flatpak'); for an unknown (not added) app the EXISTING root decides, flatpak first. Module state in the main
// process — the worker scan gets the root as a parameter, it does not need this.
/** @type {Map<string, 'native'|'flatpak'>} */
let appVariants = new Map();

/** @param {Record<string, string>} map */
function setAppVariants(map) {
    const next = new Map();
    for (const [appId, v] of Object.entries(map || {})) {
        if (v === 'native' || v === 'flatpak') next.set(appId, v);
    }
    appVariants = next;
}

/** @param {string} appId @returns {'native'|'flatpak'|null} */
function appVariant(appId) {
    return appVariants.get(appId) || null;
}

function existsDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch (err) { return false; }
}

// The root of the added variant among the two candidates; for an unknown variant the existing one (flatpak
// first), neither exists → flatpak (the old behavior).
/** @param {string} appId @param {string} flatpakPath @param {string} nativePath */
function pickVariantPath(appId, flatpakPath, nativePath) {
    const v = appVariant(appId);
    if (v === 'native') return nativePath;
    if (v === 'flatpak') return flatpakPath;
    if (existsDir(flatpakPath)) return flatpakPath;
    if (existsDir(nativePath)) return nativePath;
    return flatpakPath;
}

const NATIVE_XDG = { config: ['.config'], data: ['.local', 'share'], cache: ['.cache'] };

// `kind` ∈ 'config' | 'data' | 'cache'. `opts.native` overrides the native root when it deviates from the
// rule (e.g. DuckStation: `config/duckstation` in flatpak, `~/.local/share/duckstation` natively).
/**
 * @param {'config'|'data'|'cache'} kind @param {string} appId @param {string} appName
 * @param {{ homeDir?: string, native?: (homeDir: string) => string }} [opts]
 */
function appRoot(kind, appId, appName, opts = {}) {
    const homeDir = opts.homeDir || os.homedir();
    const flat = path.join(homeDir, '.var', 'app', appId, kind, appName);
    const native = opts.native ? opts.native(homeDir) : path.join(homeDir, ...NATIVE_XDG[kind], appName);
    return pickVariantPath(appId, flat, native);
}

/** @param {string} appId @param {string} appName @param {{ homeDir?: string, native?: (homeDir: string) => string }} [opts] */
const appConfigRoot = (appId, appName, opts) => appRoot('config', appId, appName, opts);
/** @param {string} appId @param {string} appName @param {{ homeDir?: string, native?: (homeDir: string) => string }} [opts] */
const appDataRoot = (appId, appName, opts) => appRoot('data', appId, appName, opts);
/** @param {string} appId @param {string} appName @param {{ homeDir?: string, native?: (homeDir: string) => string }} [opts] */
const appCacheRoot = (appId, appName, opts) => appRoot('cache', appId, appName, opts);

module.exports = {
    flatpakConfigRoot, flatpakDataRoot, flatpakCacheRoot, translateFlatpakDocPath, dataHome,
    setAppVariants, appVariant, pickVariantPath, appConfigRoot, appDataRoot, appCacheRoot,
};
