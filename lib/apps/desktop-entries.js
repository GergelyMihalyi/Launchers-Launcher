// @ts-check
'use strict';

// Discovery of the NATIVE applications installed on the machine (XDG `.desktop`) for the "+ Add launcher" wizard list. Flatpak apps do
// NOT come from here (`flatpak list`), and a `flatpak run` `Exec=` is skipped too. Output: `{ id, name, cmd, args, icon }` — `Exec=` split
// per the Desktop Entry Specification, the `%f/%u/...` field codes DROPPED. The admission gate is `checkLauncherPayload` in
// `launcher-list.js`; here only obviously non-launcher-like entries (NoDisplay/Hidden/Terminal/not Application) are filtered out.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { dataHome } = require('../xdg.js');

// The field codes dropped from `Exec=` (`%%` → `%` handled separately).
const FIELD_CODE_RE = /^%[fFuUdDnNickvm]$/;

// The `[Desktop Entry]` group of a `.desktop` file as a key → value map (with the localized keys, e.g. `Name[hu]`). Other groups
// (`[Desktop Action …]`) are skipped. Pure.
/** @param {string} text @returns {Record<string, string>} */
function parseDesktopFile(text) {
    /** @type {Record<string, string>} */
    const out = {};
    let inEntry = false;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
            inEntry = line === '[Desktop Entry]';
            continue;
        }
        if (!inEntry) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!(key in out)) out[key] = line.slice(eq + 1).trim();
    }
    return out;
}

// The value of a localized key (`Name[hu_HU]` → `Name[hu]` → `Name`). Pure.
/** @param {Record<string, string>} entry @param {string} key @param {string} [lang] */
function localized(entry, key, lang = '') {
    const full = String(lang || '').split('.')[0];
    const short = full.split('_')[0];
    for (const k of [full && `${key}[${full}]`, short && `${key}[${short}]`, key]) {
        if (k && typeof entry[k] === 'string' && entry[k]) return entry[k];
    }
    return '';
}

// Splits the `Exec=` value into argv (Desktop Entry Spec: `"…"` quoting with `\"`, `` \` ``, `\$`, `\\` escapes inside; the string-level
// `\s`/`\\` escapes are resolved too). Field codes are dropped, and an argument CONTAINING (but not consisting only of) a field code is
// dropped too (e.g. `--file=%f`). Empty / unterminated quote → `null`. Pure.
/** @param {string} exec @returns {string[] | null} */
function splitExec(exec) {
    const s = String(exec || '').replace(/\\s/g, ' ');
    /** @type {string[]} */
    const args = [];
    let cur = '';
    let has = false;
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quoted) {
            if (c === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) { cur += s[++i]; continue; }
            if (c === '"') { quoted = false; continue; }
            cur += c;
            continue;
        }
        if (c === '"') { quoted = true; has = true; continue; }
        if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
        if (c === ' ' || c === '\t') {
            if (has) args.push(cur);
            cur = '';
            has = false;
            continue;
        }
        cur += c;
        has = true;
    }
    if (quoted) return null;
    if (has) args.push(cur);
    const out = [];
    for (const a of args) {
        if (FIELD_CODE_RE.test(a)) continue;
        if (/%[fFuUdDnNickvm]/.test(a.replace(/%%/g, ''))) continue;
        out.push(a.replace(/%%/g, '%'));
    }
    return out.length ? out : null;
}

// A parsed `.desktop` → one row of the wizard, or `null` if not launcher-like. Pure.
/**
 * @param {string} id the desktop file id (`org.foo.Bar` — without `.desktop`)
 * @param {Record<string, string>} entry
 * @param {string} [lang]
 */
function desktopEntryToApp(id, entry, lang) {
    if (entry.Type !== 'Application') return null;
    if (/^true$/i.test(entry.NoDisplay || '') || /^true$/i.test(entry.Hidden || '') || /^true$/i.test(entry.Terminal || '')) return null;
    const argv = splitExec(entry.Exec || '');
    if (!argv) return null;
    const [cmd, ...args] = argv;
    // A flatpak-exported (or `flatpak run`) entry: taken from the flatpak list instead.
    if (path.basename(cmd) === 'flatpak' || entry['X-Flatpak']) return null;
    // Ourselves (the menu launcher icon, share/launchers-launcher.desktop).
    if (id === 'launchers-launcher') return null;
    const name = localized(entry, 'Name', lang);
    if (!name) return null;
    return {
        id, name, cmd, args,
        icon: entry.Icon || '',
        genericName: localized(entry, 'GenericName', lang),
        categories: String(entry.Categories || '').split(';').filter(Boolean),
    };
}

// The `.desktop` roots: `~/.local/share/applications` (first — the user override), then the `applications/` folders of `$XDG_DATA_DIRS`
// (default `/usr/local/share:/usr/share`). The flatpak `exports/share` roots are skipped. Pure (env + home parameter).
/** @param {{ homeDir?: string, dataDirs?: string }} [o] @returns {string[]} */
function desktopDirs({ homeDir = os.homedir(), dataDirs = process.env.XDG_DATA_DIRS } = {}) {
    const sys = String(dataDirs || '/usr/local/share:/usr/share').split(':').filter(Boolean)
        .filter((d) => !/\/flatpak\/exports\/share\/?$/.test(d));
    const dirs = [path.join(dataHome(homeDir), 'applications'), ...sys.map((d) => path.join(d, 'applications'))];
    return [...new Set(dirs.map((d) => path.resolve(d)))];
}

// Every launcher-like native app, sorted by name. The desktop id is the path relative to the root with `/` → `-` (per the spec); the same
// id found in the FIRST root wins. One level of subfolders. Never throws (unreadable file / folder → skipped). ASYNC I/O
// (`/usr/share/applications` has hundreds of files).
/** @param {{ dirs?: string[], lang?: string }} [o] */
async function listDesktopApps({ dirs = desktopDirs(), lang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '' } = {}) {
    /** @type {Map<string, any>} */
    const byId = new Map();
    /** @type {Set<string>} */
    const seen = new Set();
    for (const root of dirs) {
        /** @type {Array<{ file: string, id: string }>} */
        const files = [];
        const walk = async (dir, prefix, depth) => {
            let ents = [];
            try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (err) { return; }
            for (const ent of ents) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (depth > 0) await walk(full, `${prefix}${ent.name}-`, depth - 1);
                } else if (ent.name.endsWith('.desktop')) {
                    files.push({ file: full, id: `${prefix}${ent.name.slice(0, -'.desktop'.length)}` });
                }
            }
        };
        await walk(root, '', 1);
        for (const { file, id } of files) {
            if (seen.has(id)) continue; // an earlier (higher priority) root already decided
            seen.add(id);
            let text;
            try { text = await fs.promises.readFile(file, 'utf8'); } catch (err) { continue; }
            const app = desktopEntryToApp(id, parseDesktopFile(text), lang);
            if (app) byId.set(id, { ...app, file });
        }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { parseDesktopFile, localized, splitExec, desktopEntryToApp, desktopDirs, listDesktopApps };
