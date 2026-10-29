// @ts-check
'use strict';

// Icons of installed applications for the "+ Add launcher" wizard: a `.desktop` `Icon=` name (or flatpak appid) → the best PNG/SVG in the
// icon themes, and COPYING the chosen icon into the launcher's own folder (`~/.local/share/launchers-launcher/icons/`), so a package update
// cannot break the card; the `icon` in `config.json` is a `file://` URL we manage. The index is a ONE-OFF listing of the `apps` folders of
// the theme roots (hicolor + common themes + `pixmaps`), cached for 5 minutes.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const { dataHome } = require('../xdg.js');
const { isInsideDir } = require('../dir-browse.js');
const { writeFileAtomic } = require('../fs-atomic.js');

const ICON_EXT_RE = /\.(png|svg)$/i;
// The indexed themes (hicolor is the fallback per the spec — most apps install here).
const ICON_THEMES = ['hicolor', 'breeze', 'Adwaita', 'Papirus'];
const ICON_INDEX_TTL_MS = 5 * 60 * 1000;
const MAX_ICON_BYTES = 2 * 1024 * 1024;

// Icon roots: `~/.local/share/icons`, `~/.icons`, the `icons/` folders of `$XDG_DATA_DIRS` (TOGETHER with the flatpak `exports/share` —
// the flatpak apps' icons are there), finally `pixmaps`. Pure.
/** @param {{ homeDir?: string, dataDirs?: string }} [o] */
function iconRoots({ homeDir = os.homedir(), dataDirs = process.env.XDG_DATA_DIRS } = {}) {
    const sys = String(dataDirs || '/usr/local/share:/usr/share').split(':').filter(Boolean);
    const withFlatpak = [
        ...sys,
        path.join(dataHome(homeDir), 'flatpak', 'exports', 'share'),
        '/var/lib/flatpak/exports/share',
    ];
    return {
        themeRoots: [...new Set([
            path.join(dataHome(homeDir), 'icons'), path.join(homeDir, '.icons'),
            ...withFlatpak.map((d) => path.join(d, 'icons')),
        ].map((d) => path.resolve(d)))],
        pixmapRoots: [...new Set([...sys.map((d) => path.join(d, 'pixmaps')), '/usr/share/pixmaps'].map((d) => path.resolve(d)))],
    };
}

// The "size" of an icon path for ranking: `scalable` (SVG) is the best, otherwise the `NNxNN`/`NN` path segment; bigger is better, but
// the tiny 16/22/24 ones are only a last resort. Pure.
/** @param {string} p */
function iconScore(p) {
    const segs = p.split(path.sep);
    if (segs.includes('scalable') || /\.svg$/i.test(p)) return 1000;
    for (const s of segs) {
        const m = /^(\d+)(?:x\d+)?(?:@(\d)x?)?$/.exec(s);
        if (m) return Number(m[1]) * (m[2] ? Number(m[2]) : 1);
    }
    return 32; // pixmaps / unknown layout
}

// The `apps` directories of a theme folder: hicolor layout `<size>/apps` AND breeze layout `apps/<size>`.
/** @param {string} themeDir @returns {Promise<string[]>} */
async function themeAppDirs(themeDir) {
    const out = [];
    let ents = [];
    try { ents = await fs.promises.readdir(themeDir, { withFileTypes: true }); } catch (err) { return out; }
    for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        if (ent.name === 'apps') {
            let sub = [];
            try { sub = await fs.promises.readdir(path.join(themeDir, 'apps'), { withFileTypes: true }); } catch (err) { sub = []; }
            for (const s of sub) if (s.isDirectory()) out.push(path.join(themeDir, 'apps', s.name));
        } else {
            out.push(path.join(themeDir, ent.name, 'apps'));
        }
    }
    return out;
}

/** @type {{ at: number, key: string, map: Map<string, Array<{ file: string, score: number }>> } | null} */
let indexCache = null;

// name (without extension) → candidates. Never throws.
/** @param {{ homeDir?: string, dataDirs?: string, now?: number }} [o] */
async function buildIconIndex(o = {}) {
    const { themeRoots, pixmapRoots } = iconRoots(o);
    const key = JSON.stringify([themeRoots, pixmapRoots]);
    const now = o.now || Date.now();
    if (indexCache && indexCache.key === key && now - indexCache.at < ICON_INDEX_TTL_MS) return indexCache.map;
    /** @type {Map<string, Array<{ file: string, score: number }>>} */
    const map = new Map();
    const addDir = async (dir) => {
        let files = [];
        try { files = await fs.promises.readdir(dir); } catch (err) { return; }
        for (const f of files) {
            if (!ICON_EXT_RE.test(f)) continue;
            const file = path.join(dir, f);
            const name = f.replace(ICON_EXT_RE, '');
            if (!map.has(name)) map.set(name, []);
            map.get(name).push({ file, score: iconScore(file) });
        }
    };
    for (const root of themeRoots) {
        for (const theme of ICON_THEMES) {
            for (const dir of await themeAppDirs(path.join(root, theme))) await addDir(dir);
        }
    }
    for (const dir of pixmapRoots) await addDir(dir);
    indexCache = { at: now, key, map };
    return map;
}

function clearIconIndexCache() {
    indexCache = null;
}

// An `Icon=` value → absolute path of the best icon file, or `null`. Absolute `Icon=` path: only if PNG/SVG and it exists. Among the
// theme candidates hicolor (the theme order) is not weighted, the biggest size wins (SVG always). Never throws.
/** @param {string} icon @param {Map<string, Array<{ file: string, score: number }>>} index */
function resolveIconFile(icon, index) {
    if (typeof icon !== 'string' || !icon) return null;
    if (path.isAbsolute(icon)) {
        return ICON_EXT_RE.test(icon) && fs.existsSync(icon) ? icon : null;
    }
    const cands = index.get(icon.replace(ICON_EXT_RE, '')) || [];
    if (!cands.length) return null;
    return cands.slice().sort((a, b) => b.score - a.score)[0].file;
}

// The launcher's own icon folder (a `file://` URL in the `icon` field may point here).
function userIconDir(homeDir = os.homedir()) {
    return path.join(dataHome(homeDir), 'launchers-launcher', 'icons');
}

const SAFE_ICON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:png|svg)$/;

// Is it acceptable as the `icon` field of `config.json` (the `checkLauncherPayload` gate): a `file://` URL pointing EXACTLY to a
// safely named file in our own icon folder. Pure (does not check existence — for a deleted file the renderer switches to `FALLBACK_ICON`).
/** @param {any} url */
function isUserIconUrl(url, homeDir = os.homedir()) {
    if (typeof url !== 'string' || !url.startsWith('file://')) return false;
    let p;
    try { p = fileURLToPath(url); } catch (err) { return false; }
    return path.dirname(p) === userIconDir(homeDir) && SAFE_ICON_NAME_RE.test(path.basename(p));
}

// Where an icon may be imported from: ONLY from under the icon roots (the renderer must not make it copy an arbitrary file into the
// user icon folder). Pure.
/** @param {string} file @param {{ homeDir?: string, dataDirs?: string }} [o] */
function isImportableIconPath(file, o = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !ICON_EXT_RE.test(file)) return false;
    const { themeRoots, pixmapRoots } = iconRoots(o);
    return [...themeRoots, ...pixmapRoots].some((root) => isInsideDir(file, root));
}

// Copies the icon to `<userIconDir>/<launcherId>.<ext>` (atomic write) → the `file://` URL, or `{ ok: false, reason }`. Resolves the
// symlink (hicolor icons are often links), size ≤ 2 MB.
/** @param {string} file @param {string} launcherId @param {{ homeDir?: string, dataDirs?: string }} [o] */
function importLauncherIcon(file, launcherId, o = {}) {
    const homeDir = o.homeDir || os.homedir();
    if (!isImportableIconPath(file, o)) return { ok: false, reason: 'not a PNG/SVG under an icon folder' };
    const ext = path.extname(file).toLowerCase();
    const name = `${String(launcherId).replace(/[^A-Za-z0-9._-]/g, '_')}${ext}`;
    if (!SAFE_ICON_NAME_RE.test(name)) return { ok: false, reason: 'invalid launcher id' };
    let buf;
    try {
        // The symlink target must be an icon file too (hicolor icons are often links into the package's own folder).
        if (!ICON_EXT_RE.test(fs.realpathSync(file))) return { ok: false, reason: 'the link target is not PNG/SVG' };
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > MAX_ICON_BYTES) return { ok: false, reason: 'not a file or too large' };
        buf = fs.readFileSync(file);
    } catch (err) {
        return { ok: false, reason: err.message };
    }
    const dest = path.join(userIconDir(homeDir), name);
    try {
        writeFileAtomic(dest, buf);
    } catch (err) {
        return { ok: false, reason: err.message };
    }
    return { ok: true, url: pathToFileURL(dest).href };
}

// When a launcher is removed, its own (imported) icon is deleted too. Never throws.
/** @param {any} url */
function removeUserIcon(url, homeDir = os.homedir()) {
    if (!isUserIconUrl(url, homeDir)) return false;
    try {
        fs.unlinkSync(fileURLToPath(url));
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = {
    iconRoots, iconScore, buildIconIndex, clearIconIndexCache, resolveIconFile,
    userIconDir, isUserIconUrl, isImportableIconPath, importLauncherIcon, removeUserIcon,
    ICON_THEMES,
};
