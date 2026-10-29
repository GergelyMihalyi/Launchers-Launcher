// @ts-check
'use strict';

// Shared, minimal ISO9660 (Primary Volume Descriptor + directory record) parser primitives, WITHOUT crypto (shared core of
// pcsx2/ppsspp/duckstation: PVD @ sector 16, root-directory record @156, LBA/size from bytes 2/10 of the record, entry `recLen`/`nameLen`/
// name @0/32/33). The module does NOT read files: the caller supplies `reader(offsetBytes, length) => Buffer|null` (always with a
// SECTOR_SIZE-aligned offset), so the same logic works for plain 2048, `.cso` and raw 2352 CD-sector sources; `SECTOR_SIZE` is the
// LOGICAL (2048) sector size.

const SECTOR_SIZE = 2048;
const MAX_DIR_SIZE = 1024 * 1024; // sanity limit against a broken/fake directory size

function normalizeIsoName(raw) {
    return String(raw).replace(/;\d+$/, '').toUpperCase();
}

// Finds the entry matching a name (without the ";N" version suffix, case-insensitive) in a directory-extent buffer
// -> { lba, size, isDir } or null if there is no match.
function findDirEntry(dirBuf, name) {
    const target = normalizeIsoName(name);
    let pos = 0;
    while (pos < dirBuf.length) {
        const recLen = dirBuf[pos];
        if (recLen === 0) { pos += 1; continue; }
        if (pos + 34 > dirBuf.length) break;
        const nameLen = dirBuf[pos + 32];
        if (pos + 33 + nameLen > dirBuf.length) break;
        const entryName = dirBuf.toString('ascii', pos + 33, pos + 33 + nameLen);
        if (normalizeIsoName(entryName) === target) {
            return {
                lba: dirBuf.readUInt32LE(pos + 2),
                size: dirBuf.readUInt32LE(pos + 10),
                isDir: !!(dirBuf[pos + 25] & 0x02),
            };
        }
        pos += recLen;
    }
    return null;
}

// PVD (sector 16) -> the content of the root-directory extent. `reader(offsetBytes, length)` is the abstract byte-range reader. Broken/
// unknown structure (wrong magic, missing/oversized root extent) → `null` — left to the caller, NEVER throws (the `reader` itself should
// not throw either).
function readRootDirectory(reader) {
    const pvd = reader(16 * SECTOR_SIZE, SECTOR_SIZE);
    if (!pvd || pvd.toString('ascii', 1, 6) !== 'CD001') return null;

    const rootRecord = pvd.subarray(156, 156 + 34);
    const rootLba = rootRecord.readUInt32LE(2);
    const rootSize = rootRecord.readUInt32LE(10);
    if (!rootLba || !rootSize || rootSize > MAX_DIR_SIZE) return null;

    return reader(rootLba * SECTOR_SIZE, rootSize);
}

module.exports = {
    SECTOR_SIZE, MAX_DIR_SIZE, normalizeIsoName, findDirEntry, readRootDirectory,
};
