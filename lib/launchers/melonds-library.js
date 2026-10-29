// @ts-check
'use strict';

// melonDS (Nintendo DS/DSi emulator) installed-ROM discovery.
// melonDS has no browsable game list, so the launcher scans a ROM folder itself and launches the specific ROM via CLI. The
// folder set is the union of two sources (the parent folders of `LastROMFolder` + `RecentROM` in `melonDS.toml`, and the manual
// `melondsRomDirs` key); title + icon come from the ROM header (no crypto), zipped ROMs are read by the shared
// `shared/zip-reader.js`. The cover is decoded locally; "recently played" is booked at launch time (`RecentROM` has no timestamp).
// ⚠️ NEVER read a whole file during a scan (on NFS it froze the main process for minutes): positioned reads, growing prefix.
// Header offsets, zip handling, flags, the freeze story: docs/dev/launchers/melonds.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');
const { coverCacheDir, coverPath, resolveCachedCover, writeCoverAtomic } = require('./shared/cover-cache.js');
const { appConfigRoot, translateFlatpakDocPath } = require('../xdg.js');
const dirBrowse = require('../dir-browse.js');
const { encodePng } = require('./shared/png-encode.js');
const zipReader = require('./shared/zip-reader.js');
const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
const { createFileMetaCache } = require('../scan/scan-meta-cache.js');

const MELONDS_FLATPAK_ID = 'net.kuribo64.melonDS';

function melondsConfigRoot() {
    return appConfigRoot(MELONDS_FLATPAK_ID, 'melonDS'); // native: ~/.config/melonDS
}

// The melonDS flatpak only runs with `filesystems=home`: a ROM folder OUTSIDE `$HOME` is visible to the scan (not sandboxed)
// but not to melonDS. So for such a new folder `flatpak override --user --filesystem=<dir>`, on removal `--nofilesystem=<dir>`
// (best effort, fire-and-forget; not needed for folders under $HOME). Background: docs/dev/launchers/melonds.md
/**
 * @param {string[]} prevDirs
 * @param {string[]} nextDirs
 * @param {{ log?: import('../types.js').Logger }} [opts]
 */
async function syncFlatpakOverrides(prevDirs, nextDirs, { log } = {}) {
    const logFn = log || (() => {});
    const home = os.homedir();
    const outsideHome = (d) => !dirBrowse.isInsideDir(d, home);
    const added = nextDirs.filter((d) => outsideHome(d) && !prevDirs.includes(d));
    const removed = prevDirs.filter((d) => outsideHome(d) && !nextDirs.includes(d));
    for (const dir of added) {
        try {
            await execFileAsync('flatpak', ['override', '--user', `--filesystem=${dir}`, MELONDS_FLATPAK_ID], { timeout: EXEC_TIMEOUT_MS });
            logFn(`melonDS flatpak sandbox access granted: ${dir}`);
        } catch (err) {
            logFn(`melonDS flatpak sandbox access error (${dir}): ${err.message}`);
        }
    }
    for (const dir of removed) {
        try {
            await execFileAsync('flatpak', ['override', '--user', `--nofilesystem=${dir}`, MELONDS_FLATPAK_ID], { timeout: EXEC_TIMEOUT_MS });
            logFn(`melonDS flatpak sandbox access revoked: ${dir}`);
        } catch (err) {
            logFn(`melonDS flatpak sandbox access revoke error (${dir}): ${err.message}`);
        }
    }
}

const MAX_SCAN_DEPTH = 3;
const ROM_EXTENSIONS = new Set(['.nds', '.dsi', '.srl']);
const ARCHIVE_EXTENSIONS = new Set(['.zip']);

// --- flatpak document-portal path translation — lives in `lib/xdg.js`, re-exported here. ---

// --- Minimal `melonDS.toml` reader — ONLY for the `LastROMFolder`/`RecentROM` keys, NOT a full TOML parser (for these keys
// the format is a single-line `key = "value"` / `key = ["...", ...]`). ---

function parseTomlString(text, key) {
    const re = new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm');
    const m = re.exec(String(text == null ? '' : text));
    return m ? m[1].replace(/\\(.)/g, '$1') : null;
}

function parseTomlStringArray(text, key) {
    const re = new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
    const m = re.exec(String(text == null ? '' : text));
    if (!m) return [];
    const out = [];
    const itemRe = /"((?:[^"\\]|\\.)*)"/g;
    let im;
    while ((im = itemRe.exec(m[1]))) out.push(im[1].replace(/\\(.)/g, '$1'));
    return out;
}

function readTomlText(configRoot) {
    try {
        return fs.readFileSync(path.join(configRoot, 'melonDS.toml'), 'utf8');
    } catch (err) {
        return null;
    }
}

// A `RecentROM` entry is `<path>` OR `<archive>|<inner file name>` (melonDS writes a ROM opened from a zip like this).
function parseRecentEntry(raw) {
    const idx = raw.indexOf('|');
    if (idx < 0) return { path: raw, archiveEntry: null };
    return { path: raw.slice(0, idx), archiveEntry: raw.slice(idx + 1) };
}

// Auto-derived: the parent folder of `LastROMFolder` + every `RecentROM`. Dedup + existence filter is the shared
// `filterExistingDirs` of `lib/dir-browse.js`.
function readAutoGameDirs(configRoot) {
    const text = readTomlText(configRoot);
    if (text == null) return [];
    const raw = [];
    const lastFolder = parseTomlString(text, 'LastROMFolder');
    if (lastFolder) raw.push(translateFlatpakDocPath(lastFolder));
    for (const rawEntry of parseTomlStringArray(text, 'RecentROM')) {
        raw.push(path.dirname(translateFlatpakDocPath(parseRecentEntry(rawEntry).path)));
    }
    return dirBrowse.filterExistingDirs(raw);
}

// Union of the auto-derived folders + the (manual) `melondsRomDirs` config key, deduped, existing folders only.
function readGameDirs(configRoot, manualDirs = []) {
    const raw = [
        ...readAutoGameDirs(configRoot),
        ...(Array.isArray(manualDirs) ? manualDirs : []),
    ];
    return dirBrowse.filterExistingDirs(raw);
}

// Walks the ROM folders — plain `.nds`/`.dsi`/`.srl` files + `.zip` archives (EVERY ROM found in one becomes a separate
// entry, see `expandZipRoms`) — the shared `walkFilesByExtension` of `lib/dir-browse.js`.
const SCANNABLE_EXTENSIONS = new Set([...ROM_EXTENSIONS, ...ARCHIVE_EXTENSIONS]);

// --- Zip-archive ROMs — through the shared, POSITIONALLY reading lib/launchers/shared/zip-reader.js (see the production bug
// there: reading the whole zip froze the main process for minutes on NFS) ---

const isRomEntry = (e) => ROM_EXTENSIONS.has(path.extname(e.name).toLowerCase());

// The entries with an actual ROM extension from an (in-memory) zip buffer.
function listZipRomEntries(buf) {
    const eocd = zipReader.findEndOfCentralDirectory(buf);
    if (!eocd) return [];
    return zipReader.parseCentralDirectory(buf, eocd).filter(isRomEntry);
}

// The same from a file, positionally (only the END of the file + the Central Directory).
function listZipRomEntriesFromFile(zipPath) {
    return zipReader.listZipEntriesFromFile(zipPath).filter(isRomEntry);
}

function readZipRomFiles(zipPath) {
    let stat;
    try {
        stat = fs.statSync(zipPath);
    } catch (err) {
        return [];
    }
    if (stat.size > zipReader.MAX_ZIP_READ_BYTES) return [];
    return listZipRomEntriesFromFile(zipPath).map((e) => ({ zipPath, entryName: e.name, cdEntry: e }));
}

// --- NDS/DSi ROM header (WITHOUT crypto, per the GBATEK spec) ---

const HEADER_SIZE = 0x70;
const ICON_BITMAP_OFFSET = 0x20;
const ICON_BITMAP_SIZE = 0x200;
const ICON_PALETTE_OFFSET = 0x220;
const ICON_PALETTE_SIZE = 0x20;
const TITLE_ENGLISH_OFFSET = 0x340;
const TITLE_FIELD_SIZE = 0x100;
const MAX_ICON_BLOCK_READ = 0x340 + TITLE_FIELD_SIZE; // enough for the icon + the English title

/** @typedef {{ title: (string|null), gamecode: (string|null), iconOffset: number }} NdsHeader */

/**
 * @param {Buffer} buf header buffer at least `HEADER_SIZE` long
 * @returns {NdsHeader|null}
 */
function parseNdsHeader(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) return null;
    const titleRaw = buf.toString('ascii', 0, 12);
    const nul = titleRaw.indexOf('\0');
    const title = (nul >= 0 ? titleRaw.slice(0, nul) : titleRaw).trim();
    const gamecodeRaw = buf.toString('ascii', 0x0c, 0x10);
    const gcNul = gamecodeRaw.indexOf('\0');
    const gamecode = (gcNul >= 0 ? gamecodeRaw.slice(0, gcNul) : gamecodeRaw).trim();
    const iconOffset = buf.readUInt32LE(0x68);
    if (!iconOffset || iconOffset >= 0x10000000) return null; // sanity — cannot be at the start of the file / unrealistically far
    return { title: title || null, gamecode: gamecode || null, iconOffset };
}

// The `<longname>`-like, often MULTI-LINE English title (e.g. "DRAGON BALL Z\nSUPER SONIC WARRIORS 2\nATARI") -> joined into
// one line with spaces (the publisher line is not needed, only the first non-empty line is the title).
function cleanNdsTitle(raw) {
    const lines = String(raw == null ? '' : raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines[0] : '';
}

function decodeUtf16leZ(buf) {
    let end = buf.length;
    for (let i = 0; i + 1 < buf.length; i += 2) {
        if (buf[i] === 0 && buf[i + 1] === 0) { end = i; break; }
    }
    return buf.toString('utf16le', 0, end);
}

// The 16-color BGR555 palette -> RGB (index 0 = transparent, GBATEK convention).
function decodeNdsPalette(paletteBuf) {
    const colors = [];
    for (let i = 0; i < 16; i++) {
        const c = paletteBuf.readUInt16LE(i * 2);
        colors.push([
            Math.round((c & 0x1f) * 255 / 31),
            Math.round(((c >> 5) & 0x1f) * 255 / 31),
            Math.round(((c >> 10) & 0x1f) * 255 / 31),
        ]);
    }
    return colors;
}

// The 32×32 icon bitmap of 4×4 tiles (8×8, 4bpp) -> RGBA32 (verified on a live ROM by hexdump and visually).
function decodeNdsIcon(bitmapBuf, paletteBuf) {
    if (!Buffer.isBuffer(bitmapBuf) || bitmapBuf.length < ICON_BITMAP_SIZE) return null;
    if (!Buffer.isBuffer(paletteBuf) || paletteBuf.length < ICON_PALETTE_SIZE) return null;
    const colors = decodeNdsPalette(paletteBuf);
    const size = 32;
    const rgba = Buffer.alloc(size * size * 4);
    let pos = 0;
    for (let ty = 0; ty < 4; ty++) {
        for (let tx = 0; tx < 4; tx++) {
            for (let py = 0; py < 8; py++) {
                for (let px = 0; px < 8; px += 2) {
                    const byte = bitmapBuf[pos++];
                    const pair = [[px, byte & 0x0f], [px + 1, (byte >> 4) & 0x0f]];
                    for (const [dx, idx] of pair) {
                        const x = tx * 8 + dx;
                        const y = ty * 8 + py;
                        const d = (y * size + x) * 4;
                        const [r, g, b] = colors[idx];
                        rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b;
                        rgba[d + 3] = idx === 0 ? 0 : 255;
                    }
                }
            }
        }
    }
    return { width: size, height: size, pixels: rgba };
}

/** @typedef {{ header: NdsHeader, icon: ({width:number,height:number,pixels:Buffer}|null), title: (string|null) }} NdsMeta */

/**
 * Extracts the header + icon + English title from an NDS/DSi ROM buffer already in memory
 * (the whole file for a plain file, the unpacked content for a zip archive).
 * @param {Buffer} buf
 * @returns {NdsMeta|null}
 */
function extractNdsMetaFromBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) return null;
    const header = parseNdsHeader(buf);
    if (!header) return null;
    const blockEnd = header.iconOffset + MAX_ICON_BLOCK_READ;
    if (blockEnd > buf.length) return { header, icon: null, title: null };
    const bitmap = buf.subarray(header.iconOffset + ICON_BITMAP_OFFSET, header.iconOffset + ICON_BITMAP_OFFSET + ICON_BITMAP_SIZE);
    const palette = buf.subarray(header.iconOffset + ICON_PALETTE_OFFSET, header.iconOffset + ICON_PALETTE_OFFSET + ICON_PALETTE_SIZE);
    const icon = decodeNdsIcon(bitmap, palette);
    const titleBuf = buf.subarray(header.iconOffset + TITLE_ENGLISH_OFFSET, header.iconOffset + TITLE_ENGLISH_OFFSET + TITLE_FIELD_SIZE);
    const title = cleanNdsTitle(decodeUtf16leZ(titleBuf)) || null;
    return { header, icon, title };
}

// Header+icon+title of a plain `.nds`/`.dsi`/`.srl` file (positioned read — the header block with the icon offset is only a
// few KB, the WHOLE ROM is not needed).
function extractNdsMetaFromFile(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (err) {
        return null;
    }
    try {
        const headerBuf = Buffer.alloc(HEADER_SIZE);
        if (fs.readSync(fd, headerBuf, 0, HEADER_SIZE, 0) !== HEADER_SIZE) return null;
        const header = parseNdsHeader(headerBuf);
        if (!header) return null;
        const blockLen = MAX_ICON_BLOCK_READ;
        const blockBuf = Buffer.alloc(blockLen);
        let n;
        try {
            n = fs.readSync(fd, blockBuf, 0, blockLen, header.iconOffset);
        } catch (err) {
            return { header, icon: null, title: null };
        }
        if (n !== blockLen) return { header, icon: null, title: null };
        const bitmap = blockBuf.subarray(ICON_BITMAP_OFFSET, ICON_BITMAP_OFFSET + ICON_BITMAP_SIZE);
        const palette = blockBuf.subarray(ICON_PALETTE_OFFSET, ICON_PALETTE_OFFSET + ICON_PALETTE_SIZE);
        const icon = decodeNdsIcon(bitmap, palette);
        const titleBuf = blockBuf.subarray(TITLE_ENGLISH_OFFSET, TITLE_ENGLISH_OFFSET + TITLE_FIELD_SIZE);
        const title = cleanNdsTitle(decodeUtf16leZ(titleBuf)) || null;
        return { header, icon, title };
    } catch (err) {
        return null;
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed/broken */ }
    }
}

// Header+icon+title of a ROM inside a zip archive — does NOT unpack the WHOLE entry: the shared `readZipEntryPrefixes` yields
// GROWING prefixes (the GBATEK header+icon block is in the first few, typically <64 KB of the ROM); once a prefix yields the full
// header+icon (`icon` too), it stops, otherwise tries a bigger one.
function extractNdsMetaFromZipEntry(zipPath, cdEntry) {
    let meta = null;
    zipReader.readZipEntryPrefixes(zipPath, cdEntry, (decoded) => {
        if (decoded.length < HEADER_SIZE) return false;
        const m = extractNdsMetaFromBuffer(decoded);
        if (m) meta = m;
        return !!(m && m.icon); // there was enough data, no point reading a bigger prefix
    });
    return meta;
}

// File-name cleanup fallback (when there is no header title) — the shared `cleanFilenameLabel` of `lib/launchers/shared/game-id.js`.
function melondsGameLabel(rawName) {
    return cleanFilenameLabel(rawName);
}

// Stable id: the gamecode if it can be extracted, otherwise a `p:`-prefixed substitute derived from the file path (+ inner zip name).
function melondsGameId(gamecode, filePath, archiveEntry) {
    return gamecode || pathHashId(filePath, archiveEntry);
}

// The launch argument list (flatpak-shaped: `run <appid> …` — for native, `variantExecSpec` strips the prefix). `--fullscreen` is
// melonDS's own flag; `-a <inner file name>` is only needed for a ROM opened from a zip archive (`archiveEntry` is `null` for a
// plain `.nds`/`.dsi`).
function melondsGameArgs(romPath, archiveEntry) {
    const args = ['run', MELONDS_FLATPAK_ID, '--fullscreen'];
    if (archiveEntry) args.push('-a', archiveEntry);
    args.push(romPath);
    return args;
}

// --- Cover: local icon decode -> PNG, no network ---

function melondsCoverCacheDir() {
    return coverCacheDir('melonds');
}

function melondsCoverPath(id) {
    return coverPath('melonds', id, 'png');
}

function resolveMelondsCover(id) {
    return resolveCachedCover('melonds', id, 'png');
}

// PNG encoding lives in `lib/launchers/shared/png-encode.js` (shared with `lib/launchers/cemu-library.js`), re-exported here.

// Writes the decoded icon into the launcher's own cache folder IF it is not there yet — synchronous, runs for EVERY scanned
// entry (no network overload risk that would justify deferring).
function ensureMelondsCover(id, icon) {
    if (!id || !icon) return null;
    const existing = resolveMelondsCover(id);
    if (existing) return existing;
    let png;
    try {
        png = encodePng(icon.width, icon.height, icon.pixels);
    } catch (err) {
        return null;
    }
    return writeCoverAtomic(melondsCoverPath(id), png);
}

// --- The full installed-ROM list ---

// Persistent metadata cache keyed by file signature (mtime+size) (`lib/scan/scan-meta-cache.js`): an unchanged zip/ROM only costs
// one `fs.statSync`; persisted on the worker-scan path. Value: `{ games: object[] }` (zip) or `{ game: object }` (plain ROM), key
// prefixed with `z:`/`f:`. Measurements and background: docs/dev/launchers/melonds.md
const metaCache = createFileMetaCache('melonds', 1);

function statSafe(p) {
    try {
        return fs.statSync(p);
    } catch (err) {
        return null;
    }
}

function buildPlainGame(filePath) {
    const meta = extractNdsMetaFromFile(filePath);
    const gamecode = meta ? meta.header.gamecode : null;
    const name = (meta && meta.title) || (meta && meta.header.title) || melondsGameLabel(path.basename(filePath));
    const id = melondsGameId(gamecode, filePath, null);
    const cover = (meta && meta.icon) ? ensureMelondsCover(id, meta.icon) : resolveMelondsCover(id);
    return { id, name, path: filePath, archiveEntry: null, gamecode: gamecode || null, cover };
}

// A zip archive gives one entry per ROM found in it, launched with melonDS's `-a`/`--archive-file` switch.
function buildZipGames(zipPath) {
    const out = [];
    for (const z of readZipRomFiles(zipPath)) {
        const meta = extractNdsMetaFromZipEntry(z.zipPath, z.cdEntry);
        const gamecode = meta ? meta.header.gamecode : null;
        const name = (meta && meta.title) || (meta && meta.header.title) || melondsGameLabel(z.entryName);
        const id = melondsGameId(gamecode, zipPath, z.entryName);
        const cover = (meta && meta.icon) ? ensureMelondsCover(id, meta.icon) : resolveMelondsCover(id);
        out.push({ id, name, path: zipPath, archiveEntry: z.entryName, gamecode: gamecode || null, cover });
    }
    return out;
}

// The entry list of one file (plain ROM OR zip archive) using the module-level cache — added to `nextCache` on a hit too (the
// reused old entry), so `findInstalledGames` can swap the cache for it at the end of the call.
function scanFile(filePath, isZip) {
    const stat = statSafe(filePath);
    if (!stat) return [];
    const key = `${isZip ? 'z' : 'f'}:${filePath}`;
    const hit = metaCache.lookup(key, stat);
    const hitGames = hit ? (isZip ? hit.games : [hit.game]) : null;
    // Self-healing: a hit pointing to a deleted cover file is no good — extract it again.
    if (Array.isArray(hitGames) && hitGames.every((g) => g && (!g.cover || fs.existsSync(g.cover)))) {
        return hitGames;
    }
    if (isZip) {
        const games = buildZipGames(filePath);
        metaCache.store(key, stat, { games });
        return games;
    }
    const game = buildPlainGame(filePath);
    metaCache.store(key, stat, { game });
    return [game];
}

function findInstalledGames(configRoot, manualDirs = []) {
    const files = [];
    for (const dir of readGameDirs(configRoot, manualDirs)) {
        files.push(...dirBrowse.walkFilesByExtension(dir, SCANNABLE_EXTENSIONS, { maxDepth: MAX_SCAN_DEPTH }));
    }

    metaCache.begin();
    const games = [];
    const seenIds = new Set();
    for (const file of files) {
        const isZip = ARCHIVE_EXTENSIONS.has(path.extname(file).toLowerCase());
        const list = scanFile(file, isZip);
        for (const g of list) {
            if (seenIds.has(g.id)) continue;
            seenIds.add(g.id);
            games.push(g);
        }
    }
    metaCache.commit();

    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

module.exports = {
    MELONDS_FLATPAK_ID,
    melondsConfigRoot,
    syncFlatpakOverrides,
    translateFlatpakDocPath,
    parseTomlString,
    parseTomlStringArray,
    parseRecentEntry,
    readGameDirs,
    listZipRomEntries,
    listZipRomEntriesFromFile,
    parseNdsHeader,
    decodeNdsIcon,
    extractNdsMetaFromBuffer,
    extractNdsMetaFromFile,
    extractNdsMetaFromZipEntry,
    melondsGameLabel,
    melondsGameId,
    melondsGameArgs,
    findInstalledGames,
    melondsCoverCacheDir,
    melondsCoverPath,
    resolveMelondsCover,
    encodePng,
    ensureMelondsCover,
};
