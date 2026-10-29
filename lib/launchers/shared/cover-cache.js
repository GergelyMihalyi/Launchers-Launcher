// @ts-check
'use strict';

// The shared "cover cache folder/path/resolve/atomic write" quartet of the launcher modules (cemu/dolphin/duckstation/melonds/pcsx2/
// ppsspp/ryujinx-library.js), with the `~/.local/share/launchers-launcher/covers/<launcherId>/<id>.<ext>` pattern. Every module builds its
// own named `<x>CoverCacheDir`/`<x>CoverPath`/`resolve<X>Cover` (public API + tests unchanged) on this shared core.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../../fs-atomic.js');
const { dataHome } = require('../../xdg.js');

function coverCacheDir(launcherId) {
    return path.join(dataHome(), 'launchers-launcher', 'covers', launcherId);
}

// For some callers (dolphin/duckstation/melonds) `id` comes from a RAW disc-image/ROM header field (Game ID / serial / gamecode) — a
// crafted (broken/manipulated) disc image could in theory put any byte sequence here (e.g. `../../something`), which without a charset
// check could write a file OUTSIDE the cache folder. Every real ID (hex title id, PCSX2 "SCUS-97472" serial etc.) consists purely of
// `[A-Za-z0-9_-]` — everything else is replaced with `_`, which never lets a path separator/`..` through, so the result is guaranteed to
// stay UNDER `coverCacheDir(launcherId)`.
function sanitizeCoverId(id) {
    return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function coverPath(launcherId, id, ext) {
    return path.join(coverCacheDir(launcherId), `${sanitizeCoverId(id)}.${ext}`);
}

// Only returns a cache file ALREADY on disk (self-healing) — never throws, never goes to the network.
function resolveCachedCover(launcherId, id, ext) {
    if (!id) return null;
    try {
        const p = coverPath(launcherId, id, ext);
        return fs.existsSync(p) ? p : null;
    } catch (err) {
        return null;
    }
}

// Atomic (mkdir + temp file + rename) write into the launcher's own cache folder — for LOCALLY decoded (not downloaded) covers (Cemu
// TGA->PNG, melonDS NDS icon, PPSSPP embedded ICON0.PNG). Never throws.
function writeCoverAtomic(destPath, buffer) {
    try {
        writeFileAtomic(destPath, buffer);
        return destPath;
    } catch (err) {
        return null;
    }
}

// Shared network cover download core (ryujinx/pcsx2/dolphin/duckstation `ensure*Covers` + retroarch `ensureRecentThumbnails`): if there
// is no `entry.cover` and the key is present → self-healing disk check → otherwise `download(url, dest)`. ONLY for visible (quick-launch
// bar / favorite) entries. `download` is injected (the caller passes `downloadFile` of `lib/net.js`). Best effort — does not throw, sets
// `entry.cover` IN PLACE; returns the number of downloads. Callers keep their own `ensureXCovers` exports.
/**
 * @param {Array<{ cover?: string|null }>} entries
 * @param {{
 *   hasKey: (entry: object) => boolean,
 *   destPath: (entry: object) => string,
 *   buildUrl: (entry: object) => string,
 *   logKey: (entry: object) => string,
 *   logLabel: string,
 *   download?: (url: string, destPath: string) => Promise<boolean>,
 *   log?: import('../../types.js').Logger,
 * }} opts
 */
async function ensureCoversForEntries(entries, {
    hasKey, destPath, buildUrl, logKey, logLabel, download, log = () => {},
}) {
    if (typeof download !== 'function' || !Array.isArray(entries)) return 0;
    let downloaded = 0;
    for (const entry of entries) {
        if (!entry || entry.cover || !hasKey(entry)) continue;
        const dest = destPath(entry);
        try {
            if (fs.existsSync(dest)) {
                entry.cover = dest;
                continue;
            }
        } catch (err) { /* continue with the download */ }
        try {
            const ok = await download(buildUrl(entry), dest);
            if (ok) {
                entry.cover = dest;
                downloaded += 1;
            }
        } catch (err) {
            log(`${logLabel} cover download error (${logKey(entry)}): ${err.message}`);
        }
    }
    return downloaded;
}

module.exports = {
    coverCacheDir, coverPath, resolveCachedCover, writeCoverAtomic, sanitizeCoverId,
    ensureCoversForEntries,
};
