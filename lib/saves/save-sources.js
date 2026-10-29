// @ts-check
'use strict';

// Location of the game saves (save folders) per emulator — the "Save backups" (`save-backup.js`) packs these. Locations verified on the
// machine:
//
//   RetroArch   `retroarch.cfg` `savefile_directory` / `savestate_directory` (default: saves/, states/)
//   PCSX2       `inis/PCSX2.ini` `[Folders]` `MemoryCards` / `Savestates` (relative to the config root)
//   DuckStation `settings.ini` `[MemoryCards] Directory` + `[Folders] SaveStates`
//   PPSSPP      `PSP/SAVEDATA` + `PSP/PPSSPP_STATE`
//   Dolphin     data: `GC` (memory cards) + `Wii` (NAND — saves under title/*/data) + `StateSaves`
//   Cemu        `<mlc01>/usr/save` (following the `<mlc_path>` override too — the whole mlc01 is GBs of game content)
//   Ryujinx     `bis/user/save` + `bis/user/saveMeta` + `system/Profiles.json` (the keys DELIBERATELY not)
//   RPCS3       native `~/.config/rpcs3` AND flatpak: `dev_hdd0/home` (savedata + trophies) + `savestates`
//   melonDS     `melonDS.toml` `SaveFilePath` if set; otherwise the `.sav` next to the ROMs
//
// All I/O is ASYNC (fs/promises): the melonDS ROM folder may be on the network (NFS) — a synchronous walk would freeze the main
// process (see the freeze lesson in melonds-library.js).

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { flatpakConfigRoot, flatpakDataRoot } = require('../xdg.js');
// The flatpak app IDs from the library modules' constants (single source, test/contracts/flatpak-ids.test.js).
const { RETROARCH_FLATPAK_ID } = require('../launchers/retroarch-library.js');
const { PCSX2_FLATPAK_ID } = require('../launchers/pcsx2-library.js');
const { DUCKSTATION_FLATPAK_ID } = require('../launchers/duckstation-library.js');
const { PPSSPP_FLATPAK_ID } = require('../launchers/ppsspp-library.js');
const { DOLPHIN_FLATPAK_ID } = require('../launchers/dolphin-library.js');
const { CEMU_FLATPAK_ID } = require('../launchers/cemu-library.js');
const { RYUJINX_FLATPAK_ID } = require('../launchers/ryujinx-library.js');
const { RPCS3_FLATPAK_ID } = require('../launchers/rpcs3-library.js');
const { MELONDS_FLATPAK_ID } = require('../launchers/melonds-library.js');

// BOTH possible roots of an app (flatpak + native) — the backup looks at both (a missing one is skipped), so a native ↔ flatpak switch
// does not miss saves either. The native path is the XDG equivalent (`~/.config/<name>` / `~/.local/share/<name>`), except where
// `native` says otherwise.
/** @param {'config'|'data'} kind @param {string} appId @param {string} appName @param {string} homeDir @param {string} [native] */
function bothRoots(kind, appId, appName, homeDir, native) {
    const flat = kind === 'config' ? flatpakConfigRoot(appId, appName, homeDir) : flatpakDataRoot(appId, appName, homeDir);
    const nat = native || (kind === 'config'
        ? path.join(homeDir, '.config', appName) : path.join(homeDir, '.local', 'share', appName));
    return [flat, nat];
}

// The `each(root)` paths joined for both roots.
/** @param {string[]} roots @param {(root: string) => Promise<string[]>} each */
async function perRoot(roots, each) {
    const out = [];
    for (const r of roots) out.push(...await each(r));
    return out;
}
const cemuLibrary = require('../launchers/cemu-library.js');
const melondsLibrary = require('../launchers/melonds-library.js');

// `~` / `~/…` → the home folder (the RetroArch cfg writes paths like this).
function expandHome(p, homeDir = os.homedir()) {
    if (p === '~') return homeDir;
    if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
    return p;
}

// `key = value` from an ini/cfg text; with `section` → only in that `[section]`. Strips quotes. Missing → `null`.
function iniValue(text, key, section = null) {
    let current = null;
    for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
        const line = raw.trim();
        const sec = /^\[(.+)\]$/.exec(line);
        if (sec) { current = sec[1]; continue; }
        if (section && current !== section) continue;
        const eq = line.indexOf('=');
        if (eq <= 0 || line.slice(0, eq).trim() !== key) continue;
        return line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    }
    return null;
}

async function readText(p) {
    try {
        return await fsp.readFile(p, 'utf8');
    } catch {
        return null;
    }
}

// Resolves a folder value: empty / `default` → the default; relative → relative to `base`.
function resolveDir(value, base, fallback, homeDir) {
    if (!value || value === 'default') return fallback;
    const v = expandHome(value, homeDir);
    return path.isAbsolute(v) ? v : path.resolve(base, v);
}

// Files with extension `ext` in a folder tree (max `depth` levels), async — never throws.
async function findFiles(dir, ext, depth = 3) {
    const out = [];
    let entries = [];
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (depth > 0) out.push(...await findFiles(p, ext, depth - 1));
        } else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) {
            out.push(p);
        }
    }
    return out;
}

// The source definitions: `id`, `name`, `paths(opts)` → the CANDIDATE absolute paths (`detectSaveSources` filters out the missing ones).
// The flatpak roots come from `lib/xdg.js` (with the call-time HOME).
/**
 * @typedef {{ id: string, name: string,
 *   paths: (o: { homeDir: string, melondsRomDirs?: string[] }) => Promise<string[]> }} SaveSourceDef
 */
/** @type {SaveSourceDef[]} */
const SAVE_SOURCE_DEFS = [
    {
        id: 'retroarch', name: 'RetroArch',
        async paths({ homeDir }) {
            return perRoot(bothRoots('config', RETROARCH_FLATPAK_ID, 'retroarch', homeDir), async (root) => {
                const cfg = await readText(path.join(root, 'retroarch.cfg'));
                return [
                    resolveDir(iniValue(cfg, 'savefile_directory'), root, path.join(root, 'saves'), homeDir),
                    resolveDir(iniValue(cfg, 'savestate_directory'), root, path.join(root, 'states'), homeDir),
                ];
            });
        },
    },
    {
        id: 'pcsx2', name: 'PCSX2',
        async paths({ homeDir }) {
            return perRoot(bothRoots('config', PCSX2_FLATPAK_ID, 'PCSX2', homeDir), async (root) => {
                const ini = await readText(path.join(root, 'inis', 'PCSX2.ini'));
                return [
                    resolveDir(iniValue(ini, 'MemoryCards', 'Folders'), root, path.join(root, 'memcards'), homeDir),
                    resolveDir(iniValue(ini, 'Savestates', 'Folders'), root, path.join(root, 'sstates'), homeDir),
                ];
            });
        },
    },
    {
        id: 'duckstation', name: 'DuckStation',
        async paths({ homeDir }) {
            const roots = bothRoots('config', DUCKSTATION_FLATPAK_ID, 'duckstation', homeDir,
                path.join(homeDir, '.local', 'share', 'duckstation'));
            return perRoot(roots, async (root) => {
                const ini = await readText(path.join(root, 'settings.ini'));
                return [
                    resolveDir(iniValue(ini, 'Directory', 'MemoryCards'), root, path.join(root, 'memcards'), homeDir),
                    resolveDir(iniValue(ini, 'SaveStates', 'Folders'), root, path.join(root, 'savestates'), homeDir),
                ];
            });
        },
    },
    {
        id: 'ppsspp', name: 'PPSSPP',
        async paths({ homeDir }) {
            return perRoot(bothRoots('config', PPSSPP_FLATPAK_ID, 'ppsspp', homeDir), async (root) => {
                const psp = path.join(root, 'PSP');
                return [path.join(psp, 'SAVEDATA'), path.join(psp, 'PPSSPP_STATE')];
            });
        },
    },
    {
        id: 'dolphin', name: 'Dolphin',
        async paths({ homeDir }) {
            return perRoot(bothRoots('data', DOLPHIN_FLATPAK_ID, 'dolphin-emu', homeDir), async (data) => [
                path.join(data, 'GC'), path.join(data, 'Wii'), path.join(data, 'StateSaves'),
            ]);
        },
    },
    {
        id: 'cemu', name: 'Cemu',
        async paths({ homeDir }) {
            const configs = bothRoots('config', CEMU_FLATPAK_ID, 'Cemu', homeDir);
            const datas = bothRoots('data', CEMU_FLATPAK_ID, 'Cemu', homeDir);
            return [0, 1].map((i) => path.join(cemuLibrary.mlcRoot(configs[i], datas[i]), 'usr', 'save'));
        },
    },
    {
        id: 'ryujinx', name: 'Ryujinx',
        async paths({ homeDir }) {
            return perRoot(bothRoots('config', RYUJINX_FLATPAK_ID, 'Ryujinx', homeDir), async (root) => [
                path.join(root, 'bis', 'user', 'save'), path.join(root, 'bis', 'user', 'saveMeta'),
                path.join(root, 'system', 'Profiles.json'),
            ]);
        },
    },
    {
        id: 'rpcs3', name: 'RPCS3',
        async paths({ homeDir }) {
            const roots = bothRoots('config', RPCS3_FLATPAK_ID, 'rpcs3', homeDir);
            return roots.flatMap((r) => [path.join(r, 'dev_hdd0', 'home'), path.join(r, 'savestates')]);
        },
    },
    {
        id: 'melonds', name: 'melonDS',
        async paths({ homeDir, melondsRomDirs }) {
            return perRoot(bothRoots('config', MELONDS_FLATPAK_ID, 'melonDS', homeDir), async (root) => {
                const toml = await readText(path.join(root, 'melonDS.toml'));
                const saveDir = toml ? melondsLibrary.parseTomlString(toml, 'SaveFilePath') : null;
                const stateDir = toml ? melondsLibrary.parseTomlString(toml, 'SavestatePath') : null;
                const out = [];
                if (saveDir) out.push(expandHome(saveDir, homeDir));
                if (stateDir) out.push(expandHome(stateDir, homeDir));
                if (!saveDir) {
                    // By default the `.sav` is next to the ROM — the ROM folders (melonDS's own + the manual list).
                    const dirs = melondsLibrary.readGameDirs(root, melondsRomDirs || []);
                    for (const d of dirs) out.push(...await findFiles(d, '.sav'));
                }
                return out;
            });
        },
    },
];

// Size of a path (file or folder tree, in bytes) — does not follow symlinks; missing → `null`.
async function pathSize(p) {
    let st;
    try {
        st = await fsp.lstat(p);
    } catch {
        return null;
    }
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    let entries = [];
    try {
        entries = await fsp.readdir(p);
    } catch {
        return total;
    }
    for (const name of entries) total += (await pathSize(path.join(p, name))) || 0;
    return total;
}

/**
 * The save locations ACTUALLY present on the machine, per source (missing paths / sources are skipped). Never throws.
 * @param {{ homeDir?: string, melondsRomDirs?: string[] }} [opts]
 * @returns {Promise<Array<{ id: string, name: string, bytes: number, paths: Array<{ path: string, bytes: number }> }>>}
 */
async function detectSaveSources(opts = {}) {
    const homeDir = opts.homeDir || os.homedir();
    const out = [];
    for (const def of SAVE_SOURCE_DEFS) {
        let candidates = [];
        try {
            candidates = await def.paths({ homeDir, melondsRomDirs: opts.melondsRomDirs });
        } catch {
            continue;
        }
        const paths = [];
        for (const p of [...new Set(candidates)]) {
            const bytes = await pathSize(p);
            if (bytes !== null) paths.push({ path: p, bytes });
        }
        if (paths.length) out.push({ id: def.id, name: def.name, bytes: paths.reduce((a, x) => a + x.bytes, 0), paths });
    }
    return out;
}

module.exports = { SAVE_SOURCE_DEFS, detectSaveSources, iniValue, expandHome, pathSize, findFiles };
