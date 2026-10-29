// @ts-check
'use strict';

// Unified machine-specific config store: ONE `~/.config/launchers-launcher/config.json`, per key. Every `get`/`set`/`patch` reflects the
// CURRENT disk state (cached by a stat signature, a hand edit shows up immediately); `get` returns a DEEP COPY (`structuredClone`);
// writes are atomic (temp + rename). Background: docs/dev/infrastructure.md#config-store

const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeFileAtomic } = require('./fs-atomic.js');

const CONFIG_DIR = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'launchers-launcher',
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Old machine-specific root files -> config.json key. migrateFromLegacy() reads them once; the caller
// passes `rootDir` (main.js: `__dirname`) so the module is testable with a temp root.
const LEGACY_FILES = {
    theme: 'theme-config.json',
    display: 'display-config.json',
    launcherOrder: 'launcher-order.json',
    customLaunchers: 'launchers-custom.json',
};

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return undefined; // no file / invalid JSON -> the caller uses its fallback
    }
}

// Disk signature of config.json — `null` if the file does not exist / cannot be stat'ed. The inode
// tells a temp+rename write apart, the (ns-precision) ctime an in-place overwrite.
function fileSig() {
    try {
        const st = fs.statSync(CONFIG_FILE);
        return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch (err) {
        return null;
    }
}

/** @type {{ sig: string, data: Record<string, any> } | null} */
let cache = null;

// The parsed root object (NOT a copy — module-internal only).
function readCached() {
    const sig = fileSig();
    if (sig === null) {
        cache = null;
        return {};
    }
    if (cache && cache.sig === sig) return cache.data;
    const parsed = readJsonFile(CONFIG_FILE);
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    cache = { sig, data };
    return data;
}

function readAll() {
    return structuredClone(readCached());
}

// temp + rename: rename is atomic on the same filesystem, so an interrupted write (crash / exit)
// cannot leave a half-written config.json. After writing, the cache is set to the state just
// written (the next `get` does not reread the disk).
function writeAll(all) {
    writeFileAtomic(CONFIG_FILE, JSON.stringify(all, null, 2) + '\n', { fsync: true });
    const sig = fileSig();
    cache = sig ? { sig, data: structuredClone(all) } : null;
}

// `fallback` is returned when the key is not set (missing file/key) — for invalid JSON
// readCached() already returns an empty object, which ends up here too.
function get(key, fallback) {
    const all = readCached();
    return Object.prototype.hasOwnProperty.call(all, key) ? structuredClone(all[key]) : fallback;
}

// Writing a known key is checked against `KEY_TYPES`: a value of the wrong type must not reach the file
// — the next startup `normalizeConfig()` would silently drop it (data loss, with the cause no longer
// visible). Throws (`TypeError`); the callers' best-effort branches log it. Unknown keys: free.
function assertKeyType(key, value) {
    const kind = Object.prototype.hasOwnProperty.call(KEY_TYPES, key) ? KEY_TYPES[key] : null;
    if (kind && !matchesKeyType(value, kind)) {
        const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        throw new TypeError(`config.set: the type of key "${key}" is ${kind}, got: ${got}`);
    }
}

// Full replace.
function set(key, value) {
    assertKeyType(key, value);
    const all = readAll();
    all[key] = value;
    writeAll(all);
    return value;
}

// Field-level merge into an object key.
function patch(key, partial) {
    const all = readAll();
    const current = all[key] && typeof all[key] === 'object' && !Array.isArray(all[key])
        ? all[key] : {};
    const next = { ...current, ...partial };
    assertKeyType(key, next);
    all[key] = next;
    writeAll(all);
    return next;
}

// Call once at startup (sync, may run before app.whenReady). If config.json already exists, there is
// nothing to do. If not, but `rootDir` has old root JSONs, builds + writes config.json from them (the
// old files are NOT deleted - defensive). In a fresh clone (neither config.json nor old files) it
// creates an empty config.json so the migration does not run again on the next start.
function migrateFromLegacy(rootDir) {
    if (fs.existsSync(CONFIG_FILE)) return { migrated: false };

    const out = {};
    const files = [];
    for (const [key, fname] of Object.entries(LEGACY_FILES)) {
        const parsed = readJsonFile(path.join(rootDir, fname));
        if (parsed !== undefined) {
            out[key] = parsed;
            files.push(fname);
        }
    }
    if (files.length) {
        out._migratedFrom = { files, at: new Date().toISOString() };
    }
    writeAll(out);
    return files.length ? { migrated: true, files } : { migrated: false };
}

// If config.json EXISTS but is not a valid JSON object (hand-broken, half-written, empty), it is
// moved aside to `config.json.corrupt-<ts>` and we start clean — the launcher must not get stuck on
// a broken file (`get` would fall back anyway, but the first `set` would overwrite the junk; the
// backup stays for manual recovery). Call once at startup, BEFORE `migrateFromLegacy()` (so that one
// sees the missing file and writes a new one).
function recoverCorruptConfig() {
    let raw;
    try {
        raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    } catch (err) {
        return { recovered: false }; // no file -> nothing to do
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = undefined; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { recovered: false }; // intact
    }
    const backup = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    try {
        fs.renameSync(CONFIG_FILE, backup);
        return { recovered: true, backup };
    } catch (err) {
        return { recovered: false, error: err.message };
    }
}

// ---------------------------------------------------------------------------
// Per-key schema normalization
// ---------------------------------------------------------------------------

// Top-level type of the known config keys. `normalizeConfig()` filters on these at startup (AFTER
// `recoverCorruptConfig` + `migrateFromLegacy`): a KNOWN key of the wrong type (e.g. `display` a string,
// `launcherOrder` an object — a hand-made mistake) is dropped and its reader falls back to its default.
// Every other key and EVERY unknown key (`_migratedFrom` marker, future keys) stays untouched — this is
// only a top-level type filter; value-level validation (theme whitelist, does the sink exist,
// `language` ∈ {hu,en}) stays with the readers (`lib/prefs.js` etc.).
const KEY_TYPES = {
    theme: 'object',
    display: 'object',
    launcherOrder: 'array',
    customLaunchers: 'array',
    launcherAccents: 'object', // { "<launcher id>": "#rrggbb" } accent color override
    launcherPaths: 'object', // { "<catalog id>": "<absolute path of the executable>" } — manually set native launcher
    feedback: 'object',
    mainController: 'object-or-null', // null = "any controller" (valid)
    tvMode: 'object',
    usage: 'object',
    recentGames: 'object',
    favoriteGames: 'array', // pinned games in the Games panel
    language: 'string',
    uiScale: 'string',
    background: 'object', // PER-THEME map: { "<themeId>": { type: 'none'|'builtin'|'custom', id?, path? } }
    pendingChangelog: 'string', // written by apply-update, cleared by the "What's new" panel
    gpuFallback: 'object-or-null', // { signature, status, at } — the GPU did not start on this machine → software rendering (lib/gpu-fallback.js)
    pendingUpdateRollback: 'object-or-null', // { fromSha, appliedAt }, written by apply-update, cleared by a healthy start / the bootstrap.js rollback
    setupDone: 'boolean',
    controllerAutostart: 'boolean', // false = a controller connection does not start the launcher (lib/sidecars/autostart.js sidecar)
    alwaysOnTop: 'boolean', // false = the foreground guard (lib/launch/foreground-guard.js) does not take the focus back
    startWithSystem: 'boolean', // true = XDG autostart entry that opens the launcher window at login (lib/sidecars/xdg-autostart.js)
    disabledBuiltins: 'array', // written by an intermediate (pre v1→v2 migration) version — respected by migrateBuiltinLaunchers
    configVersion: 'number', // the schema version (lib/config-migrations.js)
    _launcherModelV2: 'boolean', // one-off marker of the launcher-model-v2 migration (lib/launcher-list.js)
    customGameSources: 'array', // custom ROM-folder sources for added launchers (lib/launchers/custom-roms-library.js)
    melondsRomDirs: 'array', // ROM folder list for the melonDS scan (Settings → Launchers → "melonDS ROM folders") — see lib/launchers/melonds-library.js
    coverDownload: 'boolean', // false = automatic network download of missing covers is off (already downloaded ones stay)
    gamesHiddenSources: 'array', // source ids excluded from the Games panel's ALL view (Square button -> filter popup)
    playtimeReminder: 'number', // playtime reminder: notifies on return after this many hours of play a day (0 = off)
    playtimeToday: 'object', // { date, ms } — today's playtime from sessions launched by the launcher
    gamesFirstSeen: 'object', // { "<game-key>": <ms> } — "first seen" (NEW badge, "recently added" sort; lib/recent/games-first-seen.js)
    gamesFirstSeenBase: 'number', // time of the first check (ms)
    gameLaunchOptions: 'object', // { "<game-key>": "NAME=value --arg" } — per-game launch options (lib/launch/launch-options.js)
    seenTips: 'array', // ["<tip-id>"] — first-use tips already shown
    flatpakGrants: 'array', // [{ appId, path, at }] — record of the flatpak permissions granted by the launcher
    hiddenGames: 'array', // ["<favorite-key>"] — games hidden one by one from the Games panel
    gamesSortMode: 'object', // { "<source-id|all>": "name"|"recent"|"playtime"|"added" } — Games panel sort order per source (R3)
    gamesViewMode: 'object', // { "<source-id>": "grid"|"list" } — Games panel grid/list view per source (ALL + every launcher separately)
    recentGamesUi: 'object', // { continueBar, gamesPanelRecent, launcherRecent } — toggles of the 3 "recently played" bars
    saveBackup: 'object', // { dir, auto } — target folder of the game save backups (default: ~/launchers-launcher-saves) — see lib/ipc/saves-ipc.js
    // the whitelists (allowed values) live in lib/prefs.js
    idleTimeout: 'number', // screensaver in minutes (0 = off)
    volumeStep: 'number', // L1/R1 volume step in %
    volumeMax: 'number', // cap of the launcher's volume buttons in % (100 = none)
    doNotDisturb: 'boolean', // false = do-not-disturb (kde-inhibit) while playing is off
    tvExitHold: 'number', // how long ○ must be held to exit TV mode, in seconds
    // the whitelist is in lib/prefs.js
    screenDim: 'number', // software dimming of the launcher window in % (0 = full brightness)
    nightMode: 'number', // warm color filter: 0 = off, 1 = mild, 2 = strong
    autoSuspend: 'number', // auto-suspend after this many minutes of an idle launcher (0 = off)
    idleDisconnect: 'number', // disconnect the BT controllers after this many idle minutes (0 = off)
};

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function matchesKeyType(value, kind) {
    switch (kind) {
        case 'object': return isPlainObject(value);
        case 'object-or-null': return value === null || isPlainObject(value);
        case 'array': return Array.isArray(value);
        case 'string': return typeof value === 'string';
        case 'boolean': return typeof value === 'boolean';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        default: return true;
    }
}

// Pure (no I/O): drops the KNOWN keys of the wrong type from the raw config object.
// -> { config: <fresh object without the bad keys>, dropped: [key names] }.
function normalizeConfigObject(raw) {
    const out = { ...raw };
    const dropped = [];
    for (const [key, kind] of Object.entries(KEY_TYPES)) {
        if (Object.prototype.hasOwnProperty.call(out, key) && !matchesKeyType(out[key], kind)) {
            delete out[key];
            dropped.push(key);
        }
    }
    return { config: out, dropped };
}

// Once at startup, AFTER `recoverCorruptConfig()` + `migrateFromLegacy()`: filters the known keys against `KEY_TYPES` and
// writes the file back if anything was dropped. `lenient: true` (the config carries a NEWER code's schema): drops NOTHING, only reports (`kept`).
function normalizeConfig({ lenient = false } = {}) {
    const raw = readJsonFile(CONFIG_FILE);
    if (!isPlainObject(raw)) return { normalized: false, dropped: [], kept: [] };
    const { config: cleaned, dropped } = normalizeConfigObject(raw);
    if (!dropped.length) return { normalized: false, dropped: [], kept: [] };
    if (lenient) return { normalized: false, dropped: [], kept: dropped };
    writeAll(cleaned);
    return { normalized: true, dropped, kept: [] };
}

// ---------------------------------------------------------------------------
// Daily snapshot + restore
// ---------------------------------------------------------------------------

// `recoverCorruptConfig` only handles CORRUPT JSON; this is the safety net against a logically wrong
// but valid change (wrong monitor, deleted launchers): at most one `config.json.bak-YYYY-MM-DD` copy per
// day at startup (the latest `BACKUP_KEEP` are kept); the Settings → System → "Settings backups" subview
// restores from them. BEFORE a restore the current state goes to `config.json.pre-restore` (a one-step
// "undo" — also listed).
const BACKUP_KEEP = 5;
const BACKUP_RE = /^config\.json\.bak-(\d{4}-\d{2}-\d{2})$/;
const PRE_RESTORE_NAME = 'config.json.pre-restore';

function localDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function backupNames() {
    try {
        return fs.readdirSync(CONFIG_DIR).filter((n) => BACKUP_RE.test(n)).sort().reverse();
    } catch (err) {
        return [];
    }
}

// Once at startup (AFTER `normalizeConfig` — only an intact, normalized state is backed up). Does not
// write if: there is no config.json / it is not an object, there is already a backup today, or the latest
// backup is byte-identical (so the `keep` backups really hold DIFFERENT states). Never throws — a backup
// error must not stop the startup.
function backupDaily({ keep = BACKUP_KEEP, now = new Date() } = {}) {
    try {
        let raw;
        try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (err) { return { created: false }; }
        if (!isPlainObject(readJsonFile(CONFIG_FILE))) return { created: false };
        const name = `config.json.bak-${localDate(now)}`;
        const existing = backupNames();
        let created = false;
        if (!existing.includes(name)) {
            const newest = existing[0];
            const same = newest && fs.readFileSync(path.join(CONFIG_DIR, newest), 'utf8') === raw;
            if (!same) {
                writeFileAtomic(path.join(CONFIG_DIR, name), raw);
                created = true;
            }
        }
        const pruned = [];
        for (const old of backupNames().slice(Math.max(1, keep))) {
            fs.rmSync(path.join(CONFIG_DIR, old), { force: true });
            pruned.push(old);
        }
        return created ? { created: true, name, pruned } : { created: false, pruned };
    } catch (err) {
        return { created: false, error: err.message };
    }
}

// The restorable backups, newest first; the `pre-restore` (if any) at the top.
// `{ name, kind: 'daily'|'pre-restore', date, mtimeMs, size }`.
function listBackups() {
    const out = [];
    const stat = (name) => {
        try { return fs.statSync(path.join(CONFIG_DIR, name)); } catch (err) { return null; }
    };
    const pre = stat(PRE_RESTORE_NAME);
    if (pre) {
        out.push({ name: PRE_RESTORE_NAME, kind: 'pre-restore', date: localDate(new Date(pre.mtimeMs)), mtimeMs: pre.mtimeMs, size: pre.size });
    }
    for (const name of backupNames()) {
        const st = stat(name);
        if (!st) continue;
        out.push({ name, kind: 'daily', date: name.match(BACKUP_RE)[1], mtimeMs: st.mtimeMs, size: st.size });
    }
    return out;
}

// Only a file name known to `listBackups()` is accepted (no path traversal). The backup content must be
// an intact JSON object; the current config goes to `pre-restore`. After a successful restore the caller
// relaunches the launcher — the in-memory state (launcher list, theme, sidecars) is rebuilt from the
// restored config.
function restoreBackup(name) {
    if (typeof name !== 'string' || !(BACKUP_RE.test(name) || name === PRE_RESTORE_NAME)) {
        return { ok: false, error: 'unknown backup' };
    }
    const src = path.join(CONFIG_DIR, name);
    let raw;
    try { raw = fs.readFileSync(src, 'utf8'); } catch (err) { return { ok: false, error: 'the backup is not readable' }; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = undefined; }
    if (!isPlainObject(parsed)) return { ok: false, error: 'the backup is not a valid JSON object' };
    try {
        let current = null;
        try { current = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (err) { /* nothing to set aside */ }
        // When restoring the pre-restore onto itself, do not overwrite the source with the present
        // FIRST — the present state is still set aside, but only after the source has been read.
        if (current !== null) writeFileAtomic(path.join(CONFIG_DIR, PRE_RESTORE_NAME), current);
        writeAll(parsed);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = {
    get, set, patch, migrateFromLegacy, recoverCorruptConfig,
    normalizeConfig, normalizeConfigObject, KEY_TYPES, CONFIG_FILE,
    backupDaily, listBackups, restoreBackup, BACKUP_KEEP,
};
