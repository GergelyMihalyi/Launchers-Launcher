// @ts-check
'use strict';

// PCSX2 (PS2 emulator) disc-image discovery, without crypto.
// `.iso` is plain ISO9660: a minimal parser (PVD → root → `SYSTEM.CNF`) gets the serial (e.g. `SCUS-97472`) with a few positioned
// `fs.readSync` calls, without reading the whole disc image; the official title comes from PCSX2's own `GameIndex.yaml` (read live,
// with a regex). Non-ISO formats (.cue/.mdf/.nrg/.chd/.cso/.zso) only get a file-name based title.
// "Recently played": from `inis/playtime.dat`, at read time. Details: docs/dev/launchers/pcsx2.md

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');
const { coverCacheDir, coverPath, resolveCachedCover, ensureCoversForEntries } = require('./shared/cover-cache.js');
const { SECTOR_SIZE, findDirEntry, readRootDirectory } = require('./shared/iso9660.js');
const { appConfigRoot } = require('../xdg.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { buildRecentEntries } = require('../recent/recent-games.js');
const { lookupGameName, parseGameListDirs, parsePlaytime } = require('./shared/ps-game-db.js');
const { filterExistingDirs, walkFilesByExtension } = require('../dir-browse.js');

const PCSX2_FLATPAK_ID = 'net.pcsx2.PCSX2';

function pcsx2ConfigRoot() {
    return appConfigRoot(PCSX2_FLATPAK_ID, 'PCSX2'); // native: ~/.config/PCSX2
}

// Disc-image formats resolvable by serial (plain ISO9660, readable without crypto) vs. other formats that only show up as a
// file-name based row.
const ISO_EXTENSIONS = new Set(['.iso']);
const OTHER_DISC_EXTENSIONS = new Set(['.cue', '.mdf', '.nrg', '.chd', '.cso', '.zso']);
// Do not descend needlessly into a deep/broken folder structure.
const MAX_SCAN_DEPTH = 3;

// The `RecursivePaths =`/`Paths =` lines of the `[GameList]` section of `PCSX2.ini` — `parseGameListDirs` of
// `lib/launchers/shared/ps-game-db.js` (BYTE-IDENTICAL to DuckStation's `settings.ini`), re-exported here.

// The ROM search folders read from `PCSX2.ini` — only those that actually exist (a flatpak document-portal path may expire if
// PCSX2's permission is reset). Missing/broken ini -> empty list. Dedup + existence filter is the shared `filterExistingDirs` of
// `lib/dir-browse.js`.
function readGameDirs(configRoot) {
    let iniText;
    try {
        iniText = fs.readFileSync(path.join(configRoot, 'inis', 'PCSX2.ini'), 'utf8');
    } catch (err) {
        return [];
    }
    return filterExistingDirs(parseGameListDirs(iniText));
}

// `BOOT2 = cdrom0:\SCUS_974.72;1` — the disc's serial in the PS2 boot config.
const BOOT2_RE = /BOOT2\s*=\s*cdrom0:\\?([A-Za-z0-9]{4})_(\d{3})\.(\d{2})/;

function normalizeSerial(prefix, mid, suffix) {
    return `${prefix.toUpperCase()}-${mid}${suffix}`;
}

// The PVD/root-directory traversal core lives in `lib/launchers/shared/iso9660.js` (shared with PPSSPP/DuckStation) — here only
// the byte reader is added (plain, positioned `fs.readSync`, without reading the WHOLE disc image), and the `SYSTEM.CNF;1` content
// is matched against the `BOOT2` line. Non-ISO extension / broken-unknown structure → `null` (the caller falls back to a file-name
// based title), NEVER throws.
function extractSerialFromIso(isoPath) {
    let fd;
    try {
        fd = fs.openSync(isoPath, 'r');
    } catch (err) {
        return null;
    }
    try {
        const reader = (offset, length) => {
            const buf = Buffer.alloc(length);
            let n;
            try {
                n = fs.readSync(fd, buf, 0, length, offset);
            } catch (err) {
                return null;
            }
            return n === length ? buf : null;
        };

        const rootDir = readRootDirectory(reader);
        if (!rootDir) return null;

        const sysCnf = findDirEntry(rootDir, 'SYSTEM.CNF;1');
        if (!sysCnf || !sysCnf.size || sysCnf.size > 4096) return null; // sanity limit

        const cnfBuf = reader(sysCnf.lba * SECTOR_SIZE, sysCnf.size);
        if (!cnfBuf) return null;
        const m = BOOT2_RE.exec(cnfBuf.toString('ascii'));
        return m ? normalizeSerial(m[1], m[2], m[3]) : null;
    } catch (err) {
        return null;
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed/broken */ }
    }
}

// The `files/bin/resources/` folder of the flatpak install (`GameIndex.yaml` is read from here live) — both the user- AND
// system-level flatpak install roots are considered.
function pcsx2ResourcesDirs(homeDir = os.homedir()) {
    return [
        path.join(homeDir, '.local', 'share', 'flatpak', 'app', PCSX2_FLATPAK_ID, 'x86_64', 'stable', 'active', 'files', 'bin', 'resources'),
        path.join('/var', 'lib', 'flatpak', 'app', PCSX2_FLATPAK_ID, 'x86_64', 'stable', 'active', 'files', 'bin', 'resources'),
        // Native install (distro package / manual) — ⚠️ not verified on the machine
        '/usr/share/PCSX2/resources', '/usr/lib/pcsx2/resources', '/opt/pcsx2/resources',
    ];
}

function findPcsx2ResourcesDir(homeDir) {
    for (const dir of pcsx2ResourcesDirs(homeDir)) {
        try {
            if (fs.statSync(path.join(dir, 'GameIndex.yaml')).isFile()) return dir;
        } catch (err) { /* try the next install root */ }
    }
    return null;
}

// `lookupGameName`, which searches `GameIndex.yaml`, lives in `lib/launchers/shared/ps-game-db.js` (BYTE-IDENTICAL schema to
// DuckStation's `gamedb.yaml`), re-exported here.

// One-off, process-lifetime read + cache of `GameIndex.yaml` (the file does not change until a PCSX2 update — no TTL cache
// needed, unlike the games-library queries).
let cachedGameIndexText = null;
function pcsx2GameIndexText(homeDir) {
    if (cachedGameIndexText !== null) return cachedGameIndexText;
    const dir = findPcsx2ResourcesDir(homeDir);
    try {
        cachedGameIndexText = dir ? fs.readFileSync(path.join(dir, 'GameIndex.yaml'), 'utf8') : '';
    } catch (err) {
        cachedGameIndexText = '';
    }
    return cachedGameIndexText;
}

// `inis/playtime.dat` — `parsePlaytime` of `lib/launchers/shared/ps-game-db.js` (BYTE-IDENTICAL to DuckStation's `playtime.dat`),
// re-exported here.
function readPlaytime(configRoot) {
    try {
        return parsePlaytime(fs.readFileSync(path.join(configRoot, 'inis', 'playtime.dat'), 'utf8'));
    } catch (err) {
        return new Map();
    }
}

// File-name cleanup fallback (no serial / GameIndex match) — the shared `cleanFilenameLabel` of `lib/launchers/shared/game-id.js`.
function pcsx2GameLabel(rawName) {
    return cleanFilenameLabel(rawName);
}

// Stable id of a disc image: the serial if it can be extracted, otherwise a `p:`-prefixed substitute derived from the file path.
function pcsx2GameId(serial, filePath) {
    return serial || pathHashId(filePath);
}

// The launch argument list (flatpak-shaped: `run <appid> …` — for native, `variantExecSpec` strips the prefix).
// No `meta`: "recently played" comes from `playtime.dat`.
function pcsx2GameArgs(discPath) {
    return ['run', PCSX2_FLATPAK_ID, discPath];
}

// The serial-resolvable `.iso` + the file-name-only other formats together — walked by the shared `walkFilesByExtension` of
// `lib/dir-browse.js`.
const ALL_DISC_EXTENSIONS = new Set([...ISO_EXTENSIONS, ...OTHER_DISC_EXTENSIONS]);

// The installed (browsable) PS2 disc images — by walking the `[GameList]` folders. Serial + official title + playtime for `.iso`;
// only a file-name based title for other formats (accepted limitation). `homeDir` is always `os.homedir()` on the real machine —
// only tests need to override it (temp `HOME` fixture), so it is defaulted here, not in the caller (the
// `findInstalledGamesCached(...)` signature thus matches the other emulator modules: `configRoot` is enough).
function findInstalledGames(configRoot, homeDir = os.homedir()) {
    const dirs = readGameDirs(configRoot);
    const files = [];
    for (const dir of dirs) files.push(...walkFilesByExtension(dir, ALL_DISC_EXTENSIONS, { maxDepth: MAX_SCAN_DEPTH }));

    const yamlText = pcsx2GameIndexText(homeDir);
    const playtime = readPlaytime(configRoot);

    const games = [];
    const seenIds = new Set();
    for (const file of files) {
        const base = path.basename(file);
        const ext = path.extname(base).toLowerCase();
        const serial = ISO_EXTENSIONS.has(ext) ? extractSerialFromIso(file) : null;
        const officialName = serial ? lookupGameName(yamlText, serial) : null;
        const name = officialName || pcsx2GameLabel(base);

        const id = pcsx2GameId(serial, file);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const pt = serial ? playtime.get(serial) : null;
        games.push({
            id,
            name,
            path: file,
            serial: serial || null,
            cover: serial ? resolvePcsx2Cover(serial) : null,
            lastPlayedAt: pt ? pt.lastPlayedAt : null,
        });
    }
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

// TTL-cached variant for the `list-pcsx2-games` IPC (the raw `findInstalledGames` stays pure for tests).
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

// "Recently played": calls `findInstalledGamesCached()` (NOT the raw `findInstalledGames`), with a single `configRoot` argument and
// no `homeDir` — the same `createTtlCache` key (`JSON.stringify(args)`) as the `list-pcsx2-games` IPC, so the expensive scan runs
// once. `homeDir` is only for tests. `buildRecentEntries` guarantees an ISO-string `lastLaunchedAt`.
function findRecentlyPlayed(configRoot, homeDir, max = 3) {
    const games = homeDir === undefined
        ? findInstalledGamesCached(configRoot)
        : findInstalledGamesCached(configRoot, homeDir);
    return recentFromGames(games, max);
}

// "Recently played" from an already read list (the worker-scan result — called by the descriptor's `recent`).
function recentFromGames(games, max = 3) {
    return buildRecentEntries(games, {
        timeMs: (g) => g.lastPlayedAt,
        max,
        key: (g) => `pcsx2-game-${g.id}`,
        kind: 'pcsx2',
        params: (g) => ({ path: g.path, serial: g.serial }),
    });
}

// --- Cover (`xlenore/ps2-covers` GitHub repo) ---

function pcsx2CoverCacheDir() {
    return coverCacheDir('pcsx2');
}

function pcsx2CoverPath(serial) {
    return coverPath('pcsx2', serial, 'jpg');
}

// Only returns a downloaded cover ALREADY on disk (self-healing — no network, never throws).
function resolvePcsx2Cover(serial) {
    return resolveCachedCover('pcsx2', serial, 'jpg');
}

const PS2_COVERS_BASE = 'https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default';

function ps2CoverUrl(serial) {
    return `${PS2_COVERS_BASE}/${encodeURIComponent(serial)}.jpg`;
}

// Downloads the missing covers of `entries` (recentGames/favoriteGames-shaped, carrying `params.serial`) from `xlenore/ps2-covers`
// into the launcher's own cache folder — ONLY for entries actually visible (quick-launch bar / favorite), never for the whole
// library. The loop is the shared `ensureCoversForEntries` of `lib/launchers/shared/cover-cache.js`.
/**
 * @param {Array<{ cover?: string|null, params?: { serial?: string|null } }>} entries
 * @param {{ download?: (url: string, destPath: string) => Promise<boolean>, log?: import('../types.js').Logger }} [opts]
 */
async function ensurePcsx2Covers(entries, { download, log = () => {} } = {}) {
    return ensureCoversForEntries(entries, {
        hasKey: (e) => !!(e && e.params && e.params.serial),
        destPath: (e) => pcsx2CoverPath(e.params.serial),
        buildUrl: (e) => ps2CoverUrl(e.params.serial),
        logKey: (e) => e.params.serial,
        logLabel: 'PCSX2',
        download,
        log,
    });
}

module.exports = {
    PCSX2_FLATPAK_ID,
    pcsx2ConfigRoot,
    parseGameListDirs,
    readGameDirs,
    extractSerialFromIso,
    lookupGameName,
    parsePlaytime,
    readPlaytime,
    pcsx2GameLabel,
    pcsx2GameId,
    pcsx2GameArgs,
    findInstalledGames,
    findInstalledGamesCached,
    findRecentlyPlayed,
    recentFromGames,
    pcsx2CoverCacheDir,
    pcsx2CoverPath,
    resolvePcsx2Cover,
    ps2CoverUrl,
    ensurePcsx2Covers,
};
