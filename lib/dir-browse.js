// @ts-check
// Backend of the controller-driven folder browser: a generic, non-launcher-specific directory lister for
// the `melondsRomDirs` config key (and any similar "pick a folder" setting). The launcher process is NOT
// sandboxed (unlike the flatpak launchers), so any host path is readable directly — no document-portal
// translation as in the `translateFlatpakDocPath` modules.

const fs = require('fs');
const path = require('path');

// --- ROM-folder walking: junk files + symlinks ---

// Entries left on shares / removable drives by other systems: macOS `._<name>` "AppleDouble" files (with
// the SAME extension as the ROM — otherwise they would show up as broken games), the Windows recycle bin
// and system folder, the Linux trash and `lost+found` folders.
const JUNK_NAMES = new Set([
    '$recycle.bin', 'system volume information', 'lost+found', '.ds_store', 'thumbs.db', 'desktop.ini',
    '.spotlight-v100', '.fseventsd', '.trashes', '.trash',
]);

/** @param {string} name */
function isJunkEntry(name) {
    const n = String(name).toLowerCase();
    return n.startsWith('._') || n.startsWith('.trash-') || JUNK_NAMES.has(n);
}

// Kind of a `readdir` `Dirent` with symlinks RESOLVED: 'file' | 'dir' | null. A `Dirent` reports neither
// `isFile()` nor `isDirectory()` for a symlink — without this a `~/roms/ps2 → /mnt/ntfs/PS2` setup would
// give an empty list. Broken symlink / unreadable target → null (skipped).
/** @param {string} dir @param {fs.Dirent} dirent @returns {'file' | 'dir' | null} */
function entryKind(dir, dirent) {
    if (dirent.isFile()) return 'file';
    if (dirent.isDirectory()) return 'dir';
    if (!dirent.isSymbolicLink()) return null;
    try {
        const st = fs.statSync(path.join(dir, dirent.name));
        return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    } catch (err) {
        return null;
    }
}

// Same, async (for the async walker of `custom-roms-library.js` — must not block on NFS).
/** @param {string} dir @param {fs.Dirent} dirent @returns {Promise<'file' | 'dir' | null>} */
async function entryKindAsync(dir, dirent) {
    if (dirent.isFile()) return 'file';
    if (dirent.isDirectory()) return 'dir';
    if (!dirent.isSymbolicLink()) return null;
    try {
        const st = await fs.promises.stat(path.join(dir, dirent.name));
        return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    } catch (err) {
        return null;
    }
}

// Guard against circular symlinks (e.g. a folder pointing to its own parent): real paths of folders already
// walked. `true` = first time we see this folder (walk it). Unreadable path → `true` (readdir filters it).
/** @param {Set<string>} seen @param {string} dir */
function firstVisit(seen, dir) {
    let real = dir;
    try { real = fs.realpathSync.native(dir); } catch (err) { /* readdir will decide */ }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
}

// Same, async (for the async walker on the main process — a stuck network mount must not block).
/** @param {Set<string>} seen @param {string} dir */
async function firstVisitAsync(seen, dir) {
    let real = dir;
    try { real = await fs.promises.realpath(dir); } catch (err) { /* readdir will decide */ }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
}

// Returns the direct subfolders of a folder (without hidden — dot-prefixed — ones, locale-sorted).
// Throws if `dirPath` does not exist / is not a folder / no permission — the caller (IPC handler) catches.
function listSubdirs(dirPath) {
    const resolved = path.resolve(dirPath);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
        .filter((e) => !e.name.startsWith('.') && !isJunkEntry(e.name) && entryKind(resolved, e) === 'dir')
        .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'hu', { sensitivity: 'base' }));
    const parent = path.dirname(resolved);
    return { path: resolved, parent: parent === resolved ? null : parent, dirs };
}

// Does the given path exist AND is it a folder (validation of the "manual entry" branch).
function isDirectory(dirPath) {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch (err) {
        return false;
    }
}

// True if `child` is under `parent` (or equal) — via `path.relative`: if the result does not start with
// `..` and is not absolute, `child` is UNDER (or equal to) `parent`. Needed by the `melondsRomDirs` UI:
// a flatpak launcher with `filesystems=home` (e.g. melonDS) only sees paths under `$HOME` from its sandbox
// — a ROM folder outside it needs an explicit `flatpak override`.
function isInsideDir(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Deduplicated list narrowed to folders that actually exist (order-preserving) — the SHARED core of the
// launcher modules' `readGameDirs()`. A vanished/invalid path (e.g. an expired flatpak document portal,
// an unmounted drive) is silently skipped, never throws.
function filterExistingDirs(rawDirs) {
    const seen = new Set();
    const dirs = [];
    for (const d of (Array.isArray(rawDirs) ? rawDirs : [])) {
        if (typeof d !== 'string' || !d || seen.has(d)) continue;
        seen.add(d);
        try {
            if (fs.statSync(d).isDirectory()) dirs.push(d);
        } catch (err) { /* vanished/invalid path — skipped */ }
    }
    return dirs;
}

// Recursive file walk filtered by extension — the SHARED core of the launcher modules' ROM/disc-image
// scanners. `extensions` is a lowercase extension `Set` (e.g. `.nds`); `maxDepth` guards against an
// endless/broken folder structure; `recursive` (default `true`) matches Dolphin's `RecursiveISOPaths`
// switch (`false` only looks at the DIRECT files of `rootDir`). Cemu's `walkGameDirs` (marker-based, not
// extension-based) does NOT build on this — that is genuinely different logic.
function walkFilesByExtension(rootDir, extensions, { maxDepth = 3, recursive = true } = {}) {
    const out = [];
    /** @type {Set<string>} */
    const seen = new Set();
    const visit = (dir, depth) => {
        if (depth > maxDepth || !firstVisit(seen, dir)) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            return;
        }
        for (const e of entries) {
            if (isJunkEntry(e.name)) continue;
            const full = path.join(dir, e.name);
            const kind = entryKind(dir, e); // a szimlinket feloldva
            if (kind === 'dir') {
                if (recursive) visit(full, depth + 1);
                continue;
            }
            if (kind !== 'file') continue;
            if (extensions.has(path.extname(e.name).toLowerCase())) out.push(full);
        }
    };
    visit(rootDir, 0);
    return out;
}

module.exports = {
    listSubdirs, isDirectory, isInsideDir, filterExistingDirs, walkFilesByExtension,
    isJunkEntry, entryKind, entryKindAsync, firstVisit, firstVisitAsync,
};
