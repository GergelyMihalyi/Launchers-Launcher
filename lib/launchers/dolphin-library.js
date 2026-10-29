// @ts-check
'use strict';

// Dolphin (GameCube / Wii emulator) installed disc-image discovery.
// The scan folders come from the `[General]` `ISOPath0..N` + `RecursiveISOPaths` keys of Dolphin's `Dolphin.ini` (host-side paths
// because of the flatpak's `host:ro`; `translateFlatpakDocPath` covers the in-sandbox form).
// Title + Game ID from the disc's native header: `.iso`/`.gcm` and `.wbfs`; the compressed/container formats
// (`.rvz`/`.wia`/`.gcz`/`.ciso`/`.wad`) only get a file-name based title (accepted limitation).
// Cover: Dolphin's own GameTDB cache FIRST, otherwise downloaded into the launcher's own cache (`ensureDolphinCovers`).
// "Recently played": booked at launch time (`TimePlayed.ini` has no timestamp).
// Header offsets, WBFS layout, cover regions: docs/dev/launchers/dolphin.md

const fs = require('fs');
const path = require('path');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');
const { coverCacheDir, coverPath, resolveCachedCover, ensureCoversForEntries } = require('./shared/cover-cache.js');
const { appConfigRoot, appCacheRoot, translateFlatpakDocPath } = require('../xdg.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { filterExistingDirs, walkFilesByExtension } = require('../dir-browse.js');

const DOLPHIN_FLATPAK_ID = 'org.DolphinEmu.dolphin-emu';
const DOLPHIN_APP_NAME = 'dolphin-emu';

function dolphinConfigRoot() {
    return appConfigRoot(DOLPHIN_FLATPAK_ID, DOLPHIN_APP_NAME); // native: ~/.config/dolphin-emu
}

function dolphinCacheRoot() {
    return appCacheRoot(DOLPHIN_FLATPAK_ID, DOLPHIN_APP_NAME); // native: ~/.cache/dolphin-emu
}

// Do not descend needlessly into a deep/broken folder structure.
const MAX_SCAN_DEPTH = 3;
// Formats readable from the header with full title+ID.
const PARSEABLE_EXTENSIONS = new Set(['.iso', '.gcm', '.wbfs']);
// Compressed/other container — only a file-name based title.
const OTHER_ROM_EXTENSIONS = new Set(['.rvz', '.wia', '.gcz', '.ciso', '.wad']);

// The host-side translation of the document-portal bind mount seen INSIDE the sandbox (`/run/flatpak/doc/...`) lives in
// `lib/xdg.js`, re-exported here. Because of Dolphin's `host:ro` permission, `Dolphin.ini` on the machine ALREADY holds the
// host-side form — this translation is only a defensive fallback.

// The `ISOPath0`/`ISOPath1`/… lines + `RecursiveISOPaths` (bool, default `false`) of the `[General]` section of `Dolphin.ini`.
// Line-by-line processing — from the `[General]` line to the next `[...]` section header.
function parseIsoPaths(iniText) {
    const lines = String(iniText == null ? '' : iniText).split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l.trim() === '[General]');
    if (startIdx < 0) return { dirs: [], recursive: false };
    const dirs = [];
    let recursive = false;
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\[.*\]$/.test(line.trim())) break; // next section -> done
        // `.*` (not `.+?`) + a SEPARATE emptiness check AFTER the trim — the real `ISOPath1 = ` line on the machine (a single,
        // contentless space value) would have been captured by the lazy `.+?` as an all-space "value" (not an empty string, so
        // `if (pathMatch[1])` would have passed).
        const pathMatch = /^ISOPath\d+\s*=\s*(.*)$/.exec(line);
        if (pathMatch) {
            const val = pathMatch[1].trim();
            if (val) dirs.push(translateFlatpakDocPath(val));
        }
        const recMatch = /^RecursiveISOPaths\s*=\s*(.+?)\s*$/.exec(line);
        if (recMatch) recursive = recMatch[1].trim().toLowerCase() === 'true';
    }
    return { dirs, recursive };
}

// The ROM search folders read from `Dolphin.ini` — only those that actually exist (a flatpak document-portal path may expire).
// Missing/broken ini -> empty list, never throws.
function readGameDirs(configRoot) {
    let iniText;
    try {
        iniText = fs.readFileSync(path.join(configRoot, 'Dolphin.ini'), 'utf8');
    } catch (err) {
        return { dirs: [], recursive: false };
    }
    const parsed = parseIsoPaths(iniText);
    return { dirs: filterExistingDirs(parsed.dirs), recursive: parsed.recursive };
}

// The native header of a GC/Wii disc: Game ID 6 bytes @0, Wii magic @0x18, GC magic @0x1c, title (max 64 bytes, null-terminated
// ASCII) @0x20. `null` if neither magic matches (not a real GC/Wii disc header — e.g. a Wii U dump).
const DISC_HEADER_SIZE = 0x60;
const WII_MAGIC = 0x5d1c9ea3;
const GC_MAGIC = 0xc2339f3d;

function parseDiscHeader(buf) {
    if (!buf || buf.length < DISC_HEADER_SIZE) return null;
    const wiiMagic = buf.readUInt32BE(0x18);
    const gcMagic = buf.readUInt32BE(0x1c);
    if (wiiMagic !== WII_MAGIC && gcMagic !== GC_MAGIC) return null;
    const gameId = buf.toString('ascii', 0, 6).trim();
    if (!gameId) return null;
    const titleRaw = buf.toString('ascii', 0x20, 0x20 + 64);
    const nul = titleRaw.indexOf('\0');
    const title = (nul >= 0 ? titleRaw.slice(0, nul) : titleRaw).trim();
    return { gameId: gameId.toUpperCase(), title: title || null, isWii: wiiMagic === WII_MAGIC };
}

function readAt(fd, length, position) {
    const buf = Buffer.alloc(length);
    let n;
    try {
        n = fs.readSync(fd, buf, 0, length, position);
    } catch (err) {
        return null;
    }
    return n === length ? buf : null;
}

// Raw `.iso`/`.gcm`: the disc header is at the start of the file.
function extractIsoDiscMeta(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (err) {
        return null;
    }
    try {
        const buf = readAt(fd, DISC_HEADER_SIZE, 0);
        return buf ? parseDiscHeader(buf) : null;
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed */ }
    }
}

// `.wbfs`: AFTER the WBFS header (`WBFS` magic @0, `hd_sec_sz_s` exponent @8), the first disc's native header starts at exactly
// `2^hd_sec_sz_s` bytes.
function extractWbfsDiscMeta(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (err) {
        return null;
    }
    try {
        const head = readAt(fd, 12, 0);
        if (!head || head.toString('ascii', 0, 4) !== 'WBFS') return null;
        const hdSectorSize = 1 << head.readUInt8(8);
        if (!Number.isFinite(hdSectorSize) || hdSectorSize < 256 || hdSectorSize > 1 << 20) return null; // sanity
        const buf = readAt(fd, DISC_HEADER_SIZE, hdSectorSize);
        return buf ? parseDiscHeader(buf) : null;
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed */ }
    }
}

function extractDiscMeta(filePath, ext) {
    if (ext === '.wbfs') return extractWbfsDiscMeta(filePath);
    if (ext === '.iso' || ext === '.gcm') return extractIsoDiscMeta(filePath);
    return null;
}

// File-name cleanup fallback (no header title) — the shared `cleanFilenameLabel` of `lib/launchers/shared/game-id.js`.
function dolphinGameLabel(rawName) {
    return cleanFilenameLabel(rawName);
}

// Stable id of a disc image: the Game ID if it can be extracted, otherwise a `p:`-prefixed substitute derived from the file path.
function dolphinGameId(gameId, filePath) {
    return gameId || pathHashId(filePath);
}

// The launch argument list (flatpak-shaped: `run <appid> …` — for native, `variantExecSpec` strips the prefix).
// `-b` (batch: no UI, exits when the game closes) + `-e <disc image>`; Dolphin's CLI has no `--fullscreen` flag, hence
// `-C Dolphin.Display.Fullscreen=True`.
// Verified live on the machines (docs/dev/launchers/dolphin.md).
function dolphinGameArgs(discPath) {
    return ['run', DOLPHIN_FLATPAK_ID, '-b', '-e', discPath, '-C', 'Dolphin.Display.Fullscreen=True'];
}

// The header-readable formats AND the file-name-only other formats together — walked by the shared `walkFilesByExtension` of
// `lib/dir-browse.js`.
const ALL_ROM_EXTENSIONS = new Set([...PARSEABLE_EXTENSIONS, ...OTHER_ROM_EXTENSIONS]);

// The installed (browsable) GC/Wii disc images — by walking the `ISOPath0..N` folders (recursively or flat per
// `RecursiveISOPaths`). Full Game ID + official title + cover for `.iso`/`.gcm`/`.wbfs`; only a file-name based title for other
// formats (accepted limitation). `cacheRoot` comes from the caller (the worker scan gets the main process's variant root — the
// worker's own `lib/xdg.js` state does not know the added native/flatpak variant).
function findInstalledGames(configRoot, cacheRoot = dolphinCacheRoot()) {
    const { dirs, recursive } = readGameDirs(configRoot);
    const files = [];
    for (const dir of dirs) files.push(...walkFilesByExtension(dir, ALL_ROM_EXTENSIONS, { maxDepth: MAX_SCAN_DEPTH, recursive }));

    const games = [];
    const seenIds = new Set();
    for (const file of files) {
        const base = path.basename(file);
        const ext = path.extname(base).toLowerCase();
        const meta = PARSEABLE_EXTENSIONS.has(ext) ? extractDiscMeta(file, ext) : null;
        const gameId = meta ? meta.gameId : null;
        const name = (meta && meta.title) || dolphinGameLabel(base);

        const id = dolphinGameId(gameId, file);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        games.push({
            id,
            name,
            path: file,
            gameId: gameId || null,
            cover: gameId ? resolveDolphinCover(cacheRoot, gameId) : null,
        });
    }
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

// TTL-cached variant for the `list-dolphin-games` IPC (the raw `findInstalledGames` stays pure for tests).
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

// --- Cover: Dolphin's own GameCovers cache FIRST, the launcher's own cache folder + GameTDB download SECOND ---

function dolphinCoverCacheDir() {
    return coverCacheDir('dolphin');
}

function dolphinCoverPath(gameId) {
    return coverPath('dolphin', gameId, 'png');
}

// Dolphin's OWN `cache/dolphin-emu/GameCovers/<GameID>.png` cache (if `Dolphin.ini` has `UseGameCovers = True` — the default on
// the machine — and Dolphin has opened its own list at least once).
function dolphinNativeCoverPath(cacheRoot, gameId) {
    return path.join(cacheRoot, 'GameCovers', `${gameId}.png`);
}

// Only returns a cover ALREADY on disk — Dolphin's own cache FIRST, then the launcher's own (GameTDB-downloaded) cache folder
// (self-healing — no network, never throws).
function resolveDolphinCover(cacheRoot, gameId) {
    if (!gameId) return null;
    try {
        const native = dolphinNativeCoverPath(cacheRoot, gameId);
        if (fs.existsSync(native)) return native;
    } catch (err) { /* continue with our own cache folder */ }
    return resolveCachedCover('dolphin', gameId, 'png');
}

// Character 4 (index 3) of the Game ID is the region letter — the GameTDB `wii/cover/<region>/` folder name comes from it
// (best effort, verified live on the machine: P->EN, E->US, J->JA; `EN` is the fallback for rarer region letters). GameCube discs
// also live under the `wii/cover/` path on GameTDB (verified).
const GAMETDB_REGION_MAP = { E: 'US', P: 'EN', J: 'JA', K: 'KO', W: 'ZHTW', C: 'ZHCN' };
function gametdbRegion(gameId) {
    const letter = String(gameId || '')[3];
    return GAMETDB_REGION_MAP[letter] || 'EN';
}

const GAMETDB_COVER_BASE = 'https://art.gametdb.com/wii/cover';
function gametdbCoverUrl(gameId) {
    return `${GAMETDB_COVER_BASE}/${gametdbRegion(gameId)}/${encodeURIComponent(gameId)}.png`;
}

// Downloads the missing covers of `entries` (recentGames/favoriteGames-shaped, carrying `params.gameId`) from GameTDB into the
// launcher's own cache folder — ONLY for entries actually visible (quick-launch bar + favorite), never for the whole library.
// `download` is injected (the test mocks it; main passes `downloadFile` of `lib/net.js`). Best effort — does not throw, sets
// `entry.cover` IN PLACE on a successful download. Returns the number of downloads.
/**
 * @param {Array<{ cover?: string|null, params?: { gameId?: string|null } }>} entries
 * @param {{ download?: (url: string, destPath: string) => Promise<boolean>, log?: import('../types.js').Logger }} [opts]
 */
async function ensureDolphinCovers(entries, { download, log = () => {} } = {}) {
    return ensureCoversForEntries(entries, {
        hasKey: (e) => !!(e && e.params && e.params.gameId),
        destPath: (e) => dolphinCoverPath(e.params.gameId),
        buildUrl: (e) => gametdbCoverUrl(e.params.gameId),
        logKey: (e) => e.params.gameId,
        logLabel: 'Dolphin',
        download,
        log,
    });
}

module.exports = {
    DOLPHIN_FLATPAK_ID,
    dolphinConfigRoot,
    dolphinCacheRoot,
    translateFlatpakDocPath,
    parseIsoPaths,
    readGameDirs,
    parseDiscHeader,
    extractIsoDiscMeta,
    extractWbfsDiscMeta,
    dolphinGameLabel,
    dolphinGameId,
    dolphinGameArgs,
    findInstalledGames,
    findInstalledGamesCached,
    dolphinCoverCacheDir,
    dolphinCoverPath,
    dolphinNativeCoverPath,
    resolveDolphinCover,
    gametdbRegion,
    gametdbCoverUrl,
    ensureDolphinCovers,
};
