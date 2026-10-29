// @ts-check
'use strict';

// Ryujinx (Ryubing fork) Switch ROM discovery, WITHOUT decoding ROMs (NSP/XCI are encrypted; the "zero crypto" principle).
// ROMs come from the `game_dirs`/`autoload_dirs` folders of `Config.json`; the title ID from a `[XXXXXXXXXXXXXXXX]` pattern in the
// file name or the "Title ID" line of a `.nfo`/`.txt` next to the ROM (the latter also gives a ready, official title). Update/DLC files
// are skipped by a name-pattern filter (`isLikelyUpdateOrDlc`). Cover: downloaded into the launcher's own cache from `api.nlib.cc`,
// lazily, only for visible entries. Details (and the CLI flag gotcha): docs/dev/launchers/ryujinx.md

const fs = require('fs');
const path = require('path');
const { pathHashId } = require('./shared/game-id.js');
const { coverCacheDir, coverPath, resolveCachedCover, ensureCoversForEntries } = require('./shared/cover-cache.js');
const { appConfigRoot } = require('../xdg.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { filterExistingDirs, walkFilesByExtension } = require('../dir-browse.js');

const RYUJINX_FLATPAK_ID = 'io.github.ryubing.Ryujinx';

function ryujinxConfigRoot() {
    return appConfigRoot(RYUJINX_FLATPAK_ID, 'Ryujinx'); // native: ~/.config/Ryujinx
}

// Extensions of browsable/runnable Switch content — `nca`/`nso` are deliberately left out (system/code files, not standalone
// launchable "games").
const ROM_EXTENSIONS = new Set(['.nsp', '.xci', '.nsz', '.xcz']);
// Do not descend needlessly into a deep/broken folder structure (e.g. a circular symlink chain).
const MAX_SCAN_DEPTH = 3;

// The `game_dirs` (primary) + `autoload_dirs` (additional) fields of `Config.json` — only folders that actually exist (a flatpak
// document-portal path may expire if Ryujinx's permission is reset). Missing/broken Config.json -> empty list, never throws.
function readGameDirs(configRoot) {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(path.join(configRoot, 'Config.json'), 'utf8'));
    } catch (err) {
        return [];
    }
    const raw = [
        ...(Array.isArray(cfg.game_dirs) ? cfg.game_dirs : []),
        ...(Array.isArray(cfg.autoload_dirs) ? cfg.autoload_dirs : []),
    ];
    return filterExistingDirs(raw);
}

// Update/DLC-like file/folder name — heuristic (name pattern only, not ROM content). DELIBERATELY a SUBSTRING match (no `\b` word
// boundary) — e.g. for "mariokart8deluxeupd17.nsp" (a user dump without separators) a `\bupd\b` would NOT match.
const UPDATE_DLC_PATTERN = /update|dlc|patch|upd/i;
function isLikelyUpdateOrDlc(name) {
    return UPDATE_DLC_PATTERN.test(String(name == null ? '' : name));
}

// A 16-hex-digit title ID in `[...]` in the file/folder name (own dump / nxdumptool convention).
const BRACKET_TITLE_ID_RE = /\[([0-9A-Fa-f]{16})\]/;
function extractTitleIdFromName(name) {
    const m = BRACKET_TITLE_ID_RE.exec(String(name == null ? '' : name));
    return m ? m[1].toUpperCase() : null;
}

// Per-line regex for the "Title ID" line of scene-release NFOs — `[.\s]*` also handles dot-padded ASCII-art formatting
// (e.g. "Title ID..............: 01008CF01BAAC000").
const LINE_TITLE_ID_RE = /title\s*id[.\s]*:\s*([0-9A-Fa-f]{16})/i;
// The plain "Title :" line (NOT "Title ID :" — `title` must be followed directly by `[.\s]*:`, and in "Title ID :" the word "ID"
// breaks that match, so no separate exclusion is needed). `[^|]+` stops at the right border ("|") of ASCII-boxed NFOs.
const LINE_TITLE_RE = /\btitle[.\s]*:\s*([^|]+)/i;
const SIDECAR_MAX_BYTES = 20000;

function readSidecarText(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > SIDECAR_MAX_BYTES) return null;
        // ASCII-art NFOs are often not UTF-8 — `latin1` is enough for the title search (non-ASCII characters may get garbled, but the
        // "Title (ID) :" fields stay ASCII).
        return fs.readFileSync(filePath, 'latin1');
    } catch (err) {
        return null;
    }
}

// The title ID / official title found first among the `.nfo`/`.txt` files next to the ROM (combined across files if one only gives
// one of them). Never throws.
function findSidecarInfo(dir) {
    let titleId = null;
    let title = null;
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (err) {
        return { titleId, title };
    }
    for (const name of entries) {
        if (titleId && title) break;
        if (!/\.(nfo|txt)$/i.test(name)) continue;
        const text = readSidecarText(path.join(dir, name));
        if (!text) continue;
        for (const line of text.split(/\r?\n/)) {
            if (!titleId) {
                const m = LINE_TITLE_ID_RE.exec(line);
                if (m) titleId = m[1].toUpperCase();
            }
            if (!title) {
                const m = LINE_TITLE_RE.exec(line);
                if (m) title = m[1].trim();
            }
            if (titleId && title) break;
        }
    }
    return { titleId, title };
}

// File-name cleanup fallback (no NFO title): strips extension/title-id brackets/version tags, `_`/`.` -> space, and the
// "<Title> NSW-GROUP" / "<Title>-GROUP" scene tag at the end. Not meant to be perfect.
function ryujinxGameLabel(rawName) {
    let s = String(rawName == null ? '' : rawName).replace(/\.[^./\\]+$/, '');
    s = s.replace(/\[[0-9A-Fa-f]{16}\]/g, '');
    s = s.replace(/\[v\d+\]/gi, '');
    s = s.replace(/\[UPD\]/gi, '');
    s = s.replace(/[_.]+/g, ' ');
    s = s.replace(/\s*(?:NSW-|-)[A-Za-z0-9]{2,}\s*$/i, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s || String(rawName == null ? '' : rawName).trim();
}

// Stable id of a ROM: the title ID if it can be extracted, otherwise a `p:`-prefixed substitute derived from the file path (NOT a
// real title ID — the cover download/pin key uses it uniformly, both `findInstalledGames()` AND the `launch-ryujinx-game` IPC — so
// the latter needs no separate `id` field in the payload, `path`+`titleId` is enough).
function ryujinxGameId(titleId, filePath) {
    return titleId || pathHashId(filePath);
}

// The launch argument list (flatpak-shaped: `run <appid> …` — for native, `variantExecSpec` strips the prefix).
// `path` is the chosen ROM's absolute path. ⚠️ NEVER call the Ryujinx CLI with an unknown flag (`--help`): it starts the GUI.
function ryujinxGameArgs(romPath) {
    return ['run', RYUJINX_FLATPAK_ID, romPath];
}

// The installed (browsable) Switch games — by walking `game_dirs`/`autoload_dirs` (the shared `walkFilesByExtension` of
// `lib/dir-browse.js`). `id` = the title ID if it can be extracted, otherwise a stable, `p:`-prefixed substitute derived from the file
// path (NOT a real title ID — so the cover download only looks at the `titleId` field, see `ensureRyujinxCovers`). Missing/empty
// `game_dirs` -> empty list.
function findInstalledGames(configRoot) {
    const gameDirs = readGameDirs(configRoot);
    const files = [];
    for (const dir of gameDirs) files.push(...walkFilesByExtension(dir, ROM_EXTENSIONS, { maxDepth: MAX_SCAN_DEPTH }));

    const games = [];
    const seenIds = new Set();
    for (const file of files) {
        const base = path.basename(file);
        const dir = path.dirname(file);
        if (isLikelyUpdateOrDlc(base) || isLikelyUpdateOrDlc(path.basename(dir))) continue;

        let titleId = extractTitleIdFromName(base) || extractTitleIdFromName(path.basename(dir));
        const sidecar = findSidecarInfo(dir);
        if (!titleId) titleId = sidecar.titleId;

        // Scene-release pattern: the descriptive title is in the FOLDER name, the file name is a cryptic abbreviation
        // (e.g. "Metroid_Dread_NSW-VENOM/v-metroid_dread.xci") — prefer the folder name, UNLESS the file sits directly in a
        // `game_dirs` root (e.g. a flat "[titleId].xci" file).
        const rawLabel = gameDirs.includes(dir) ? base : path.basename(dir);
        const name = sidecar.title || ryujinxGameLabel(rawLabel);

        const id = ryujinxGameId(titleId, file);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        games.push({
            id,
            name,
            path: file,
            titleId: titleId || null,
            cover: titleId ? resolveRyujinxCover(titleId) : null,
        });
    }
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

// --- Cover ---

function ryujinxCoverCacheDir() {
    return coverCacheDir('ryujinx');
}

function ryujinxCoverPath(titleId) {
    return coverPath('ryujinx', titleId, 'jpg');
}

// Only returns a downloaded cover ALREADY on disk (self-healing — no network, never throws).
function resolveRyujinxCover(titleId) {
    return resolveCachedCover('ryujinx', titleId, 'jpg');
}

const NLIB_API_BASE = 'https://api.nlib.cc/nx';
const COVER_ICON_SIZE = 256;

function nlibIconUrl(titleId, size = COVER_ICON_SIZE) {
    return `${NLIB_API_BASE}/${encodeURIComponent(titleId)}/icon/${size}`;
}

// Downloads the missing covers of `entries` (recentGames/favoriteGames-shaped, carrying `params.titleId`) from `api.nlib.cc` into the
// launcher's own cache folder — ONLY for entries actually visible (quick-launch bar / favorite), never for the whole library.
// `download` is injected (the test mocks it; main passes `downloadFile` of `lib/net.js`). Best effort — does not throw, sets
// `entry.cover` IN PLACE on a successful download. Returns the number actually downloaded.
/**
 * @param {Array<{ cover?: string|null, params?: { titleId?: string|null } }>} entries
 * @param {{ download?: (url: string, destPath: string) => Promise<boolean>, log?: import('../types.js').Logger }} [opts]
 */
async function ensureRyujinxCovers(entries, { download, log = () => {} } = {}) {
    return ensureCoversForEntries(entries, {
        hasKey: (e) => !!(e && e.params && e.params.titleId),
        destPath: (e) => ryujinxCoverPath(e.params.titleId),
        buildUrl: (e) => nlibIconUrl(e.params.titleId),
        logKey: (e) => e.params.titleId,
        logLabel: 'Ryujinx',
        download,
        log,
    });
}

// TTL-cached variant for the `list-ryujinx-games` IPC (the raw `findInstalledGames` stays pure for tests).
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

module.exports = {
    RYUJINX_FLATPAK_ID,
    ryujinxConfigRoot,
    readGameDirs,
    isLikelyUpdateOrDlc,
    extractTitleIdFromName,
    findSidecarInfo,
    ryujinxGameLabel,
    ryujinxGameId,
    ryujinxGameArgs,
    findInstalledGames,
    findInstalledGamesCached,
    ryujinxCoverCacheDir,
    ryujinxCoverPath,
    resolveRyujinxCover,
    nlibIconUrl,
    ensureRyujinxCovers,
};
