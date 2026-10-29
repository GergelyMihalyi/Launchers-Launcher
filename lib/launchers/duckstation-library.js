// @ts-check
'use strict';

// DuckStation (PS1 emulator) disc-image discovery.
// Most disc images are raw CD images (`.bin`+`.cue`, 2352 bytes/sector), so the serial comes from a real ISO9660 traversal
// (PVD → root → `SYSTEM.CNF`, with 2048/2352 sector geometry) — a text search at the start of the disc is NOT enough, the
// `SYSTEM.CNF` content can be anywhere. The official title comes from DuckStation's `gamedb.yaml` (same schema as PCSX2's
// `GameIndex.yaml`); "recently played" from `<configRoot>/playtime.dat` (byte-identical format to PCSX2's `inis/playtime.dat`),
// at read time. A compressed container (e.g. PSX2PSP `.pbp`) only yields a file-name based title (accepted limitation).
// Details: docs/dev/launchers/duckstation.md

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');
const { coverCacheDir, coverPath, resolveCachedCover, ensureCoversForEntries } = require('./shared/cover-cache.js');
const { findDirEntry, readRootDirectory } = require('./shared/iso9660.js');
const { appConfigRoot } = require('../xdg.js');
const { buildRecentEntries } = require('../recent/recent-games.js');
const { lookupGameName, parseGameListDirs, parsePlaytime } = require('./shared/ps-game-db.js');
const { filterExistingDirs, walkFilesByExtension } = require('../dir-browse.js');
const { createFileMetaCache, statSig } = require('../scan/scan-meta-cache.js');

const DUCKSTATION_FLATPAK_ID = 'org.duckstation.DuckStation';

function duckstationConfigRoot() {
    // Natively DuckStation writes everything into its data folder (`~/.local/share/duckstation`) — the flatpak build puts
    // the same under `config/duckstation` (⚠️ the native path is not verified on the machine).
    return appConfigRoot(DUCKSTATION_FLATPAK_ID, 'duckstation', {
        native: (home) => path.join(home, '.local', 'share', 'duckstation'),
    });
}

// `.cue` is primary (the content search runs on the referenced bin/img, see below); the rest are standalone (cue-less)
// disc image/package formats with a best-effort content scan — `.chd` is compressed, typically no match there (only a
// file-name based title, as with PCSX2's non-ISO formats). DELIBERATELY no bare `.bin`/`.img` in the whitelist — every
// `.bin` lives next to a `.cue` and the scan reaches it through the `.cue` (avoids "1 folder = 2 rows for the same game").
const CUE_EXTENSION = '.cue';
const SOLO_DISC_EXTENSIONS = new Set(['.chd', '.pbp', '.iso', '.img']);
// Do not descend needlessly into a deep/broken folder structure.
const MAX_SCAN_DEPTH = 3;

// The `RecursivePaths =`/`Paths =` lines of the `[GameList]` section of `settings.ini` — `parseGameListDirs` of
// `lib/launchers/shared/ps-game-db.js` (BYTE-IDENTICAL to PCSX2's `PCSX2.ini`), re-exported here.

// ROM folders: the `[GameList]` lines of `settings.ini` (existing folders only). The flatpak gets no `host` permission, but
// `settings.ini` already holds the HOST-side portal path (`/run/user/<uid>/doc/…`), so it is readable without translation.
function readGameDirs(configRoot) {
    let iniText;
    try {
        iniText = fs.readFileSync(path.join(configRoot, 'settings.ini'), 'utf8');
    } catch (err) {
        return [];
    }
    return filterExistingDirs(parseGameListDirs(iniText));
}

// `BOOT = cdrom:\SLUS_008.21;1` (PS1) — unlike PS2's `BOOT2 = cdrom0:\...`, `BOOT` (not `BOOT2`) + a `cdrom:` (not
// necessarily `cdrom0:`) prefix; both variants are accepted.
// ⚠️ Found in production (the "Tekken 3" disc): the boot file is NOT always directly in the cdrom root —
// `BOOT = cdrom:\TEKKEN3\SLUS_004.02;1` (the executable is in a subfolder) — hence `(?:[^\;]+\\)*` allows zero or more
// intermediate `<folder>\` segments before the actual `<PREFIX>_<num>.<num>` file name.
const BOOT_RE = /\bBOOT\s*=\s*cdrom0?:\\?(?:[^\\;]+\\)*([A-Za-z0-9]{4})_?(\d{3})\.(\d{2})/;

function normalizeSerial(prefix, mid, suffix) {
    return `${prefix.toUpperCase()}-${mid}${suffix}`;
}

// The serial comes from the disc's REAL ISO9660 structure (not a text search): PVD (logical sector 16) → root →
// `SYSTEM.CNF` LBA+size → read from there. `detectSectorGeometry` tries plain 2048, raw 2352 Mode2/Form1 (dataOffset 24 —
// the typical `.bin`) and Mode1 (16); `readLogical` reads sector by sector, because with a raw geometry the logical bytes are
// not contiguous in the file. Why: docs/dev/launchers/duckstation.md
const SECTOR_SIZE_PLAIN = 2048;
const SECTOR_SIZE_RAW = 2352;
const RAW_MODE1_DATA_OFFSET = 16;
const RAW_MODE2_FORM1_DATA_OFFSET = 24;
const DISC_GEOMETRY_CANDIDATES = [
    { sectorSize: SECTOR_SIZE_PLAIN, dataOffset: 0 },
    { sectorSize: SECTOR_SIZE_RAW, dataOffset: RAW_MODE2_FORM1_DATA_OFFSET },
    { sectorSize: SECTOR_SIZE_RAW, dataOffset: RAW_MODE1_DATA_OFFSET },
];

// Tries the `CD001` magic of the PVD (logical sector 16) with all three geometry candidates — the first match is the disc
// image's actual sector geometry. None matches -> `null`.
function detectSectorGeometry(fd) {
    const buf = Buffer.alloc(6);
    for (const cand of DISC_GEOMETRY_CANDIDATES) {
        let n;
        try {
            n = fs.readSync(fd, buf, 0, buf.length, 16 * cand.sectorSize + cand.dataOffset);
        } catch (err) {
            continue;
        }
        if (n === 6 && buf[0] === 1 && buf.toString('ascii', 1, 6) === 'CD001') return cand;
    }
    return null;
}

// Reads `size` bytes starting at logical sector `lba` with the `geo` geometry — sector by sector (max 2048 bytes/sector),
// because with a raw (2352) geometry the logical bytes are NOT contiguous in the file. `null` if any sector read comes up short.
function readLogical(fd, geo, lba, size) {
    const out = Buffer.alloc(size);
    let read = 0;
    let curLba = lba;
    while (read < size) {
        const chunkLen = Math.min(SECTOR_SIZE_PLAIN, size - read);
        const buf = Buffer.alloc(chunkLen);
        let n;
        try {
            n = fs.readSync(fd, buf, 0, chunkLen, curLba * geo.sectorSize + geo.dataOffset);
        } catch (err) {
            return null;
        }
        if (n !== chunkLen) return null;
        buf.copy(out, read);
        read += chunkLen;
        curLba += 1;
    }
    return out;
}

// The PVD/root-directory traversal core lives in `lib/launchers/shared/iso9660.js` (shared with PCSX2/PPSSPP) — here only the
// byte reader is added (`readLogical`, mapped onto the physical sector geometry found by `detectSectorGeometry`, without reading
// the WHOLE disc image, regardless of its size), and the `SYSTEM.CNF;1` content is matched against the `BOOT` line. For a
// non-ISO9660 container (e.g. a compressed PSX2PSP `.pbp`) `detectSectorGeometry` already returns `null`. NEVER throws.
function extractSerialFromDisc(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (err) {
        return null;
    }
    try {
        const geo = detectSectorGeometry(fd);
        if (!geo) return null;

        // `readRootDirectory`/`findDirEntry` always call the reader with a SECTOR_SIZE_PLAIN (2048)-aligned byte offset —
        // so dividing back to the logical lba is exact.
        const reader = (offsetBytes, length) => readLogical(fd, geo, offsetBytes / SECTOR_SIZE_PLAIN, length);

        const rootDir = readRootDirectory(reader);
        if (!rootDir) return null;

        const sysCnf = findDirEntry(rootDir, 'SYSTEM.CNF;1');
        if (!sysCnf || !sysCnf.size || sysCnf.size > 4096) return null; // sanity limit

        const cnfBuf = reader(sysCnf.lba * SECTOR_SIZE_PLAIN, sysCnf.size);
        if (!cnfBuf) return null;
        const m = BOOT_RE.exec(cnfBuf.toString('ascii'));
        return m ? normalizeSerial(m[1], m[2], m[3]) : null;
    } catch (err) {
        return null;
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed/broken */ }
    }
}

// A `.cue` file is NOT the disc image itself (plain text metadata) — its FIRST `FILE "..."` line references the actual binary
// (`FILE "crash 3.bin" BINARY`), relative to the `.cue`'s folder. A minimal regex, NOT a full CUE-sheet parser. Missing/unreadable
// `.cue` or a nonexistent referenced file -> `null`.
function resolveCueDataFile(cuePath) {
    let text;
    try {
        text = fs.readFileSync(cuePath, 'utf8');
    } catch (err) {
        return null;
    }
    const m = /^\s*FILE\s+"([^"]+)"/m.exec(text);
    if (!m) return null;
    const dataFile = path.join(path.dirname(cuePath), m[1]);
    try {
        return fs.statSync(dataFile).isFile() ? dataFile : null;
    } catch (err) {
        return null;
    }
}

// The `files/bin/resources/` folder of the flatpak install (`gamedb.yaml` is read from here live) — both the user- AND
// system-level flatpak install roots are considered (like PCSX2's `pcsx2ResourcesDirs()`).
function duckstationResourcesDirs(homeDir = os.homedir()) {
    return [
        path.join(homeDir, '.local', 'share', 'flatpak', 'app', DUCKSTATION_FLATPAK_ID, 'x86_64', 'stable', 'active', 'files', 'bin', 'resources'),
        path.join('/var', 'lib', 'flatpak', 'app', DUCKSTATION_FLATPAK_ID, 'x86_64', 'stable', 'active', 'files', 'bin', 'resources'),
        // Native install (AUR / manual) — ⚠️ not verified on the machine
        '/opt/duckstation/resources', '/usr/share/duckstation/resources', '/usr/lib/duckstation/resources',
    ];
}

function findDuckstationResourcesDir(homeDir) {
    for (const dir of duckstationResourcesDirs(homeDir)) {
        try {
            if (fs.statSync(path.join(dir, 'gamedb.yaml')).isFile()) return dir;
        } catch (err) { /* try the next install root */ }
    }
    return null;
}

// `lookupGameName`, which searches `gamedb.yaml`, lives in `lib/launchers/shared/ps-game-db.js` (BYTE-IDENTICAL schema to
// PCSX2's `GameIndex.yaml`), re-exported here.

// One-off, process-lifetime read + cache of `gamedb.yaml` (the file does not change until a DuckStation update).
let cachedGameDbText = null;
function duckstationGameDbText(homeDir) {
    if (cachedGameDbText !== null) return cachedGameDbText;
    const dir = findDuckstationResourcesDir(homeDir);
    try {
        cachedGameDbText = dir ? fs.readFileSync(path.join(dir, 'gamedb.yaml'), 'utf8') : '';
    } catch (err) {
        cachedGameDbText = '';
    }
    return cachedGameDbText;
}

// `playtime.dat` — in the config root (NOT under `inis/` as with PCSX2), `parsePlaytime` of `lib/launchers/shared/ps-game-db.js`
// (BYTE-IDENTICAL to PCSX2's `inis/playtime.dat`), re-exported here.
function readPlaytime(configRoot) {
    try {
        return parsePlaytime(fs.readFileSync(path.join(configRoot, 'playtime.dat'), 'utf8'));
    } catch (err) {
        return new Map();
    }
}

// File-name cleanup fallback (when there is no serial / gamedb match) — the shared `cleanFilenameLabel` of
// `lib/launchers/shared/game-id.js`.
function duckstationGameLabel(rawName) {
    return cleanFilenameLabel(rawName);
}

// Stable id of a disc image: the serial if it can be extracted, otherwise a `p:`-prefixed substitute derived from the file path.
function duckstationGameId(serial, filePath) {
    return serial || pathHashId(filePath);
}

// The launch argument list (flatpak-shaped: `run <appid> …` — for native, `variantExecSpec` strips the prefix).
// `-fullscreen` and `--` are DuckStation's own CLI; `discPath` is a `.cue` or a standalone `.chd`/`.pbp`/`.iso`/`.img`.
// ⚠️ `-batch` IS REQUIRED: without it the process does not exit after the game closes (DuckStation switches to its own main
// menu), and the launcher never gets control back. (Unlike RPCS3's `--no-gui`, which suppressed Big Picture Mode.)
// No `meta` — "recently played" comes from `playtime.dat`. Background: docs/dev/launchers/duckstation.md
function duckstationGameArgs(discPath) {
    return ['run', DUCKSTATION_FLATPAK_ID, '-fullscreen', '-batch', '--', discPath];
}

// `.cue` + the file-name-only standalone formats together — walked by the shared `walkFilesByExtension` of `lib/dir-browse.js`.
const ALL_DISC_EXTENSIONS = new Set([CUE_EXTENSION, ...SOLO_DISC_EXTENSIONS]);

// Per-file metadata cache (`lib/scan/scan-meta-cache.js`), the serial keyed by the disc image's `mtime+size`; persisted on
// the worker-scan path. Value: `{ serial }`.
const metaCache = createFileMetaCache('duckstation', 1);

function findInstalledGames(configRoot, homeDir = os.homedir()) {
    const dirs = readGameDirs(configRoot);
    const files = [];
    for (const dir of dirs) files.push(...walkFilesByExtension(dir, ALL_DISC_EXTENSIONS, { maxDepth: MAX_SCAN_DEPTH }));

    const yamlText = duckstationGameDbText(homeDir);
    const playtime = readPlaytime(configRoot);

    const games = [];
    const seenIds = new Set();
    metaCache.begin();
    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const scanTarget = ext === CUE_EXTENSION ? resolveCueDataFile(file) : file;
        let serial = null;
        if (scanTarget) {
            // The expensive ISO9660 traversal only runs for a changed disc image (see `metaCache`).
            const key = `${file}|${scanTarget}`;
            const stat = statSig(scanTarget);
            const hit = metaCache.lookup(key, stat);
            if (hit) {
                serial = hit.serial;
            } else {
                serial = extractSerialFromDisc(scanTarget);
                metaCache.store(key, stat, { serial });
            }
        }
        const officialName = serial ? lookupGameName(yamlText, serial) : null;
        const name = officialName || duckstationGameLabel(path.basename(file));

        const id = duckstationGameId(serial, file);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const pt = serial ? playtime.get(serial) : null;
        games.push({
            id,
            name,
            path: file,
            serial: serial || null,
            cover: serial ? resolveDuckstationCover(serial) : null,
            lastPlayedAt: pt ? pt.lastPlayedAt : null,
        });
    }
    metaCache.commit();
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

// "Recently played" — derived from DuckStation's OWN `playtime.dat` at READ time, from an ALREADY queried game list: main runs
// the scan in a worker thread (see lib/scan/scan-worker.js), the TTL cache lives in main too (`workerScans.duckstation`) — the
// module has no `findInstalledGamesCached` of its own. The `lastLaunchedAt` ISO conversion is done by the shared
// `buildRecentEntries` (`lib/recent/recent-games.js`).
function recentFromGames(games, max = 3) {
    return buildRecentEntries(games, {
        timeMs: (g) => g.lastPlayedAt,
        max,
        key: (g) => `duckstation-game-${g.id}`,
        kind: 'duckstation',
        params: (g) => ({ path: g.path, serial: g.serial }),
    });
}

// --- Cover: reuses the proven libretro thumbnail server already used in the repo (NOT a new, unvetted external source) — a
// standalone copy of the `LIBRETRO_THUMB_BASE`/`libretroThumbnailUrl`/`retroarchThumbnailLabel` pattern of
// `lib/launchers/retroarch-library.js`, under the "Sony - PlayStation" system (verified: exactly the user's RetroArch
// `playlists/Sony - PlayStation.lpl` file name). The title searched is the official `name` of `gamedb.yaml` — Redump/No-Intro
// convention, very likely matching the libretro thumbnail server's naming. ---

const DUCKSTATION_THUMB_SYSTEM = 'Sony - PlayStation';
const LIBRETRO_THUMB_BASE = 'https://thumbnails.libretro.com';

function duckstationThumbnailLabel(label) {
    return String(label == null ? '' : label).replace(/[&*/:`<>?|]/g, '_');
}

function duckstationThumbnailUrl(label) {
    const sys = encodeURIComponent(DUCKSTATION_THUMB_SYSTEM);
    const name = encodeURIComponent(`${duckstationThumbnailLabel(label)}.png`);
    return `${LIBRETRO_THUMB_BASE}/${sys}/Named_Boxarts/${name}`;
}

function duckstationCoverCacheDir() {
    return coverCacheDir('duckstation');
}

function duckstationCoverPath(serial) {
    return coverPath('duckstation', serial, 'png');
}

// Only returns a downloaded cover ALREADY on disk (self-healing, no network, never throws).
function resolveDuckstationCover(serial) {
    return resolveCachedCover('duckstation', serial, 'png');
}

// Downloads the missing covers of `entries` (recentGames/favoriteGames-shaped, carrying `name`) from the libretro thumbnail
// server into the launcher's own cache folder — ONLY for entries actually visible (quick-launch bar / favorite), never for the
// whole library. The loop is the shared `ensureCoversForEntries` of `lib/launchers/shared/cover-cache.js`.
/**
 * @param {Array<{ name?: string, cover?: string|null, params?: { serial?: string|null } }>} entries
 * @param {{ download?: (url: string, destPath: string) => Promise<boolean>, log?: import('../types.js').Logger }} [opts]
 */
async function ensureDuckstationCovers(entries, { download, log = () => {} } = {}) {
    return ensureCoversForEntries(entries, {
        hasKey: (e) => !!(e && e.params && e.params.serial && e.name),
        destPath: (e) => duckstationCoverPath(e.params.serial),
        buildUrl: (e) => duckstationThumbnailUrl(e.name),
        logKey: (e) => e.params.serial,
        logLabel: 'DuckStation',
        download,
        log,
    });
}

module.exports = {
    DUCKSTATION_FLATPAK_ID,
    duckstationConfigRoot,
    parseGameListDirs,
    readGameDirs,
    extractSerialFromDisc,
    resolveCueDataFile,
    lookupGameName,
    parsePlaytime,
    readPlaytime,
    duckstationGameLabel,
    duckstationGameId,
    duckstationGameArgs,
    findInstalledGames,
    recentFromGames,
    duckstationCoverCacheDir,
    duckstationCoverPath,
    resolveDuckstationCover,
    duckstationThumbnailUrl,
    ensureDuckstationCovers,
};
