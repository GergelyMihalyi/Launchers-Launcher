// @ts-check
'use strict';

// Building the launcher list + the user-editable config keys (customLaunchers, launcherOrder).
// No `BrowserWindow` reference.

// The flatpak helpers (list/install/run/info) live in `lib/flatpak.js`.

const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const { execFileAsync } = require('./exec.js');
const flatpak = require('./flatpak.js');
const { isUserIconUrl } = require('./apps/app-icons.js');

function isValidLauncher(obj) {
    return obj && typeof obj === 'object'
        && typeof obj.id === 'string' && obj.id
        && typeof obj.name === 'string' && obj.name
        && typeof obj.cmd === 'string' && obj.cmd
        && Array.isArray(obj.args) && obj.args.every((a) => typeof a === 'string');
}

// Optional per-launcher accent color: if present it must be `#rrggbb` — otherwise it is ignored
// (best effort, like hint/icon).
const ACCENT_RE = /^#[0-9a-f]{6}$/i;
function isAccentColor(v) {
    return typeof v === 'string' && ACCENT_RE.test(v);
}

function readCustomLaunchers() {
    const parsed = config.get('customLaunchers', []);
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter(isValidLauncher)
        .map((l) => ({
            id: l.id, name: l.name, hint: l.hint || '', icon: l.icon || '',
            cmd: l.cmd, args: l.args, custom: true,
            ...(isAccentColor(l.accent) ? { accent: l.accent } : {}),
        }));
}

function writeCustomLaunchers(list) {
    config.set('customLaunchers', list);
}

function readLauncherOrder() {
    const parsed = config.get('launcherOrder', []);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
}

function writeLauncherOrder(ids) {
    config.set('launcherOrder', ids);
}

// Orders the `raw` array by the id list; launchers missing from the list are appended in their original
// order; unknown ids are dropped. Always a fresh array (`raw` is not mutated).
function orderLaunchers(ids, raw) {
    const byId = new Map(raw.map((l) => [l.id, l]));
    const ordered = [];
    for (const id of ids) {
        if (byId.has(id)) {
            ordered.push(byId.get(id));
            byId.delete(id);
        }
    }
    for (const l of raw) {
        if (byId.has(l.id)) ordered.push(l);
    }
    return ordered;
}

// Per-launcher accent override (`launcherAccents` config key): the `{ id: '#rrggbb' }` map written by the
// `set-launcher-accent` IPC overrides the launcher's `accent` field. Invalid hex / non-string → that id is
// skipped (the launcher keeps its own value / the global --accent). Fresh array, no mutation.
function applyAccentOverrides(list, accents) {
    if (!accents || typeof accents !== 'object') return list.map((l) => ({ ...l }));
    return list.map((l) => {
        const ov = accents[l.id];
        return isAccentColor(ov) ? { ...l, accent: ov } : { ...l };
    });
}

// Core of the v1 → v2 migration: appends the 3 old built-ins (`steam`/`heroic`/`retroarch`) to `customList`
// as catalog copies — skipping the ones already present AND those in `disabledIds` (if an intermediate
// version wrote `disabledBuiltins`). Fresh array. Called by `main.js` once for an existing install (`setupDone: true`).
function seedBuiltinCustomLaunchers(customList, catalog, disabledIds = []) {
    const off = new Set(Array.isArray(disabledIds) ? disabledIds : []);
    const have = new Set((customList || []).map((l) => l.id));
    const out = [...(customList || [])];
    for (const id of ['steam', 'heroic', 'retroarch']) {
        if (have.has(id) || off.has(id)) continue;
        const e = (catalog || []).find((c) => c.id === id);
        if (!e) continue;
        // The v1 built-in Steam was native → for the dual-variant entry take the native form
        // (if the machine only has the flatpak, the startup self-repair rewrites it).
        const spec = isDualCatalogEntry(e) ? variantSpec(e, 'native') : { cmd: e.cmd, args: e.args };
        out.push({
            id: e.id, name: e.name, hint: e.hint || '', icon: e.icon || '',
            cmd: spec.cmd, args: spec.args, custom: true,
            ...(isAccentColor(e.accent) ? { accent: e.accent } : {}),
        });
    }
    return out;
}

// Orchestrates the v1 → v2 migration: for an existing install (`setupDone: true`, no `_launcherModelV2` marker) copies the 3 old
// built-ins (steam/heroic/retroarch) into `customLaunchers`; fresh install → only the marker. `main.js` calls it BEFORE its own
// logger exists, hence `logInfo`/`logError` default to `console.log`/`console.error`.
function migrateBuiltinLaunchers(catalog, { logInfo = console.log, logError = console.error } = {}) {
    try {
        if (config.get('_launcherModelV2', false) === true) return { migrated: false };
        const done = config.get('setupDone', false) === true;
        if (!done) { config.set('_launcherModelV2', true); return { migrated: false }; }
        const disabled = (config.get('disabledBuiltins', []) || []).filter((x) => typeof x === 'string');
        const prev = readCustomLaunchers();
        const next = seedBuiltinCustomLaunchers(prev, catalog, disabled);
        if (next.length !== prev.length) writeCustomLaunchers(next);
        config.set('_launcherModelV2', true);
        const added = next.length - prev.length;
        logInfo(`[migrate] launcher-model-v2: ${added} built-in launchers copied`);
        return { migrated: true, added };
    } catch (err) {
        logError(`[migrate] launcher-model-v2 error: ${err.message}`);
        return { migrated: false, error: err.message };
    }
}

// Matches the flatpak appid (the `args` item after `run`) against the catalog: if a manually added /
// browsed launcher's appid is in the catalog, returns that entry — the caller (`add-launcher`) takes its
// `name`/`hint`/`icon`/`accent` instead of the generic flatpak metadata. Non-flatpak / no match → null.
function matchCatalogEntry(entry, catalog) {
    if (!entry || entry.cmd !== 'flatpak' || !Array.isArray(catalog)) return null;
    const appId = flatpak.flatpakRunAppId(entry.args);
    if (!appId) return null;
    return catalog.find((c) => flatpak.flatpakRunAppId(c.args) === appId) || null;
}

// Strict check of the `add-launcher` object payload (security): the renderer's `{ cmd, args }` runs via `spawn`, so three shapes
// are accepted: `flatpak` (`flatpak run <appid> [args]`, no flatpak option between `run` and the appid), `native` (the `nativeCmd`
// of a catalog entry) and `custom` (a plain command name/absolute path, NOT a shell/interpreter/wrapper — `bash`, `python`, `env`,
// `sudo` —; the caller checks it exists with `which`). Hand edits of `config.json` are deliberately NOT filtered.
// Background: docs/dev/config-keys.md#launchers
const FLATPAK_APP_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*){2,}$/;
const CUSTOM_CMD_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._+-]*|\/[A-Za-z0-9._+\/ -]+)$/;
// The renderer generates `custom-<≤60 char slug>[-N]` / `flatpak-<appid-slug>` ids — leave plenty of room.
const LAUNCHER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const ICON_PATH_RE = /^assets\/icons\/[A-Za-z0-9._-]+\.(?:png|svg)$/;
const FORBIDDEN_CUSTOM_CMDS = new Set([
    'sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'mksh', 'csh', 'tcsh', 'busybox',
    'env', 'sudo', 'doas', 'pkexec', 'su', 'runuser', 'setsid', 'nohup', 'nice', 'ionice',
    'timeout', 'stdbuf', 'xargs', 'script', 'systemd-run', 'flatpak-spawn', 'exec', 'eval',
    'node', 'nodejs', 'deno', 'bun', 'npx', 'perl', 'ruby', 'php', 'luajit', 'tclsh', 'wish',
    'awk', 'gawk', 'mawk', 'nawk', 'expect', 'ssh', 'curl', 'wget', 'nc', 'ncat', 'socat',
]);
// Versioned interpreter names (`python3`, `python3.12`, `perl5`, `lua5.4`, `php8`).
const FORBIDDEN_CUSTOM_CMD_RE = /^(?:python|perl|php|lua|ruby)[0-9.]*$/;

function isForbiddenCustomCmd(cmd) {
    const base = cmd.slice(cmd.lastIndexOf('/') + 1);
    return FORBIDDEN_CUSTOM_CMDS.has(base) || FORBIDDEN_CUSTOM_CMD_RE.test(base);
}

// Pure (no I/O) classification → `{ ok: true, kind, entry }` (`entry` is the normalized, storable entry)
// or `{ ok: false, reason }`. The existence check of the `custom` branch is the caller's job.
/** @param {any} payload @param {Array<any>} catalog */
function checkLauncherPayload(payload, catalog) {
    if (!isValidLauncher(payload)) return { ok: false, reason: 'invalid schema' };
    if (!LAUNCHER_ID_RE.test(payload.id)) return { ok: false, reason: 'invalid id' };
    const { cmd, args } = payload;
    const entry = {
        id: payload.id,
        name: payload.name.slice(0, 80),
        hint: typeof payload.hint === 'string' ? payload.hint.slice(0, 120) : '',
        // Built-in icon (`assets/icons/…`) OR a `file://` URL imported into the launcher's own icon folder
        // (the "+ Add launcher" wizard, lib/apps/app-icons.js) — nothing else.
        icon: typeof payload.icon === 'string' && (ICON_PATH_RE.test(payload.icon) || isUserIconUrl(payload.icon))
            ? payload.icon : '',
        cmd, args: args.slice(),
        ...(isAccentColor(payload.accent) ? { accent: payload.accent } : {}),
    };
    if (cmd === 'flatpak') {
        if (args[0] !== 'run' || !FLATPAK_APP_ID_RE.test(args[1] || '')) {
            return { ok: false, reason: 'only the `flatpak run <appid>` form is allowed' };
        }
        return { ok: true, kind: 'flatpak', entry };
    }
    // Native catalog variant: no arguments, OR exactly the entry's `nativeArgs`
    // (Steam: `-gamepadui -tenfoot`) — no other argument may slip in.
    const catalogNative = Array.isArray(catalog) && catalog.some((c) => c && nativeCmdsOf(c).includes(cmd)
        && (args.length === 0 || sameArgs(args, nativeArgsOf(c))));
    if (catalogNative) return { ok: true, kind: 'native', entry };
    if (!CUSTOM_CMD_RE.test(cmd)) return { ok: false, reason: 'invalid command name' };
    if (isForbiddenCustomCmd(cmd)) return { ok: false, reason: `tiltott parancs (shell/interpreter/wrapper): ${cmd}` };
    return { ok: true, kind: 'custom', entry };
}

function sameArgs(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

// --- Native / flatpak variant (dual-variant catalog entry) ---
// Dual-variant = flatpak `cmd` + `nativeCmd` (+ optional `nativeArgs`). `nativeCmd` is a string OR a
// candidate list (the binary name differs per distro: `["pcsx2-qt", "pcsx2"]`) — detection takes the first
// one on PATH. The variant of an added launcher is read from its `cmd`; an entry that does not match the
// catalog shape (edited by hand) is `null` — it is never rewritten.

// The manually set native path (`launcherPaths[id]`) is the VERY FIRST candidate — so detection, variant
// recognition and the payload gate handle it unchanged, and it takes precedence over PATH.
/** @param {any} e @returns {string[]} */
function nativeCmdsOf(e) {
    const n = e && e.nativeCmd;
    const list = Array.isArray(n) ? n : [n];
    const manual = e && typeof e.id === 'string' ? readLauncherPaths()[e.id] : null;
    return [...(manual ? [manual] : []), ...list.filter((c) => typeof c === 'string' && c)];
}

// --- Manually set native launcher (`launcherPaths` config key) ---

/** @returns {Record<string, string>} */
function readLauncherPaths() {
    const raw = config.get('launcherPaths', {});
    /** @type {Record<string, string>} */
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, p] of Object.entries(raw)) {
        if (typeof p === 'string' && path.isAbsolute(p)) out[id] = p;
    }
    return out;
}

/** @param {string} id @param {string|null} filePath */
function writeLauncherPath(id, filePath) {
    const map = { ...readLauncherPaths() };
    if (filePath) map[id] = filePath;
    else delete map[id];
    config.set('launcherPaths', map);
}

// Is a manual native path acceptable: absolute, existing, executable REGULAR file that is not a
// shell/interpreter (the "Custom command" gate). `{ ok, reason? }`.
/** @param {any} filePath */
function checkLauncherExecutable(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { ok: false, reason: 'not an absolute path' };
    let st;
    try { st = fs.statSync(filePath); } catch (err) { return { ok: false, reason: 'does not exist' }; }
    if (!st.isFile()) return { ok: false, reason: 'not a file' };
    if (!(st.mode & 0o111)) return { ok: false, reason: 'not executable' };
    if (isForbiddenCustomCmd(filePath)) return { ok: false, reason: 'tiltott parancs (shell/interpreter/wrapper)' };
    return { ok: true };
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Candidates for the catalog entry's program in the chosen folder (and one level below): an executable
// matching the `nativeCmd` name (case-insensitive), or a `*.AppImage` whose name contains the id / name.
// If nothing matches by name, ALL executables of the folder (`guess: true`) — the user picks. Order:
// exact name → AppImage (newer version first) → rest. At most `limit` items; never throws.
/** @param {string} dir @param {any} entry @param {number} [limit] */
function findLauncherExecutables(dir, entry, limit = 20) {
    const names = new Set(nativeCmdsOf({ nativeCmd: entry && entry.nativeCmd }).map((c) => c.toLowerCase()));
    const keys = [normName(entry && entry.id), normName(entry && entry.name)].filter(Boolean);
    /** @type {Array<{ path: string, name: string, rank: number }>} */
    const found = [];
    const scan = (d, depth) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { return; }
        for (const ent of ents) {
            if (ent.name.startsWith('.')) continue;
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) {
                if (depth > 0) scan(full, depth - 1);
                continue;
            }
            if (!checkLauncherExecutable(full).ok) continue;
            const lower = ent.name.toLowerCase();
            let rank = 3;
            if (names.has(lower)) rank = 0;
            else if (lower.endsWith('.appimage') && keys.some((k) => normName(ent.name).includes(k))) rank = 1;
            found.push({ path: full, name: path.relative(dir, full), rank });
        }
    };
    scan(dir, 1);
    const named = found.filter((f) => f.rank < 3);
    const list = (named.length ? named : found.filter((f) => path.dirname(f.path) === path.resolve(dir)))
        .sort((a, b) => a.rank - b.rank
            || (a.rank === 1 ? b.name.localeCompare(a.name, undefined, { numeric: true }) : a.name.localeCompare(b.name)));
    return {
        guess: !named.length,
        items: list.slice(0, limit).map(({ path: p, name }) => ({ path: p, name })),
    };
}

/** @param {any} e */
function isDualCatalogEntry(e) {
    return !!(e && e.cmd === 'flatpak' && nativeCmdsOf(e).length);
}

/** @param {any} e */
function nativeArgsOf(e) {
    return Array.isArray(e && e.nativeArgs) ? e.nativeArgs : [];
}

// `{ cmd, args }` of the given variant of a catalog entry. For native, `nativeCmd` is the detected binary
// (`detectLauncherInstall`), or the first candidate if none.
/** @param {any} e @param {'native'|'flatpak'} variant @param {string|null} [nativeCmd] */
function variantSpec(e, variant, nativeCmd) {
    return variant === 'native'
        ? { cmd: nativeCmd || nativeCmdsOf(e)[0], args: nativeArgsOf(e).slice() }
        : { cmd: e.cmd, args: e.args.slice() };
}

// Which variant of the catalog entry an added launcher is: 'native' | 'flatpak' | null.
/** @param {any} launcher @param {any} e */
function launcherVariantOf(launcher, e) {
    if (!launcher || !isDualCatalogEntry(e)) return null;
    if (nativeCmdsOf(e).includes(launcher.cmd)) return 'native';
    if (launcher.cmd === 'flatpak'
        && flatpak.flatpakRunAppId(launcher.args) === flatpak.catalogAppId(e)) return 'flatpak';
    return null;
}

// Detected install (`isLauncherInstalled`) + the user's request → the variant to add. Only one present →
// that one; both → the requested one, flatpak by default (recommended); neither → the catalog default
// (flatpak). The user's request only counts for `'both'`.
/** @param {any} installed @param {any} [requested] @returns {'native'|'flatpak'} */
function pickLauncherVariant(installed, requested) {
    if (installed === 'native') return 'native';
    if (installed === 'both' && requested === 'native') return 'native';
    return 'flatpak';
}

// Startup self-repair plan: for active dual-variant catalog launchers whose added variant is NOT on the
// machine but the other one IS → `{ id, from, to }`. Both / neither / unknown detection / hand-edited entry
// → nothing to do. Pure (the caller supplies the detection).
/** @param {Array<any>} list @param {Array<any>} catalog @param {Record<string, any>} installedById */
function planVariantRepairs(list, catalog, installedById) {
    const out = [];
    for (const l of list || []) {
        const e = (catalog || []).find((c) => c && c.id === l.id);
        const cur = launcherVariantOf(l, e);
        if (!cur) continue;
        const inst = installedById ? installedById[l.id] : undefined;
        if (inst === 'native' && cur === 'flatpak') out.push({ id: l.id, from: cur, to: 'native' });
        if (inst === 'flatpak' && cur === 'native') out.push({ id: l.id, from: cur, to: 'flatpak' });
    }
    return out;
}

// The flatpak-appid → variant map of the added launchers (for `lib/xdg.js` `setAppVariants`): tells the
// library modules whether to read the native (`~/.config/<app>`) or the flatpak (`~/.var/app/<id>/…`) data
// root. Only the catalog's dual-variant entries.
/** @param {Array<any>} list @param {Array<any>} catalog @returns {Record<string, 'native'|'flatpak'>} */
function appVariantsFromLaunchers(list, catalog) {
    /** @type {Record<string, 'native'|'flatpak'>} */
    const out = {};
    for (const l of list || []) {
        const e = (catalog || []).find((c) => c && c.id === l.id);
        const v = launcherVariantOf(l, e);
        if (v) out[flatpak.catalogAppId(e)] = v;
    }
    return out;
}

// The reported state from two bool detection results ('native present?', 'flatpak present?') — a pure
// helper so the `'both'` logic is testable without mocks (isLauncherInstalled itself makes live
// `which`/`flatpak info` calls).
function combineInstallState(native, viaFlatpak) {
    if (native && viaFlatpak) return 'both';
    if (native) return 'native';
    if (viaFlatpak) return 'flatpak';
    return false;
}

async function commandExists(cmd) {
    try {
        await execFileAsync('which', [cmd], { timeout: flatpak.FLATPAK_QUERY_TIMEOUT_MS });
        return true;
    } catch (err) {
        return false;
    }
}

// Install detection of a catalog entry (best effort). Single-variant entry (flatpak `cmd` → `flatpak info`, otherwise
// `which cmd`) → bool; an optional `nativeCmd` makes it DUAL → `'native'|'flatpak'|'both'|false`, so the caller can decide
// whether to offer a flatpak install or a variant picker.
async function isLauncherInstalled(entry) {
    return (await detectLauncherInstall(entry)).installed;
}

// The first native candidate on PATH, or null.
/** @param {any} entry @returns {Promise<string|null>} */
async function findNativeCmd(entry) {
    for (const cmd of nativeCmdsOf(entry)) {
        if (await commandExists(cmd)) return cmd;
    }
    return null;
}

// Like `isLauncherInstalled`, plus for a dual-variant entry the name of the native binary found
// (`nativeCmd`, for adding) — `{ installed, nativeCmd }`.
/** @param {any} entry @returns {Promise<{ installed: any, nativeCmd: string|null }>} */
async function detectLauncherInstall(entry) {
    if (isDualCatalogEntry(entry)) {
        const [viaFlatpak, nativeCmd] = await Promise.all([
            flatpak.flatpakAppInstalled(flatpak.catalogAppId(entry)),
            findNativeCmd(entry),
        ]);
        return { installed: combineInstallState(!!nativeCmd, viaFlatpak), nativeCmd };
    }
    const installed = entry.cmd === 'flatpak'
        ? await flatpak.flatpakAppInstalled(flatpak.catalogAppId(entry))
        : await commandExists(entry.cmd);
    return { installed, nativeCmd: null };
}

module.exports = {
    isValidLauncher, isAccentColor, readCustomLaunchers, writeCustomLaunchers,
    readLauncherOrder, writeLauncherOrder, orderLaunchers, isLauncherInstalled,
    applyAccentOverrides, matchCatalogEntry, seedBuiltinCustomLaunchers, migrateBuiltinLaunchers,
    combineInstallState, checkLauncherPayload, commandExists,
    isDualCatalogEntry, nativeCmdsOf, variantSpec, launcherVariantOf, pickLauncherVariant, planVariantRepairs,
    appVariantsFromLaunchers, detectLauncherInstall,
    readLauncherPaths, writeLauncherPath, checkLauncherExecutable, findLauncherExecutables,
};
