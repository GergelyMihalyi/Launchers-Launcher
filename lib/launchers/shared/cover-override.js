// @ts-check
'use strict';

// Manual cover override: the user can override a bad / missing cover with an image, with no UI convention, using a folder:
//   ~/Pictures/launchers-launcher/covers/<source>/<id>.(png|jpg|jpeg|webp)   (RetroArch: covers/retroarch/<system>/<title>.png)
// The file name is cleaned per the RetroArch thumbnail rule (`& * / : \` < > ? |` → `_`), matching is case-insensitive.
// The override runs at the main-side IPC boundary (Games lists, Continue/quick-launch bar, favorites), without changing the
// `resolve*Cover`s; the folder tree is cached by a stat signature. Details: docs/dev/games-panel.md#covers

const fs = require('fs');
const os = require('os');
const path = require('path');

const OVERRIDE_EXT_RE = /\.(png|jpe?g|webp)$/i;

function coverOverrideRoot(homeDir = os.homedir()) {
    return path.join(homeDir, 'Pictures', 'launchers-launcher', 'covers');
}

// The file-name base from an id / title (RetroArch's `retroarchThumbnailLabel` rule).
function overrideFileBase(id) {
    return String(id).replace(/[&*/:`<>?\\|]/g, '_');
}

function mapKey(source, base) {
    return `${source}\u0000${base}`.toLowerCase();
}

function mtimeOf(p) {
    try {
        return fs.statSync(p).mtimeMs;
    } catch {
        return null;
    }
}

function subdirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return [];
    }
}

// The (source) folders to override: every `<source>/` directly, and under `retroarch/` one `retroarch/<system>/` per system.
function sourceDirs(root) {
    const out = [];
    for (const name of subdirs(root)) {
        if (name.toLowerCase() === 'retroarch') {
            for (const system of subdirs(path.join(root, name))) {
                out.push({ source: `retroarch/${system}`, dir: path.join(root, name, system) });
            }
        } else {
            out.push({ source: name, dir: path.join(root, name) });
        }
    }
    return out;
}

// root → { sig, map }. `sig` is the mtime of the root + the retroarch folder + every source folder.
const cache = new Map();

function signature(root) {
    const rootM = mtimeOf(root);
    if (rootM === null) return { sig: 'none', dirs: [] };
    const dirs = sourceDirs(root);
    /** @type {Array<string|number|null>} */
    const parts = [rootM, mtimeOf(path.join(root, 'retroarch'))];
    for (const d of dirs) parts.push(d.source, mtimeOf(d.dir));
    return { sig: parts.join('|'), dirs };
}

// The override map (key: source + cleaned, lowercase file-name base → absolute path). Never throws; empty for a missing root.
function loadCoverOverrides(root = coverOverrideRoot()) {
    const { sig, dirs } = signature(root);
    const hit = cache.get(root);
    if (hit && hit.sig === sig) return hit.map;
    const map = new Map();
    for (const { source, dir } of dirs) {
        let files = [];
        try {
            files = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const f of files.sort()) {
            if (!OVERRIDE_EXT_RE.test(f)) continue;
            // The file side is cleaned too: a file named by hand with `:` should match as well.
            const key = mapKey(source, overrideFileBase(f.replace(OVERRIDE_EXT_RE, '')));
            if (!map.has(key)) map.set(key, path.join(dir, f));
        }
    }
    cache.set(root, { sig, map });
    return map;
}

// The override of a specific (source, id), or `null`.
function findCoverOverride(source, id, root = coverOverrideRoot()) {
    if (!source || id == null || id === '') return null;
    return loadCoverOverrides(root).get(mapKey(source, overrideFileBase(id))) || null;
}

// The suggested (PNG) path for a game — the details view shows it to the user.
function coverOverrideSuggestion(source, id, root = coverOverrideRoot()) {
    if (!source || id == null || id === '') return null;
    return path.join(root, ...String(source).split('/'), `${overrideFileBase(id)}.png`);
}

// The (source, id) pair from the `key` of a recent/favorite entry: `retroarch:<system>:<title>`, or `<source>-game-<id>`
// (steam/heroic/lutris + the emulators, see launch-ipc `*Meta` + the `findRecentlyPlayed`s). Unknown shape → `null`.
function overrideTargetForKey(key) {
    const s = String(key || '');
    const ra = s.match(/^retroarch:([^:]+):(.+)$/);
    if (ra) return { source: `retroarch/${ra[1]}`, id: ra[2] };
    const m = s.match(/^([a-z0-9]+)-game-(.+)$/);
    return m ? { source: m[1], id: m[2] } : null;
}

// Overrides the covers of a list. `targetOf(row)` → `{ source, id }` | null. If there is no override at all (the common case), returns
// the INPUT array; otherwise a new array whose overridden rows are copies (the caller's TTL-cached objects stay untouched).
function applyCoverOverrides(rows, targetOf, root = coverOverrideRoot()) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const map = loadCoverOverrides(root);
    if (!map.size) return rows;
    let changed = false;
    const out = rows.map((row) => {
        const t = row && targetOf(row);
        const cover = t && t.id != null && t.id !== '' ? map.get(mapKey(t.source, overrideFileBase(t.id))) : null;
        if (!cover || cover === row.cover) return row;
        changed = true;
        return { ...row, cover };
    });
    return changed ? out : rows;
}

// The recent/favorite entry lists (by `key`).
function applyCoverOverridesToEntries(list, root = coverOverrideRoot()) {
    return applyCoverOverrides(list, (e) => overrideTargetForKey(e.key), root);
}

// --- Picking from the UI ---
// From the Games panel's details view the user picks an image from the usual folders (non-recursive: `~/Pictures/launchers-launcher/`,
// `~/Pictures`, `~/Downloads`); main COPIES the file to the place given by the override convention (`<root>/<source>/<id>.<extension>`),
// replacing an existing override. The original file stays untouched. The renderer only sends a path — main ONLY accepts a direct,
// image-extension regular file of one of the listed folders (via realpath), so the renderer cannot make it copy an arbitrary file.

const fsp = require('fs/promises');

const MAX_COVER_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_COVER_IMAGES = 200;

/** @param {string} home */
function coverPickerDirs(home = os.homedir()) {
    return [path.join(home, 'Pictures', 'launchers-launcher'), path.join(home, 'Pictures'), path.join(home, 'Downloads')];
}

/**
 * The selectable images (image extension, regular file, ≤ 20 MB), newest first, at most 200. Never throws.
 * @param {string} [home]
 * @returns {Promise<Array<{ name: string, path: string, bytes: number, mtimeMs: number }>>}
 */
async function listCoverImages(home = os.homedir()) {
    const out = [];
    for (const dir of coverPickerDirs(home)) {
        let names = [];
        try {
            names = await fsp.readdir(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if (!OVERRIDE_EXT_RE.test(name)) continue;
            const p = path.join(dir, name);
            try {
                const st = await fsp.stat(p);
                if (st.isFile() && st.size > 0 && st.size <= MAX_COVER_IMAGE_BYTES) out.push({ name, path: p, bytes: st.size, mtimeMs: st.mtimeMs });
            } catch { /* deleted meanwhile */ }
        }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_COVER_IMAGES);
}

/** The override (source path parts, file-name base) from the key — or `null` if the key cannot be mapped safely. */
function overrideDestParts(key) {
    const t = overrideTargetForKey(key);
    if (!t || t.id == null || t.id === '') return null;
    const parts = String(t.source).split('/').map((s) => (s.toLowerCase() === 'retroarch' ? 'retroarch' : overrideFileBase(s)));
    if (parts.some((s) => !s || s === '.' || s === '..')) return null;
    const base = overrideFileBase(t.id);
    if (!base || base === '.' || base === '..') return null;
    return { parts, base };
}

/**
 * Sets an image as a cover override.
 * @param {{ key: string, srcPath: string, home?: string, root?: string }} o
 * @returns {Promise<{ ok: boolean, error?: string, dest?: string }>}
 */
async function installCoverOverride({ key, srcPath, home = os.homedir(), root = coverOverrideRoot(home) }) {
    const dest = overrideDestParts(key);
    if (!dest) return { ok: false, error: 'invalid-key' };
    try {
        if (typeof srcPath !== 'string' || !OVERRIDE_EXT_RE.test(srcPath)) return { ok: false, error: 'invalid-image' };
        const real = await fsp.realpath(srcPath);
        const allowed = await Promise.all(coverPickerDirs(home).map((d) => fsp.realpath(d).catch(() => null)));
        if (!allowed.includes(path.dirname(real))) return { ok: false, error: 'not-in-picker-dir' };
        const st = await fsp.stat(real);
        if (!st.isFile() || st.size <= 0 || st.size > MAX_COVER_IMAGE_BYTES) return { ok: false, error: 'invalid-image' };
        const dir = path.join(root, ...dest.parts);
        await fsp.mkdir(dir, { recursive: true });
        await removeVariants(dir, dest.base);
        const ext = path.extname(real).toLowerCase();
        const target = path.join(dir, `${dest.base}${ext}`);
        await fsp.copyFile(real, target);
        return { ok: true, dest: target };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Deletes the override files named `base` (case-insensitive, cleaned) from a folder.
async function removeVariants(dir, base) {
    let removed = 0;
    for (const f of await fsp.readdir(dir).catch(() => [])) {
        if (!OVERRIDE_EXT_RE.test(f)) continue;
        if (overrideFileBase(f.replace(OVERRIDE_EXT_RE, '')).toLowerCase() !== base.toLowerCase()) continue;
        await fsp.rm(path.join(dir, f), { force: true });
        removed++;
    }
    return removed;
}

/** Deletes a game's cover override. @returns {Promise<{ ok: boolean, removed?: number, error?: string }>} */
async function removeCoverOverride({ key, home = os.homedir(), root = coverOverrideRoot(home) }) {
    const dest = overrideDestParts(key);
    if (!dest) return { ok: false, error: 'invalid-key' };
    try {
        return { ok: true, removed: await removeVariants(path.join(root, ...dest.parts), dest.base) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = {
    listCoverImages, installCoverOverride, removeCoverOverride, coverPickerDirs, MAX_COVER_IMAGE_BYTES,
    coverOverrideRoot, overrideFileBase, loadCoverOverrides, findCoverOverride,
    coverOverrideSuggestion, overrideTargetForKey, applyCoverOverrides, applyCoverOverridesToEntries,
};
