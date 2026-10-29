// @ts-check
'use strict';

// Shared "path hash" substitute id for the launcher modules' GameId() helpers — the `p:${sha1(...).slice(0,16)}` formula used when the
// real (title/serial/title id) id cannot be extracted. A module's own `<x>GameId(real, filePath, extra?)` builds on it.

const crypto = require('crypto');

// pathHashId(filePath) is byte-identical to the hash of the old single-argument calls (join inserts no separator for one element);
// extra (e.g. an inner zip file name) is optional.
function pathHashId(filePath, extra) {
    const key = extra ? `${filePath}|${extra}` : filePath;
    return `p:${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

// File-name cleanup fallback (the "no real metadata" case) — the natural pair of `pathHashId`: strips the extension (optional — Cemu
// calls it on folder names, which have none), `_`/`.` -> space, collapses double spaces, trims; an empty result falls back to the raw,
// trimmed name. Ryujinx's `ryujinxGameLabel` DELIBERATELY does not build on it — it has real extra logic (bracket/version-tag/scene-suffix
// stripping).
function cleanFilenameLabel(rawName, { stripExtension = true } = {}) {
    const raw = String(rawName == null ? '' : rawName);
    const base = stripExtension ? raw.replace(/\.[^./\\]+$/, '') : raw;
    const cleaned = base.replace(/[_.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return cleaned || raw.trim();
}

module.exports = { pathHashId, cleanFilenameLabel };
