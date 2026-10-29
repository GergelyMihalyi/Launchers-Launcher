// @ts-check
'use strict';

// Cemu (Wii U emulator) installed-game discovery.
// Cemu's own `title_list_cache.xml` is stale (a directly launched title is not in it), so the module scans two sources
// itself: the `<GamePaths>` folders of `settings.xml` (`meta/meta.xml` marker) + Cemu's virtual NAND
// (`mlc01/usr/title/00050000/*`; the `0005000C`/`0005000E` DLC/update groups are skipped).
// Title + title ID from `meta/meta.xml`; the cover is a LOCAL TGA→PNG conversion of `meta/iconTex.tga` (no network, for every
// scanned entry). "Recently played": booked at launch time (no timestamped own bookkeeping). Details: docs/dev/launchers/cemu.md

const fs = require('fs');
const path = require('path');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');
const { coverCacheDir, coverPath, resolveCachedCover, writeCoverAtomic } = require('./shared/cover-cache.js');
const { appConfigRoot, appDataRoot } = require('../xdg.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { filterExistingDirs, isJunkEntry, entryKind } = require('../dir-browse.js');
const { encodePng } = require('./shared/png-encode.js');

const CEMU_FLATPAK_ID = 'info.cemu.Cemu';

function cemuConfigRoot() {
    return appConfigRoot(CEMU_FLATPAK_ID, 'Cemu'); // native: ~/.config/Cemu
}

function cemuDataRoot() {
    return appDataRoot(CEMU_FLATPAK_ID, 'Cemu'); // native: ~/.local/share/Cemu
}

// Do not descend needlessly into a deep/broken folder structure.
const MAX_SCAN_DEPTH = 3;

// --- `settings.xml` parse (GamePaths + mlc_path) ---

// The entries of the `<GamePaths><Entry>...</Entry>...</GamePaths>` block — a pure regex parser (the file has no nested
// `<GamePaths>`, a simple "block + inner Entries" read is enough).
function parseGamePaths(xmlText) {
    const block = /<GamePaths>([\s\S]*?)<\/GamePaths>/.exec(String(xmlText == null ? '' : xmlText));
    if (!block) return [];
    const dirs = [];
    const re = /<Entry>([^<]*)<\/Entry>/g;
    let m;
    while ((m = re.exec(block[1]))) {
        if (m[1]) dirs.push(m[1]);
    }
    return dirs;
}

// The `<mlc_path>` override (if the user changed it) — empty/missing means Cemu uses `mlc01` inside its own data root.
function parseMlcPathOverride(xmlText) {
    const m = /<mlc_path>([^<]*)<\/mlc_path>/.exec(String(xmlText == null ? '' : xmlText));
    return m && m[1].trim() ? m[1].trim() : null;
}

function readSettingsXml(configRoot) {
    try {
        return fs.readFileSync(path.join(configRoot, 'settings.xml'), 'utf8');
    } catch (err) {
        return null;
    }
}

// The `GamePaths` folders — only those that actually exist (the user may have deleted/unmounted the drive since Cemu wrote it).
// Missing/broken `settings.xml` -> empty list.
function readGameDirs(configRoot) {
    const text = readSettingsXml(configRoot);
    if (text == null) return [];
    return filterExistingDirs(parseGamePaths(text));
}

function mlcRoot(configRoot, dataRoot) {
    const text = readSettingsXml(configRoot);
    const override = text == null ? null : parseMlcPathOverride(text);
    return override || path.join(dataRoot, 'mlc01');
}

// Folders of the BASE games installed in Cemu's own virtual NAND (`mlc01/usr/title/00050000/<group>`) — ONLY the `00050000`
// (base game) type.
function findMlcBaseGameDirs(mlc) {
    const baseTypeDir = path.join(mlc, 'usr', 'title', '00050000');
    let groups;
    try {
        groups = fs.readdirSync(baseTypeDir, { withFileTypes: true });
    } catch (err) {
        return [];
    }
    const dirs = [];
    for (const g of groups) {
        if (!g.isDirectory()) continue;
        const full = path.join(baseTypeDir, g.name);
        if (hasMetaXml(full)) dirs.push(full);
    }
    return dirs;
}

function hasMetaXml(dir) {
    try {
        return fs.statSync(path.join(dir, 'meta', 'meta.xml')).isFile();
    } catch (err) {
        return false;
    }
}

// Looks for `meta/meta.xml` in the `GamePaths` folders (one hit = one game folder, we do NOT descend further — the
// `content`/`code` subfolders are irrelevant). Marker-based instead of extension-based.
function walkGameDirs(dir, depth, out) {
    if (hasMetaXml(dir)) {
        out.push(dir);
        return; // do not descend into the subfolders of an already found game folder
    }
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return;
    }
    for (const e of entries) {
        // symlinked game folders too; trash / system folders are skipped
        if (isJunkEntry(e.name) || entryKind(dir, e) !== 'dir') continue;
        walkGameDirs(path.join(dir, e.name), depth + 1, out);
    }
}

// --- `meta.xml` parse ---

const TITLE_ID_RE = /<title_id[^>]*>\s*([0-9A-Fa-f]{16})\s*<\/title_id>/;
// English first, then the other localizations in the order seen in the file — the first NON-EMPTY match wins
// (`ja`/`ko`/`zhs`/`zht` are always empty on the user's machine).
const NAME_LOCALES = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'ru', 'ja', 'ko', 'zhs', 'zht'];

// `<longname_en>...</longname_en>` (often MULTI-LINE, e.g. "THE LEGEND OF ZELDA\nThe Wind Waker HD") -> joined into one line with
// spaces — more readable in a launcher row than the Wii U's two-line menu layout.
function cleanMetaName(raw) {
    return String(raw == null ? '' : raw)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ')
        .trim();
}

function extractLocalizedField(xmlText, tagPrefix) {
    for (const loc of NAME_LOCALES) {
        const re = new RegExp(`<${tagPrefix}_${loc}[^>]*>([\\s\\S]*?)<\\/${tagPrefix}_${loc}>`);
        const m = re.exec(xmlText);
        if (m) {
            const cleaned = cleanMetaName(m[1]);
            if (cleaned) return cleaned;
        }
    }
    return null;
}

// `{ titleId, name }` — both `null` if the file cannot be parsed / the field is missing (never throws).
function parseMetaXml(xmlText) {
    const text = String(xmlText == null ? '' : xmlText);
    const idMatch = TITLE_ID_RE.exec(text);
    const titleId = idMatch ? idMatch[1].toLowerCase() : null;
    const name = extractLocalizedField(text, 'longname') || extractLocalizedField(text, 'shortname');
    return { titleId, name };
}

// File-name cleanup fallback (if `meta.xml` somehow gives no title — unexpected, every valid Wii U game folder has a
// `longname`/`shortname`) — the shared `cleanFilenameLabel` of `lib/launchers/shared/game-id.js`, WITHOUT stripping an extension
// (called on folder names, which have none).
function cemuGameLabel(rawName) {
    return cleanFilenameLabel(rawName, { stripExtension: false });
}

// Stable id: the title ID (always extractable for scanned entries), otherwise a `p:`-prefixed substitute derived from the folder
// path (for the launch-ipc payload guard, if a saved favorite/quick-launch entry somehow lacks `titleId`).
function cemuGameId(titleId, gamePath) {
    return titleId || pathHashId(gamePath);
}

// The launch argument list (flatpak-shaped: `run <appid> …` — for native, `variantExecSpec` strips the prefix).
// `-g <path>` is the game folder (or a title folder inside mlc01), `-f` fullscreen.
function cemuGameArgs(gamePath) {
    return ['run', CEMU_FLATPAK_ID, '-f', '-g', gamePath];
}

// The installed (browsable) Wii U games — by walking the `GamePaths` folders + Cemu's own `mlc01/usr/title/00050000`. Deduped on
// `titleId` (the `GamePaths` source wins if the same title is in both places). Missing `settings.xml`/folders -> empty list.
// `dataRoot` is always `cemuDataRoot()` on the real machine — only tests need to override it (temp `HOME` fixture), so it is
// defaulted here, not in the caller (the `findInstalledGamesCached(...)` signature thus matches the other emulator modules:
// `configRoot` is enough).
function findInstalledGames(configRoot, dataRoot = cemuDataRoot()) {
    const found = [];
    for (const dir of readGameDirs(configRoot)) walkGameDirs(dir, 0, found);
    for (const dir of findMlcBaseGameDirs(mlcRoot(configRoot, dataRoot))) found.push(dir);

    const games = [];
    const seenIds = new Set();
    for (const gameDir of found) {
        let metaText;
        try {
            metaText = fs.readFileSync(path.join(gameDir, 'meta', 'meta.xml'), 'utf8');
        } catch (err) {
            continue;
        }
        const { titleId, name } = parseMetaXml(metaText);
        const id = cemuGameId(titleId, gameDir);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        games.push({
            id,
            name: name || cemuGameLabel(path.basename(gameDir)),
            path: gameDir,
            titleId: titleId || null,
            cover: ensureCemuCover(gameDir, titleId),
        });
    }
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

// TTL-cached variant for the `list-cemu-games` IPC (the raw `findInstalledGames` stays pure for tests).
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

// --- Cover: local TGA -> PNG decoding ---

// Minimal TGA decoder, ONLY enough for the fixed shape of the Wii U icon texture: uncompressed truecolor (image type 2), 24 or 32
// bpp, no colormap. Other TGA variants (RLE-compressed, colormapped etc.) are DELIBERATELY unsupported — returns `null`, the caller
// lists the game without a cover, never throws.
function decodeTga(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 18) return null;
    const idLength = buf[0];
    const colorMapType = buf[1];
    const imageType = buf[2];
    const width = buf.readUInt16LE(12);
    const height = buf.readUInt16LE(14);
    const bpp = buf[16];
    const descriptor = buf[17];
    if (colorMapType !== 0 || imageType !== 2) return null;
    if (bpp !== 24 && bpp !== 32) return null;
    if (width < 1 || height < 1 || width > 1024 || height > 1024) return null; // sanity limit

    const bytesPerPixel = bpp / 8;
    const pixelDataStart = 18 + idLength;
    const rowBytes = width * bytesPerPixel;
    if (buf.length < pixelDataStart + rowBytes * height) return null;

    // Bit 5 of the image descriptor (0x20): 0 = bottom-up row order (the case for Wii U icons), 1 = top-down (PNG row order) —
    // the missing case is flipped here.
    const topDown = (descriptor & 0x20) !== 0;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const srcRow = topDown ? y : (height - 1 - y);
        const srcOff = pixelDataStart + srcRow * rowBytes;
        const dstOff = y * width * 4;
        for (let x = 0; x < width; x++) {
            const s = srcOff + x * bytesPerPixel;
            const d = dstOff + x * 4;
            // TGA truecolor storage order: B, G, R(, A).
            rgba[d] = buf[s + 2];
            rgba[d + 1] = buf[s + 1];
            rgba[d + 2] = buf[s];
            rgba[d + 3] = bytesPerPixel === 4 ? buf[s + 3] : 255;
        }
    }
    return { width, height, pixels: rgba };
}

// PNG encoding lives in `lib/launchers/shared/png-encode.js` (shared with `lib/launchers/melonds-library.js`), re-exported here.

function cemuCoverCacheDir() {
    return coverCacheDir('cemu');
}

function cemuCoverPath(titleId) {
    return coverPath('cemu', titleId, 'png');
}

// Only returns a converted cover ALREADY on disk (self-healing — never goes to the network, there is nothing to fetch).
function resolveCemuCover(titleId) {
    return resolveCachedCover('cemu', titleId, 'png');
}

// By `decodeTga()`'s OWN sanity limit (width/height <= 1024) a VALID uncompressed 32-bit TGA can never be bigger than this — the
// real Wii U icon texture is ~64 KB (128×128×4 bytes + an 18-byte header). An `iconTex.tga` bigger than this is CERTAINLY not a
// valid icon (broken/foreign file, e.g. in a network folder) — rejected WITHOUT reading the whole file synchronously (the melonDS
// lesson: "never read a whole file of unbounded size during a scan").
const MAX_ICON_TGA_BYTES = 18 + 1024 * 1024 * 4;

// Converts `gameDir/meta/iconTex.tga` (if present) to PNG in the launcher's own cache folder — LOCALLY, without network, so
// (unlike the network `ensure*Covers` of Ryujinx/PCSX2) it is synchronous and runs for EVERY scanned entry, not only for the visible
// quick-launch/favorite entries — decoding a 128×128 image is cheap. Self-healing (reuses a cache file already on disk), never throws.
function ensureCemuCover(gameDir, titleId) {
    if (!titleId) return null;
    const existing = resolveCemuCover(titleId);
    if (existing) return existing;
    const tgaPath = path.join(gameDir, 'meta', 'iconTex.tga');
    let tgaBuf;
    try {
        // Size check BEFORE reading the whole file — see MAX_ICON_TGA_BYTES above.
        if (fs.statSync(tgaPath).size > MAX_ICON_TGA_BYTES) return null;
        tgaBuf = fs.readFileSync(tgaPath);
    } catch (err) {
        return null;
    }
    const decoded = decodeTga(tgaBuf);
    if (!decoded) return null;
    let png;
    try {
        png = encodePng(decoded.width, decoded.height, decoded.pixels);
    } catch (err) {
        return null;
    }
    return writeCoverAtomic(cemuCoverPath(titleId), png);
}

module.exports = {
    CEMU_FLATPAK_ID,
    cemuConfigRoot,
    cemuDataRoot,
    parseGamePaths,
    readGameDirs,
    mlcRoot,
    findMlcBaseGameDirs,
    parseMetaXml,
    cemuGameLabel,
    cemuGameId,
    cemuGameArgs,
    findInstalledGames,
    findInstalledGamesCached,
    decodeTga,
    encodePng,
    cemuCoverCacheDir,
    cemuCoverPath,
    resolveCemuCover,
    ensureCemuCover,
    MAX_ICON_TGA_BYTES,
};
