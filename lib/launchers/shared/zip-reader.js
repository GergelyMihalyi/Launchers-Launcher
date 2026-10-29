// @ts-check
'use strict';

// Minimal zip reader (no zip lib in the repo): End Of Central Directory searched backwards from the END of the file → Central Directory →
// the data after the local header, "stored" (0) OR "deflate" (8). ZIP64 is NOT supported (accepted limitation). Verified byte-identical
// on a real zipped ROM.
// ⚠️ From a FILE always read POSITIONALLY (`listZipEntriesFromFile` / `readZipEntryPrefixes`), never the whole file: reading the ~130 zips
// (~6 GB) of an NFS ROM folder in full froze the main process for minutes. Listing only reads the END of the file (EOCD + Central
// Directory), the content prefix decodes a GROWING compressed prefix (`zlib` `Z_SYNC_FLUSH` `finishFlush`, without throwing on truncated
// deflate input). Background: docs/dev/launchers/melonds.md

const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const MAX_EOCD_COMMENT = 65536;

// Processing a broken/oversized zip must not run away — sanity limit (real ROM archives are far smaller).
const MAX_ZIP_READ_BYTES = 768 * 1024 * 1024;
const ZIP_TAIL_READ_BYTES = 22 + MAX_EOCD_COMMENT; // EOCD record + max comment field
// Prefix sizes of `readZipEntryPrefixes`: the first 64 KB is enough for most header-based extraction.
const ZIP_PREFIX_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

// The EOCD record is at the END of the file, followed by a (max 64 KB) comment field — the signature must be searched backwards (no fixed
// offset).
/** @param {Buffer} buf @returns {{ cdEntries: number, cdOffset: number } | null} */
function findEndOfCentralDirectory(buf) {
    const minLen = 22;
    if (!Buffer.isBuffer(buf) || buf.length < minLen) return null;
    const searchStart = Math.max(0, buf.length - minLen - MAX_EOCD_COMMENT);
    for (let i = buf.length - minLen; i >= searchStart; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            return {
                cdEntries: buf.readUInt16LE(i + 10),
                cdOffset: buf.readUInt32LE(i + 16),
            };
        }
    }
    return null;
}

// Walks the Central Directory -> `{ name, method, compressedSize, uncompressedSize, localHeaderOffset }[]`. The optional `baseOffset`
// (default 0) lets `buf` be not the WHOLE file but only a slice read positionally from the Central Directory onwards.
/** @param {Buffer} buf @param {{ cdEntries: number, cdOffset: number }} eocd @param {number} [baseOffset] */
function parseCentralDirectory(buf, eocd, baseOffset = 0) {
    const out = [];
    let pos = eocd.cdOffset - baseOffset;
    for (let i = 0; i < eocd.cdEntries; i++) {
        if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CD_SIG) break;
        const method = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const localHeaderOffset = buf.readUInt32LE(pos + 42);
        const nameStart = pos + 46;
        if (nameStart + nameLen > buf.length) break;
        const name = buf.toString('utf8', nameStart, nameStart + nameLen);
        out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
        pos = nameStart + nameLen + extraLen + commentLen;
    }
    return out;
}

// Unpacks the content of a Central Directory entry from an (in-memory) zip buffer — the compressed data starts AFTER the local header
// (the local header's own file name/extra field length may differ from the central directory's, so it is read separately). Only "stored"
// (0) and "deflate" (8) — anything else `null`.
function extractZipEntry(buf, cdEntry) {
    const off = cdEntry.localHeaderOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== LFH_SIG) return null;
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const dataStart = off + 30 + nameLen + extraLen;
    const dataEnd = dataStart + cdEntry.compressedSize;
    if (dataEnd > buf.length) return null;
    const raw = buf.subarray(dataStart, dataEnd);
    if (cdEntry.method === 0) return Buffer.from(raw);
    if (cdEntry.method === 8) {
        try {
            return zlib.inflateRawSync(raw);
        } catch (err) {
            return null;
        }
    }
    return null;
}

/** @param {number} fd @param {number} start @param {number} length */
function readFileRange(fd, start, length) {
    if (length <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return n === length ? buf : buf.subarray(0, n);
}

// Lists the Central Directory from a FILE, with positioned reads (only reads the END of the file + the CD range). Nonexistent / non-zip /
// oversized CD → empty list, never throws.
/** @param {string} zipPath */
function listZipEntriesFromFile(zipPath) {
    let fd;
    try {
        fd = fs.openSync(zipPath, 'r');
    } catch (err) {
        return [];
    }
    try {
        const size = fs.fstatSync(fd).size;
        const tailLen = Math.min(size, ZIP_TAIL_READ_BYTES);
        const tailBuf = readFileRange(fd, size - tailLen, tailLen);
        const eocd = findEndOfCentralDirectory(tailBuf);
        if (!eocd) return [];
        const cdLen = size - eocd.cdOffset;
        if (cdLen <= 0 || cdLen > MAX_ZIP_READ_BYTES) return [];
        const cdBuf = readFileRange(fd, eocd.cdOffset, cdLen);
        return parseCentralDirectory(cdBuf, eocd, eocd.cdOffset);
    } catch (err) {
        return [];
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed/broken */ }
    }
}

// The START of a zip entry's content WITHOUT unpacking the whole entry: after the local header it positionally reads a GROWING compressed
// prefix (`ZIP_PREFIX_SIZES`), decodes it with `Z_SYNC_FLUSH` (does not throw on truncated input, returns what it can), and passes it to
// `onPrefix(decoded)` each round. If that returns `true` (the data was enough), it stops; otherwise it tries a bigger prefix, up to the
// entry's compressed size. Returns silently on error / unknown method.
/**
 * @param {string} zipPath
 * @param {{ method: number, compressedSize: number, localHeaderOffset: number }} cdEntry
 * @param {(decoded: Buffer) => boolean} onPrefix
 */
function readZipEntryPrefixes(zipPath, cdEntry, onPrefix) {
    if (cdEntry.method !== 0 && cdEntry.method !== 8) return;
    let fd;
    try {
        fd = fs.openSync(zipPath, 'r');
    } catch (err) {
        return;
    }
    try {
        const lfhBuf = readFileRange(fd, cdEntry.localHeaderOffset, 30);
        if (lfhBuf.length !== 30 || lfhBuf.readUInt32LE(0) !== LFH_SIG) return;
        const nameLen = lfhBuf.readUInt16LE(26);
        const extraLen = lfhBuf.readUInt16LE(28);
        const dataStart = cdEntry.localHeaderOffset + 30 + nameLen + extraLen;
        for (const size of ZIP_PREFIX_SIZES) {
            const readLen = Math.min(size, cdEntry.compressedSize);
            if (readLen <= 0) break;
            const compBuf = readFileRange(fd, dataStart, readLen);
            let decoded;
            if (cdEntry.method === 0) {
                decoded = compBuf;
            } else {
                try {
                    decoded = zlib.inflateRawSync(compBuf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
                } catch (err) {
                    decoded = null;
                }
            }
            if (decoded && onPrefix(decoded)) break;
            if (readLen >= cdEntry.compressedSize) break; // no more data in the entry
        }
    } catch (err) {
        // corrupt archive — the caller continues on its own "no data" path
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* already closed/broken */ }
    }
}

module.exports = {
    findEndOfCentralDirectory, parseCentralDirectory, extractZipEntry, listZipEntriesFromFile,
    readZipEntryPrefixes, MAX_ZIP_READ_BYTES, ZIP_PREFIX_SIZES,
};
