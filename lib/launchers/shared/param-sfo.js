// @ts-check
'use strict';

// Shared, minimal binary parser for the PS3/PSP/Vita "PARAM.SFO" (used by rpcs3 + ppsspp). Format: magic `\0PSF` @0 → header (key-table/
// data-table offset + entry count @8/12/16) → 16-byte index entries → key table (null-terminated ASCII) → data table (`data_fmt ===
// 0x0404` → int32 LE, otherwise null-terminated UTF-8). Readable without crypto.

const PSF_MAGIC = Buffer.from([0x00, 0x50, 0x53, 0x46]); // "\0PSF"

/**
 * @param {Buffer} buf
 * @returns {Object<string, (string|number)>}
 */
function parseParamSfo(buf) {
    /** @type {Object<string, (string|number)>} */
    const out = {};
    try {
        if (!Buffer.isBuffer(buf) || buf.length < 20 || !buf.subarray(0, 4).equals(PSF_MAGIC)) return out;
        const keyTableStart = buf.readUInt32LE(8);
        const dataTableStart = buf.readUInt32LE(12);
        const entries = buf.readUInt32LE(16);
        for (let i = 0; i < entries; i++) {
            const off = 20 + i * 16;
            if (off + 16 > buf.length) break;
            const keyOffset = buf.readUInt16LE(off);
            const dataFmt = buf.readUInt16LE(off + 2);
            const dataLen = buf.readUInt32LE(off + 4);
            const dataOffset = buf.readUInt32LE(off + 12);
            const keyStart = keyTableStart + keyOffset;
            const keyEnd = buf.indexOf(0, keyStart);
            if (keyStart >= buf.length || keyEnd < 0) continue;
            const key = buf.toString('ascii', keyStart, keyEnd);
            const valStart = dataTableStart + dataOffset;
            if (valStart < 0 || valStart + dataLen > buf.length) continue;
            if (dataFmt === 0x0404 && dataLen === 4) {
                out[key] = buf.readInt32LE(valStart);
            } else {
                let str = buf.toString('utf8', valStart, valStart + dataLen);
                const nul = str.indexOf('\0');
                if (nul >= 0) str = str.slice(0, nul);
                out[key] = str;
            }
        }
    } catch (err) { /* broken/unknown structure — empty object */ }
    return out;
}

module.exports = { parseParamSfo, PSF_MAGIC };
