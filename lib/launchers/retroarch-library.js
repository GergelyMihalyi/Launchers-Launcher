// @ts-check
'use strict';

// RetroArch ROM discovery: RetroArch ITSELF maintains a scanned playlist JSON per system (`playlists/<System>.lpl`: `path`,
// `label`) — that is the authoritative ROM list, no own folder walk / extension → core table. Size gotcha: the playlists hold
// ~15,700 items together, so the module returns a per-system SUMMARY (`findSystemCounts`), the browsable list is separate
// (drill-down). Background: docs/dev/launchers/retroarch.md

const fs = require('fs');
const path = require('path');
const { appConfigRoot } = require('../xdg.js');
const { msToLaunchedAt } = require('../recent/recent-games.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { ensureCoversForEntries } = require('./shared/cover-cache.js');

// The { label, path } entries from the content of an .lpl playlist JSON ("core_path": "DETECT" means RetroArch's own content
// database picks the core at launch — so there is no separate core-mapping table here).
const isPlaylistItem = (it) => !!it && typeof it === 'object' && typeof it.path === 'string';

function parsePlaylist(playlistText) {
    const data = typeof playlistText === 'string' ? JSON.parse(playlistText) : playlistText;
    // A single non-object item of a corrupt / hand-edited `.lpl` must not drop the whole system
    // (the caller's try would otherwise return an empty list).
    const items = Array.isArray(data && data.items) ? data.items.filter(isPlaylistItem) : [];
    return items.map((it) => ({ label: it.label, path: it.path }));
}

function systemNameFromFile(fileName) {
    return fileName.replace(/\.lpl$/, '');
}

// Only for the ROM COUNT (findSystemCounts): counts the occurrences of the `"path"` key in the raw text, WITHOUT `JSON.parse` — an
// .lpl may hold 5000+ objects, a full parse means a memory peak + GC on every call. The .lpl contains exactly one `"path":` per item
// and no `path` among the top-level keys — the count is exact. The fields + sorting (findGamesForSystem) still need `parsePlaylist`.
const PLAYLIST_PATH_KEY_RE = /"path"\s*:/g;
function countPlaylistItems(playlistText) {
    const m = String(playlistText).match(PLAYLIST_PATH_KEY_RE);
    return m ? m.length : 0;
}

// The flatpak app ID appears in code ONLY here (matches `flathubId` in `data/launcher-catalog.json` —
// test/contracts/flatpak-ids.test.js); import this constant elsewhere.
const RETROARCH_FLATPAK_ID = 'org.libretro.RetroArch';

function retroarchConfigRoot() {
    return appConfigRoot(RETROARCH_FLATPAK_ID, 'retroarch'); // native: ~/.config/retroarch
}

// The playlists/ folder does NOT contain only .lpl files (e.g. "logs"/"builtin" subfolders exist on the machine) — only files with
// the .lpl extension are considered.
function listPlaylistFiles(playlistsDir) {
    let entries;
    try {
        entries = fs.readdirSync(playlistsDir, { withFileTypes: true });
    } catch (err) {
        return [];
    }
    return entries.filter((e) => e.isFile() && e.name.endsWith('.lpl')).map((e) => e.name);
}

// ROM count per system — see the size gotcha at the top of the file.
function findSystemCounts(retroarchRoot) {
    const playlistsDir = path.join(retroarchRoot, 'playlists');
    const counts = [];
    for (const file of listPlaylistFiles(playlistsDir)) {
        let count;
        try {
            count = countPlaylistItems(fs.readFileSync(path.join(playlistsDir, file), 'utf8'));
        } catch (err) {
            continue;
        }
        if (count) counts.push({ system: systemNameFromFile(file), count });
    }
    counts.sort((a, b) => a.system.localeCompare(b.system, 'hu'));
    return counts;
}

// The `.lpl` files are JSON (the biggest, NES, 5000+ items, only a few MB). On a much bigger (broken/foreign) file the synchronous
// `JSON.parse` would block the main event loop (the melonDS freeze lesson) — the fields need a real `JSON.parse` here, so we only
// guard with a SIZE limit. `countPlaylistItems()` is DELIBERATELY regex-based, without `JSON.parse`.
const MAX_PLAYLIST_BYTES = 64 * 1024 * 1024;

// The full ROM list of one system (entering the system in the Games panel, as a cover grid). Sorted by `label` (numeric,
// accent-insensitive — the `.lpl` order is reverse alphabetical with anomalies). Every entry gets a `cover` too — ONLY a thumbnail
// ALREADY on the LOCAL disk (`resolveRetroarchThumbnail`, only `fs.existsSync`, no network); filling in the MISSING covers is the job
// of the renderer's lazy, focus-near batched query + the `ensure-retroarch-game-covers` IPC.
function findGamesForSystem(retroarchRoot, system) {
    const playlistPath = path.join(retroarchRoot, 'playlists', `${system}.lpl`);
    let games;
    try {
        // Size check BEFORE readFileSync/JSON.parse — see MAX_PLAYLIST_BYTES above.
        if (fs.statSync(playlistPath).size > MAX_PLAYLIST_BYTES) return [];
        games = parsePlaylist(fs.readFileSync(playlistPath, 'utf8'));
    } catch (err) {
        return [];
    }
    return games
        .sort((a, b) => String(a.label).localeCompare(String(b.label), 'hu', { numeric: true, sensitivity: 'base' }))
        .map((g) => ({ ...g, cover: resolveRetroarchThumbnail(retroarchRoot, system, g.label) }));
}

// The FULL RetroArch ROM set to merge into the Games panel's "ALL" view — grouped by system (`[{ system, games: [{ label, path,
// cover }] }]`) so the system name is not repeated ~15,700 times over the IPC. Does NOT sort (the renderer sorts everything in one go
// with a single Intl.Collator) and no network: like `findGamesForSystem()`, `cover` is ONLY a thumbnail already on the LOCAL disk.
// A broken/oversized playlist is skipped (an empty system is left out of the output).
function findAllGames(retroarchRoot) {
    const playlistsDir = path.join(retroarchRoot, 'playlists');
    const out = [];
    for (const file of listPlaylistFiles(playlistsDir)) {
        const system = systemNameFromFile(file);
        let games;
        try {
            const playlistPath = path.join(playlistsDir, file);
            if (fs.statSync(playlistPath).size > MAX_PLAYLIST_BYTES) continue;
            games = parsePlaylist(fs.readFileSync(playlistPath, 'utf8'));
        } catch (err) {
            continue;
        }
        if (!games.length) continue;
        out.push({
            system,
            games: games.map((g) => ({ ...g, cover: resolveRetroarchThumbnail(retroarchRoot, system, g.label) })),
        });
    }
    return out;
}

// System name (the `.lpl` file name without extension) → file name of the INSTALLED core under `cores/`. The playlists'
// `default_core_path` is empty, so the table was built from the `cores/*.info` files (`display_name`/`systemname`/
// `supported_extensions`), only for the ACTUALLY installed cores. Anything missing (e.g. PSP) has no core — PSP is handled by the
// PPSSPP launcher.
const SYSTEM_CORES = {
    'DOS': 'dosbox_pure_libretro.so',
    'MAME 2003-Plus': 'mame2003_plus_libretro.so',
    'Nintendo - Family Computer Disk System': 'mesen_libretro.so',
    'Nintendo - Nintendo 64': 'mupen64plus_next_libretro.so',
    'Nintendo - Nintendo Entertainment System': 'mesen_libretro.so',
    'Nintendo - Super Nintendo Entertainment System': 'mednafen_supafaust_libretro.so',
    'Sega - Game Gear': 'genesis_plus_gx_libretro.so',
    'Sega - Master System - Mark III': 'genesis_plus_gx_libretro.so',
    'Sega - Mega Drive - Genesis': 'genesis_plus_gx_libretro.so',
    'Sega - SG-1000': 'genesis_plus_gx_libretro.so',
    'Sony - PlayStation': 'mednafen_psx_hw_libretro.so',
};

function coreForSystem(system) {
    return SYSTEM_CORES[system] || null;
}

// If RetroArch did not recognize the content (no CRC match), `label`/`db_name` in `content_history.lpl` stays an EMPTY STRING
// (verified on the machine) — `path`/`core_name` are present. Fallback: `systemFromCoreName()` from `core_name` (cutting the
// " (<core variant>)" suffix), `labelFromPath()` from the file name. **Limitation:** for a core serving several systems (e.g. Genesis
// Plus GX) the derived system may be wrong — the cover download then gets a 404, but the NAME is always right.
function systemFromCoreName(coreName) {
    if (!coreName) return null;
    return String(coreName).replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
}

function labelFromPath(p) {
    if (!p) return null;
    const base = path.basename(String(p));
    const stem = base.replace(/\.[^./\\]+$/, '');
    return stem || null;
}

// RetroArch's OWN "recently played" playlist: playlists/builtin/content_history.lpl (the `content_history_path` cfg key), already in
// recency order (RetroArch inserts at the START of the list). `items[].db_name` (`<System>.lpl`) gives the system. Reading it, the
// quick-launch bar also catches ROMs started from RetroArch's own UI, not only those launched from our Games panel.
function parseContentHistory(historyText) {
    const data = typeof historyText === 'string' ? JSON.parse(historyText) : historyText;
    const items = Array.isArray(data && data.items) ? data.items.filter(isPlaylistItem) : [];
    return items.map((it) => ({
        label: it.label || labelFromPath(it.path),
        path: it.path,
        system: (it.db_name ? String(it.db_name).replace(/\.lpl$/, '') : null) || systemFromCoreName(it.core_name),
    }));
}

// The most recently played (at most `max`) ROMs, as `recentGames` entries — for the quick-launch bar.
function findRecentGames(retroarchRoot, max = 3) {
    const histPath = path.join(retroarchRoot, 'playlists', 'builtin', 'content_history.lpl');
    let items;
    try {
        items = parseContentHistory(fs.readFileSync(histPath, 'utf8'));
    } catch (err) {
        return [];
    }
    // The `.lpl` has no per-entry timestamp; the file mtime ≈ the last RetroArch launch (the history is rewritten on every launch).
    // Entry i gets `mtime - i*1000` — the order within the list is stable, and the global "Continue" merge approximates chronology
    // (`lastLaunchedAt` is exact for Steam/Heroic entries).
    let mtimeMs = Date.now();
    try { mtimeMs = fs.statSync(histPath).mtimeMs; } catch (err) { /* keep now */ }
    return items.slice(0, Math.max(0, max)).map((it, i) => ({
        key: `retroarch:${it.system}:${it.label}`,
        name: it.label,
        cover: it.system ? resolveRetroarchThumbnail(retroarchRoot, it.system, it.label) : null,
        kind: 'retroarch',
        params: { system: it.system, path: it.path },
        lastLaunchedAt: msToLaunchedAt(mtimeMs - i * 1000),
    }));
}

// Location of the scanned boxarts: `thumbnails/<System>/Named_Boxarts/<label>.png` (`<label>` with RetroArch's file-name cleanup: the
// `& * / : ` < > ? |` characters replaced by `_`). Used by the quick-launch bar (`launch-retroarch-game` puts it into the `cover` field
// of `recentGames`); no image → null.
function retroarchThumbnailLabel(label) {
    return String(label == null ? '' : label).replace(/[&*/:`<>?|]/g, '_');
}

function resolveRetroarchThumbnail(retroarchRoot, system, label) {
    const file = retroarchThumbnailPath(retroarchRoot, system, label);
    try {
        return fs.existsSync(file) ? file : null;
    } catch (err) {
        return null;
    }
}

function retroarchThumbnailPath(retroarchRoot, system, label) {
    return path.join(
        retroarchRoot, 'thumbnails', system, 'Named_Boxarts', `${retroarchThumbnailLabel(label)}.png`,
    );
}

// RetroArch's public, static thumbnail store (the RetroArch client hardcodes it too, there is no cfg key). Same layout as the local
// `thumbnails/` folder:
//   <base>/<System>/Named_Boxarts/<cleaned label>.png
const LIBRETRO_THUMB_BASE = 'https://thumbnails.libretro.com';

function libretroThumbnailUrl(system, label) {
    const sys = encodeURIComponent(String(system == null ? '' : system));
    const name = encodeURIComponent(`${retroarchThumbnailLabel(label)}.png`);
    return `${LIBRETRO_THUMB_BASE}/${sys}/Named_Boxarts/${name}`;
}

// Downloads the missing covers of the `findRecentGames()` output from the libretro thumbnail server into RetroArch's OWN
// `thumbnails/<System>/Named_Boxarts/` folder (so the RetroArch UI sees them too, and `resolveRetroarchThumbnail()` finds them
// synchronously next time — no 2nd search location). `download(url, destPath) => Promise<boolean>` is injected (the test mocks it, no
// network; main passes `downloadFile` of `lib/net.js`). Entries that already have a cover / no system are skipped; on success
// `entry.cover` is set IN PLACE. Returns the number actually downloaded. Best effort — does not throw.
/**
 * @param {string} retroarchRoot
 * @param {import('../types.js').RecentGameEntry[]} entries
 * @param {{ download?: (url: string, destPath: string) => Promise<boolean>, log?: import('../types.js').Logger }} [opts]
 */
async function ensureRecentThumbnails(retroarchRoot, entries, { download, log = () => {} } = {}) {
    return ensureCoversForEntries(entries, {
        hasKey: (e) => !!(e && e.params && e.params.system && e.name),
        destPath: (e) => retroarchThumbnailPath(retroarchRoot, e.params.system, e.name),
        buildUrl: (e) => libretroThumbnailUrl(e.params.system, e.name),
        logKey: (e) => e.name,
        logLabel: 'RetroArch',
        download,
        log,
    });
}

// FULL path of the core .so, or null if the table has no entry for it OR the file is not actually on disk (the table and the actually
// installed cores may drift apart after a future RetroArch update/core removal). Core location: the config root's `cores/` (flatpak
// AND the native online updater), for a native distro package the system libretro folder (⚠️ not verified on the machine).
const SYSTEM_CORE_DIRS = ['/usr/lib/x86_64-linux-gnu/libretro', '/usr/lib/libretro', '/usr/lib64/libretro'];

function corePathForSystem(retroarchRoot, system, systemDirs = SYSTEM_CORE_DIRS) {
    const core = coreForSystem(system);
    if (!core) return null;
    for (const dir of [path.join(retroarchRoot, 'cores'), ...systemDirs]) {
        const fullPath = path.join(dir, core);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
}

// TTL-cached variants for the games-panel IPCs (called by main) — the raw functions stay pure for tests.
const findSystemCountsCached = createTtlCache(findSystemCounts, GAMES_CACHE_TTL_MS);
const findGamesForSystemCached = createTtlCache(findGamesForSystem, GAMES_CACHE_TTL_MS);

module.exports = {
    RETROARCH_FLATPAK_ID,
    findAllGames,
    parsePlaylist,
    countPlaylistItems,
    systemNameFromFile,
    listPlaylistFiles,
    findSystemCounts,
    findSystemCountsCached,
    findGamesForSystem,
    findGamesForSystemCached,
    MAX_PLAYLIST_BYTES,
    parseContentHistory,
    systemFromCoreName,
    labelFromPath,
    findRecentGames,
    coreForSystem,
    corePathForSystem,
    retroarchThumbnailLabel,
    resolveRetroarchThumbnail,
    retroarchThumbnailPath,
    libretroThumbnailUrl,
    ensureRecentThumbnails,
    LIBRETRO_THUMB_BASE,
    retroarchConfigRoot,
};
