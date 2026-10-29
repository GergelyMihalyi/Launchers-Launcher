'use strict';

// Shared, synthetic binary fixture builders for the launcher tests (NOT a test file) — the same
// formats as the shared parsers in `lib/launchers/shared/`.

const zlib = require('zlib');

const ISO_SECTOR = 2048;
const RAW_SECTOR = 2352;
const RAW_DATA_OFFSET = 24; // Mode2/Form1 user-data offset inside a raw CD sector

/**
 * An ISO9660 directory record: recLen(1) … lba@2 (u32LE) … size@10 (u32LE) … flags@25 …
 * nameLen@32 (1) + name@33 (+1 padding byte for an even name length, per the standard).
 */
function isoDirRecord({ name, lba, size, isDir = false }) {
    const nameBuf = Buffer.from(name, 'ascii');
    const recLen = 33 + nameBuf.length + (nameBuf.length % 2 === 0 ? 1 : 0);
    const rec = Buffer.alloc(recLen);
    rec[0] = recLen;
    rec.writeUInt32LE(lba, 2);
    rec.writeUInt32LE(size, 10);
    rec[25] = isDir ? 0x02 : 0x00;
    rec[32] = nameBuf.length;
    nameBuf.copy(rec, 33);
    return rec;
}

/**
 * Minimal, synthetic ISO9660 image from a tree description: `{ NAME: Buffer|string (file) | {…} (folder) }`.
 * Sector 16 is the PVD (`CD001` magic unless `noMagic`), the root directory from sector 17, the other
 * folders/files in order after it, each in its own sector (a folder is max. 1 sector — plenty for tests).
 * File names get a `;1` version suffix, folders do not.
 * `rawSectors: true` → a RAW 2352 bytes/sector (Mode2/Form1) CD image, the user-data part of the
 * logical sector goes to offset `lba*2352+24` (the DuckStation `.bin` branch).
 */
function buildFakeIso(tree = {}, { noMagic = false, rawSectors = false } = {}) {
    const placed = new Map(); // lba -> Buffer
    let next = 17;

    function place(node) {
        if (Buffer.isBuffer(node) || typeof node === 'string') {
            const buf = Buffer.isBuffer(node) ? node : Buffer.from(node, 'ascii');
            const lba = next;
            next += Math.max(1, Math.ceil(buf.length / ISO_SECTOR));
            placed.set(lba, buf);
            return { lba, size: buf.length };
        }
        const lba = next;
        next += 1;
        const records = Object.entries(node).map(([name, child]) => {
            const isDir = !Buffer.isBuffer(child) && typeof child !== 'string';
            const { lba: childLba, size } = place(child);
            return isoDirRecord({ name: isDir ? name : `${name};1`, lba: childLba, size, isDir });
        });
        const dirBuf = Buffer.concat(records);
        placed.set(lba, dirBuf);
        return { lba, size: dirBuf.length };
    }

    const root = place(tree);
    const pvd = Buffer.alloc(ISO_SECTOR);
    if (!noMagic) {
        pvd[0] = 1;
        Buffer.from('CD001', 'ascii').copy(pvd, 1);
    }
    pvd.writeUInt32LE(root.lba, 156 + 2);
    pvd.writeUInt32LE(root.size, 156 + 10);
    placed.set(16, pvd);

    const totalSectors = Math.max(next, 20);
    const sectorSize = rawSectors ? RAW_SECTOR : ISO_SECTOR;
    const dataOffset = rawSectors ? RAW_DATA_OFFSET : 0;
    const out = Buffer.alloc(totalSectors * sectorSize);
    for (const [lba, buf] of placed) {
        if (!rawSectors) {
            buf.copy(out, lba * ISO_SECTOR);
            continue;
        }
        // With raw geometry the logical bytes are NOT contiguous: 2048 bytes per sector.
        for (let i = 0; i * ISO_SECTOR < buf.length; i++) {
            buf.copy(out, (lba + i) * RAW_SECTOR + dataOffset, i * ISO_SECTOR, Math.min(buf.length, (i + 1) * ISO_SECTOR));
        }
    }
    return out;
}

/**
 * The `SYSTEM.CNF` boot line of a PS1/PS2 disc from a serial ("SLUS-20409" -> "SLUS_204.09").
 * `ps2` → `BOOT2 = cdrom0:\…` (PCSX2); otherwise `BOOT = cdrom:\…` (PS1, DuckStation), with an optional
 * intermediate subdirectory (`subdir`, a case found in production on the user's "Tekken 3" disc).
 */
function serialToBootLine(serial, { ps2 = false, subdir = null } = {}) {
    const [prefix, digits] = serial.split('-');
    const exe = `${prefix}_${digits.slice(0, 3)}.${digits.slice(3)}`;
    if (ps2) return `BOOT2 = cdrom0:\\${exe};1\r\nVER = 1.00\r\nVMODE = NTSC\r\n`;
    const target = subdir ? `${subdir}\\${exe}` : exe;
    return `BOOT = cdrom:\\${target};1\r\nTCB = 4\r\nEVENT = 16\r\nSTACK = 801FFFF0\r\n`;
}

/**
 * PS3/PSP/Vita PARAM.SFO binary: "\0PSF" magic + 20-byte header + 16-byte index entries +
 * key table + data table. Numeric values are int32 (`0x0404`), the rest null-terminated UTF-8 (`0x0204`).
 */
function buildFakeParamSfo(fields) {
    const keys = Object.keys(fields);
    const keyBufs = keys.map((k) => Buffer.concat([Buffer.from(k, 'ascii'), Buffer.from([0])]));
    const indexTable = Buffer.alloc(keys.length * 16);
    const dataBufs = [];
    let keyOffset = 0;
    let dataOffset = 0;
    keys.forEach((k, i) => {
        const val = fields[k];
        const isInt = typeof val === 'number';
        let dataBuf;
        if (isInt) {
            dataBuf = Buffer.alloc(4);
            dataBuf.writeInt32LE(val, 0);
        } else {
            dataBuf = Buffer.from(`${val}\0`, 'utf8');
        }
        const off = i * 16;
        indexTable.writeUInt16LE(keyOffset, off);
        indexTable.writeUInt16LE(isInt ? 0x0404 : 0x0204, off + 2);
        indexTable.writeUInt32LE(dataBuf.length, off + 4);
        indexTable.writeUInt32LE(dataBuf.length, off + 8);
        indexTable.writeUInt32LE(dataOffset, off + 12);
        dataBufs.push(dataBuf);
        keyOffset += keyBufs[i].length;
        dataOffset += dataBuf.length;
    });
    const keyTable = Buffer.concat(keyBufs);
    const header = Buffer.alloc(20);
    Buffer.from([0x00, 0x50, 0x53, 0x46]).copy(header, 0); // "\0PSF" magic
    header.writeUInt32LE(0x00000101, 4);
    const keyTableStart = 20 + indexTable.length;
    header.writeUInt32LE(keyTableStart, 8);
    header.writeUInt32LE(keyTableStart + keyTable.length, 12);
    header.writeUInt32LE(keys.length, 16);
    return Buffer.concat([header, indexTable, keyTable, Buffer.concat(dataBufs)]);
}

/**
 * The pixel data of an 8-bit RGBA PNG (mirroring the `encodePng` contract of
 * `lib/launchers/shared/png-encode.js`): the IDAT chunks via `zlib.inflateSync`, with 1 filter
 * byte (0 = none) per row. Bad signature / non-0 filter -> throws.
 */
function inflatePngPixels(png, width, height) {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (!png.subarray(0, 8).equals(sig)) throw new Error('not a PNG signature');
    let offset = 8;
    const idat = [];
    while (offset < png.length) {
        const len = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + len));
        offset += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const rowBytes = width * 4;
    const pixels = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y++) {
        if (raw[y * (rowBytes + 1)] !== 0) throw new Error(`unexpected PNG filter in row ${y}`);
        raw.copy(pixels, y * rowBytes, y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    }
    return pixels;
}

// --- Zip (lib/launchers/shared/zip-reader.js) ---

function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
}

// A hand-built, minimal zip file (local header + data, THEN central directory + EOCD)
// with one or more entries — `method`: 0 = stored, 8 = deflate (`zlib.deflateRawSync`).
function buildFakeZip(fileEntries) {
    const localParts = [];
    const cdParts = [];
    let offset = 0;
    for (const { name, data, method = 0 } of fileEntries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const compData = method === 8 ? zlib.deflateRawSync(data) : data;
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compData.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, nameBuf, compData);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt16LE(0, 12);
        cd.writeUInt16LE(0, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(compData.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(0, 38);
        cd.writeUInt32LE(offset, 42);
        cdParts.push(cd, nameBuf);

        offset += local.length + nameBuf.length + compData.length;
    }
    const localBuf = Buffer.concat(localParts);
    const cdBuf = Buffer.concat(cdParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(fileEntries.length, 8);
    eocd.writeUInt16LE(fileEntries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([localBuf, cdBuf, eocd]);
}

module.exports = {
    ISO_SECTOR, RAW_SECTOR, RAW_DATA_OFFSET,
    isoDirRecord, buildFakeIso, serialToBootLine, buildFakeParamSfo, inflatePngPixels, buildFakeZip,
};
