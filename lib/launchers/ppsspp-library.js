// @ts-check
'use strict';

// PPSSPP (PSP emulator) installed-game discovery.
// The flatpak requests `filesystems=host:ro`, so the non-sandboxed launcher can read any host path. ROM folder union: the
// `[PinnedPaths]` + the PARENT folders of the `[Recent]` entries (document-portal paths translated with `translateFlatpakDocPath`)
// + the homebrew folder `PSP/GAME/` of the emulated Memory Stick. Title/cover from the PS3/PSP/Vita `PARAM.SFO` + `ICON0.PNG`
// (`shared/param-sfo.js`), from three formats: `.pbp` (embedded), `.iso` (ISO9660 `PSP_GAME/`), `.cso` (compressed ISO, raw
// deflate blocks) — ISO and CSO behind a shared `reader(offset, length)` abstraction. Recent: from the `[PlayTime]` section, at
// read time. Format details: docs/dev/launchers/ppsspp.md

const fs = require('fs');
const path = require('path');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');
const { coverCacheDir, coverPath, resolveCachedCover, writeCoverAtomic } = require('./shared/cover-cache.js');
const {
    SECTOR_SIZE, MAX_DIR_SIZE, findDirEntry, readRootDirectory,
} = require('./shared/iso9660.js');
const zlib = require('zlib');
const { appConfigRoot, translateFlatpakDocPath } = require('../xdg.js');
const { buildRecentEntries } = require('../recent/recent-games.js');
const { walkFilesByExtension, filterExistingDirs } = require('../dir-browse.js');
const { createFileMetaCache, statSig } = require('../scan/scan-meta-cache.js');

const PPSSPP_FLATPAK_ID = 'org.ppsspp.PPSSPP';

function ppssppConfigRoot() {
    return appConfigRoot(PPSSPP_FLATPAK_ID, 'ppsspp'); // native: ~/.config/ppsspp
}

function ppssppIniPath(configRoot) {
    return path.join(configRoot, 'PSP', 'SYSTEM', 'ppsspp.ini');
}

function readIniText(configRoot) {
    try {
        return fs.readFileSync(ppssppIniPath(configRoot), 'utf8');
    } catch (err) {
        return null;
    }
}

// Returns the `Key = value` lines of a given `[Section]` with a simple regex (line-by-line processing — NOT one big capture
// regex, because of the lookahead gotcha with a multiline `$`).
function sectionLines(iniText, sectionName, lineRe) {
    const lines = String(iniText == null ? '' : iniText).split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l.trim() === `[${sectionName}]`);
    if (startIdx < 0) return [];
    const out = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\[.*\]$/.test(line.trim())) break; // next section -> done
        const m = lineRe.exec(line);
        if (m) out.push(m);
    }
    return out;
}

// `[PinnedPaths]` `Path0 = ...`, `Path1 = ...` — the ROM folders pinned by the user in PPSSPP.
function parsePinnedPaths(iniText) {
    return sectionLines(iniText, 'PinnedPaths', /^Path\d+\s*=\s*(.+?)\s*$/)
        .map((m) => m[1]);
}

// `[Recent]` `FileName0 = ...`, `FileName1 = ...` — PPSSPP's own "recently opened files" list. A gotcha verified in production:
// an item opened via the file chooser gets a `/run/flatpak/doc/<token>/...` document-portal path here (`translateFlatpakDocPath`
// makes it host-visible) — REGARDLESS, this is the best practical hint of WHERE the user's actual ROM collection is if no folder
// was ever pinned in PPSSPP (hence `readGameDirs` also includes the parent folders).
function parseRecentFiles(iniText) {
    return sectionLines(iniText, 'Recent', /^FileName\d+\s*=\s*(.+?)\s*$/)
        .map((m) => m[1]);
}

// The translation of a document-portal path seen INSIDE the flatpak sandbox lives in `lib/xdg.js`, re-exported here. Verified in
// production: the WHOLE content (dozens of ROMs) of the folder behind a `[Recent]` entry is readable via the translated path, even
// though the entry came from opening a single file (the GTK file chooser's portal integration grants the whole folder).

// `[PlayTime]` `<DISC_ID> = <seconds>,<last played, unix s>`.
function parsePlayTime(iniText) {
    const map = new Map();
    for (const m of sectionLines(iniText, 'PlayTime', /^([A-Za-z0-9]{4,16})\s*=\s*(\d+)\s*,\s*(\d+)\s*$/)) {
        const [, discId, secondsStr, tsStr] = m;
        const seconds = Number(secondsStr);
        const ts = Number(tsStr);
        if (!Number.isFinite(seconds) || !Number.isFinite(ts)) continue;
        map.set(discId, { seconds, lastPlayedAt: ts * 1000 });
    }
    return map;
}

// Two sources: the pinned folders (`[PinnedPaths]`) and the parent folders of the `[Recent]` files (in practice the best hint of
// where the ROM collection is). Both go through `translateFlatpakDocPath`; only existing folders remain.
function readGameDirs(configRoot) {
    const iniText = readIniText(configRoot);
    if (iniText == null) return [];
    const raw = [
        ...parsePinnedPaths(iniText).map((d) => translateFlatpakDocPath(d)),
        ...parseRecentFiles(iniText).map((f) => path.dirname(translateFlatpakDocPath(f))),
    ];
    return filterExistingDirs(raw);
}

function readPlaytime(configRoot) {
    const iniText = readIniText(configRoot);
    return iniText == null ? new Map() : parsePlayTime(iniText);
}

// --- PARAM.SFO — lives in `lib/launchers/shared/param-sfo.js` (shared with `lib/launchers/rpcs3-library.js`); only re-exported
// here (`test/launchers/ppsspp-library.test.js` imports it from this module) ---

const { parseParamSfo } = require('./shared/param-sfo.js');

// --- `.pbp` — PARAM.SFO/ICON0.PNG embedded directly ---

const PBP_MAGIC = Buffer.from([0x00, 0x50, 0x42, 0x50]); // "\0PBP"
const MAX_SFO_SIZE = 65536;
const MAX_ICON_SIZE = 1024 * 1024;

/** @typedef {{ sfo: Object<string, (string|number)>, icon: (Buffer|null) }} DiscMeta */

/**
 * @param {string} filePath
 * @returns {DiscMeta|null}
 */
function extractPbpMeta(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (err) {
        return null;
    }
    try {
        const header = Buffer.alloc(40);
        let n;
        try {
            n = fs.readSync(fd, header, 0, 40, 0);
        } catch (err) {
            return null;
        }
        if (n !== 40 || !header.subarray(0, 4).equals(PBP_MAGIC)) return null;
        const offsets = [];
        for (let i = 0; i < 8; i++) offsets.push(header.readUInt32LE(8 + i * 4));
        const sfoLen = offsets[1] - offsets[0];
        const iconLen = offsets[2] - offsets[1];
        /** @type {Object<string, (string|number)>} */
        let sfo = {};
        /** @type {Buffer|null} */
        let icon = null;
        if (sfoLen > 0 && sfoLen <= MAX_SFO_SIZE) {
            const sfoBuf = Buffer.alloc(sfoLen);
            if (fs.readSync(fd, sfoBuf, 0, sfoLen, offsets[0]) === sfoLen) sfo = parseParamSfo(sfoBuf);
        }
        if (iconLen > 0 && iconLen <= MAX_ICON_SIZE) {
            const iconBuf = Buffer.alloc(iconLen);
            if (fs.readSync(fd, iconBuf, 0, iconLen, offsets[1]) === iconLen) icon = iconBuf;
        }
        return { sfo, icon };
    } catch (err) {
        return null;
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed/broken */ }
    }
}

// --- `.iso` / `.cso` — ISO9660 traversal behind a shared byte-range reader; the PVD/root-directory core comes from
// `lib/launchers/shared/iso9660.js` (shared with PCSX2/DuckStation) ---

// PVD (sector 16) -> root-directory extent -> `PSP_GAME` subfolder -> `PARAM.SFO`/`ICON0.PNG` entry. `reader(offset, length)` is
// an abstract "read this byte range" function — plain `fs.readSync` for `.iso`, block decoding for `.cso` (see below). Broken/
// unknown structure → `null`, NEVER throws.
function findIsoSfoAndIcon(reader) {
    const rootDir = readRootDirectory(reader);
    if (!rootDir) return null;

    const pspGame = findDirEntry(rootDir, 'PSP_GAME');
    if (!pspGame || !pspGame.isDir || !pspGame.size || pspGame.size > MAX_DIR_SIZE) return null;

    const gameDir = reader(pspGame.lba * SECTOR_SIZE, pspGame.size);
    if (!gameDir) return null;

    const sfoEntry = findDirEntry(gameDir, 'PARAM.SFO');
    const iconEntry = findDirEntry(gameDir, 'ICON0.PNG');

    let sfo = null;
    let icon = null;
    if (sfoEntry && sfoEntry.size && sfoEntry.size <= MAX_SFO_SIZE) {
        sfo = reader(sfoEntry.lba * SECTOR_SIZE, sfoEntry.size);
    }
    if (iconEntry && iconEntry.size && iconEntry.size <= MAX_ICON_SIZE) {
        icon = reader(iconEntry.lba * SECTOR_SIZE, iconEntry.size);
    }
    return { sfo, icon };
}

function fileByteReader(fd) {
    return (offset, length) => {
        const buf = Buffer.alloc(length);
        let n;
        try {
            n = fs.readSync(fd, buf, 0, length, offset);
        } catch (err) {
            return null;
        }
        return n === length ? buf : null;
    };
}

// --- CSO (Compressed ISO) block decoding ---
//
// Header (24 bytes): magic "CISO", header_size u32, total_bytes u64, block_size u32, version u8, align u8, reserved[2]. Then a
// `(blocks+1) × u32` index table — bit 31 = "raw/uncompressed block" flag, the remaining 31 bits `<< align` give the byte offset
// in the file; a block's size comes from the NEXT index entry. The content is raw deflate (WITHOUT a zlib header —
// `zlib.inflateRawSync`).

const CISO_MAGIC = Buffer.from('CISO', 'ascii');
const CISO_HEADER_SIZE = 24;
const MAX_CSO_BLOCKS = 2_000_000; // sanity limit against a broken header

function readCsoHeader(fd) {
    const hbuf = Buffer.alloc(CISO_HEADER_SIZE);
    let n;
    try {
        n = fs.readSync(fd, hbuf, 0, CISO_HEADER_SIZE, 0);
    } catch (err) {
        return null;
    }
    if (n !== CISO_HEADER_SIZE || !hbuf.subarray(0, 4).equals(CISO_MAGIC)) return null;
    const headerSize = hbuf.readUInt32LE(4);
    const totalBytes = hbuf.readBigUInt64LE(8);
    const blockSize = hbuf.readUInt32LE(16);
    const align = hbuf.readUInt8(21);
    if (!blockSize || blockSize > 1024 * 1024) return null;
    let numBlocks;
    try {
        const bs = BigInt(blockSize);
        numBlocks = Number(totalBytes / bs) + (totalBytes % bs ? 1 : 0);
    } catch (err) {
        return null;
    }
    if (!(numBlocks > 0) || numBlocks > MAX_CSO_BLOCKS) return null;
    const indexBytes = Buffer.alloc((numBlocks + 1) * 4);
    try {
        n = fs.readSync(fd, indexBytes, 0, indexBytes.length, headerSize || CISO_HEADER_SIZE);
    } catch (err) {
        return null;
    }
    if (n !== indexBytes.length) return null;
    const index = new Uint32Array(numBlocks + 1);
    for (let i = 0; i <= numBlocks; i++) index[i] = indexBytes.readUInt32LE(i * 4);
    return { blockSize, align, index, numBlocks };
}

function readCsoBlock(fd, header, blockIndex) {
    const { align, index, numBlocks, blockSize } = header;
    if (blockIndex < 0 || blockIndex >= numBlocks) return null;
    const entry = index[blockIndex];
    const next = index[blockIndex + 1];
    const plain = !!(entry & 0x80000000);
    const shift = 2 ** align;
    const rawOffset = (entry & 0x7fffffff) * shift;
    const nextOffset = (next & 0x7fffffff) * shift;
    const compLen = nextOffset - rawOffset;
    if (!(compLen > 0) || compLen > blockSize * 2 + 4096) return null; // sanity limit
    const raw = Buffer.alloc(compLen);
    let n;
    try {
        n = fs.readSync(fd, raw, 0, compLen, rawOffset);
    } catch (err) {
        return null;
    }
    if (n !== compLen) return null;
    if (plain) return raw;
    try {
        return zlib.inflateRawSync(raw);
    } catch (err) {
        return null;
    }
}

// A reader with the same API as the `fileByteReader` used for `.iso` — with a block-index cache (within one `findIsoSfoAndIcon()`
// call the PVD/root-dir/PSP_GAME-dir reads may overlap block boundaries; do not decode the same block twice).
function csoByteReader(fd, header) {
    const cache = new Map();
    return (offset, length) => {
        const out = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
            const absOffset = offset + filled;
            const blockIndex = Math.floor(absOffset / header.blockSize);
            const blockOffset = absOffset % header.blockSize;
            let block = cache.get(blockIndex);
            if (block === undefined) {
                block = readCsoBlock(fd, header, blockIndex);
                cache.set(blockIndex, block);
            }
            if (!block) return null;
            const take = Math.min(block.length - blockOffset, length - filled);
            if (take <= 0) return null;
            block.copy(out, filled, blockOffset, blockOffset + take);
            filled += take;
        }
        return out;
    };
}

/**
 * @param {string} filePath
 * @param {string} ext
 * @returns {DiscMeta|null}
 */
function extractIsoMeta(filePath, ext) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (err) {
        return null;
    }
    try {
        let reader;
        if (ext === '.cso') {
            const header = readCsoHeader(fd);
            if (!header) return null;
            reader = csoByteReader(fd, header);
        } else {
            reader = fileByteReader(fd);
        }
        const found = findIsoSfoAndIcon(reader);
        if (!found) return null;
        return { sfo: found.sfo ? parseParamSfo(found.sfo) : {}, icon: found.icon || null };
    } catch (err) {
        return null;
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed/broken */ }
    }
}

/**
 * Dispatch by file format. Unknown extension → `null`.
 * @param {string} filePath
 * @returns {DiscMeta|null}
 */
function extractDiscMeta(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pbp') return extractPbpMeta(filePath);
    if (ext === '.iso' || ext === '.cso') return extractIsoMeta(filePath, ext);
    return null;
}

// --- Walking the game folders (pinned folders + the built-in PSP/GAME) ---

const ROM_EXTENSIONS = new Set(['.iso', '.cso', '.pbp']);
const MAX_SCAN_DEPTH = 3;

// File-name cleanup fallback (no `TITLE` in PARAM.SFO) — the shared `cleanFilenameLabel` of `lib/launchers/shared/game-id.js`.
function ppssppGameLabel(rawName) {
    return cleanFilenameLabel(rawName);
}

// Stable id: the `DISC_ID` if it can be extracted, otherwise a `p:`-prefixed substitute derived from the file path (`.pbp`, which
// has no UMD disc serial, always takes this branch).
function ppssppGameId(discId, filePath) {
    return discId || pathHashId(filePath);
}

// The launch argument list (flatpak-shaped: `run <appid> …` — for native, `variantExecSpec` strips the prefix). `--fullscreen` +
// the absolute path of the disc image/package (.iso/.cso/.pbp) as a positional argument; no `meta` ("recently played" comes from
// the `[PlayTime]` section).
function ppssppGameArgs(discPath) {
    return ['run', PPSSPP_FLATPAK_ID, '--fullscreen', discPath];
}

// --- Cover: local extraction, no network ---

function ppssppCoverCacheDir() {
    return coverCacheDir('ppsspp');
}

function ppssppCoverPath(id) {
    return coverPath('ppsspp', id, 'png');
}

// Only returns an extracted cover ALREADY on disk (self-healing — never goes to the network, there is nothing to fetch).
function resolvePpssppCover(id) {
    return resolveCachedCover('ppsspp', id, 'png');
}

// Writes `iconBuf` (the ICON0.PNG bytes extracted together with `PARAM.SFO`) into the launcher's own cache folder IF it is not
// there yet — synchronous, runs for EVERY scanned entry (unlike the network `ensure*Covers` of PCSX2/Ryujinx).
function ensurePpssppCover(id, iconBuf) {
    if (!id) return null;
    const existing = resolvePpssppCover(id);
    if (existing) return existing;
    if (!iconBuf || !iconBuf.length) return null;
    return writeCoverAtomic(ppssppCoverPath(id), iconBuf);
}

// --- The full installed-game list ---

// Per-file metadata cache (`lib/scan/scan-meta-cache.js`): an unchanged ROM only costs a `stat` — cold, decoding 52 `.cso`/`.iso`
// took 4 s. Persisted on the worker-scan path. Value: `{ discId, title, hadIcon }`.
const metaCache = createFileMetaCache('ppsspp', 1);

function findInstalledGames(configRoot) {
    const files = [];
    for (const dir of readGameDirs(configRoot)) files.push(...walkFilesByExtension(dir, ROM_EXTENSIONS, { maxDepth: MAX_SCAN_DEPTH }));
    files.push(...walkFilesByExtension(path.join(configRoot, 'PSP', 'GAME'), ROM_EXTENSIONS, { maxDepth: MAX_SCAN_DEPTH }));

    const playtime = readPlaytime(configRoot);
    const games = [];
    const seenPaths = new Set();
    const seenIds = new Set();
    metaCache.begin();
    for (const file of files) {
        if (seenPaths.has(file)) continue;
        seenPaths.add(file);

        // The expensive part (`.cso` decoding / ISO9660 / PBP header) only runs for a changed file — see `metaCache` above. For a deleted
        // cover file a hit is not enough (the icon bytes are not in the cache), extract again.
        const stat = statSig(file);
        /** @type {{ discId: string|null, title: string|null, hadIcon: boolean } | undefined} */
        let info = metaCache.lookup(file, stat);
        if (info && info.hadIcon && !resolvePpssppCover(ppssppGameId(info.discId, file))) info = undefined;
        let icon = null;
        if (!info) {
            const meta = extractDiscMeta(file);
            const sfo = (meta && meta.sfo) || {};
            info = {
                discId: (typeof sfo.DISC_ID === 'string' && sfo.DISC_ID.trim()) ? sfo.DISC_ID.trim() : null,
                title: (typeof sfo.TITLE === 'string' && sfo.TITLE.trim()) ? sfo.TITLE.trim() : null,
                hadIcon: !!(meta && meta.icon),
            };
            icon = meta && meta.icon;
            metaCache.store(file, stat, info);
        }
        const { discId, title } = info;
        const name = title || ppssppGameLabel(path.basename(file));

        const id = ppssppGameId(discId, file);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const cover = icon ? ensurePpssppCover(id, icon) : resolvePpssppCover(id);
        const pt = discId ? playtime.get(discId) : null;
        games.push({
            id,
            name,
            path: file,
            discId: discId || null,
            cover,
            lastPlayedAt: pt ? pt.lastPlayedAt : null,
        });
    }
    metaCache.commit();
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

// "Recently played" — derived from the `[PlayTime]` section at READ time, from an ALREADY queried game list: main runs the scan in
// a worker thread (see lib/scan/scan-worker.js), the TTL cache lives in main too (`workerScans.ppsspp`) — the module has no
// `findInstalledGamesCached` of its own. The cover is ready (extracted locally in `findInstalledGames()`), no download branch. The
// `lastLaunchedAt` ISO conversion is done by the shared `buildRecentEntries`.
function recentFromGames(games, max = 3) {
    return buildRecentEntries(games, {
        timeMs: (g) => g.lastPlayedAt,
        max,
        key: (g) => `ppsspp-game-${g.id}`,
        kind: 'ppsspp',
        params: (g) => ({ path: g.path, discId: g.discId }),
    });
}

module.exports = {
    PPSSPP_FLATPAK_ID,
    ppssppConfigRoot,
    parsePinnedPaths,
    parseRecentFiles,
    translateFlatpakDocPath,
    parsePlayTime,
    readPlaytime,
    readGameDirs,
    parseParamSfo,
    extractPbpMeta,
    findDirEntry,
    findIsoSfoAndIcon,
    readCsoHeader,
    extractDiscMeta,
    ppssppGameLabel,
    ppssppGameId,
    ppssppGameArgs,
    findInstalledGames,
    recentFromGames,
    ppssppCoverCacheDir,
    ppssppCoverPath,
    resolvePpssppCover,
    ensurePpssppCover,
};
