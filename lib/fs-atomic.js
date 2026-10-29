// @ts-check
'use strict';

// Atomic file write (mkdir + temp file + rename). Rename is atomic on the same filesystem: an interrupted
// write (crash / exit) cannot leave a half-written target; the reader (the launcher OR a shell script
// `cat`-ing it) always sees the full old or new content. The streaming download of `lib/net.js` keeps its
// own temp+rename (data arrives continuously there, no ready buffer).

const fs = require('fs');
const path = require('path');

// The temp name is pid + an in-process counter — two consecutive writes (or a worker thread and the main
// process) can never collide on the same temp file.
let seq = 0;

/**
 * Throws if the write failed (the caller decides whether it is best effort) — tries to clean up the
 * leftover temp file in that case.
 *
 * `{ fsync: true }`: forces the temp file's content to disk BEFORE the rename — on a power cut (the kiosk
 * machine is often switched off at the socket) the rename can then not point to an empty/truncated file.
 * Only for small, critical state files (config, sidecars); the cover/scan caches go without it (many
 * writes, a lost cache entry is rebuilt).
 * @param {string} file
 * @param {string | Buffer} data
 * @param {{ fsync?: boolean, mode?: number }} [opts] `mode`: permissions of the created file (e.g. `0o600`; filtered by umask)
 */
function writeFileAtomic(file, data, opts = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    seq += 1;
    const tmp = `${file}.${process.pid}.${seq}.tmp`;
    try {
        if (opts.fsync) {
            const fd = fs.openSync(tmp, 'w', opts.mode);
            try {
                const buf = typeof data === 'string' ? Buffer.from(data) : data;
                for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off);
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
        } else {
            fs.writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
        }
        fs.renameSync(tmp, file);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) { /* not created */ }
        throw err;
    }
}

module.exports = { writeFileAtomic };
