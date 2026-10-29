// @ts-check
'use strict';

// Log-line levels + export. The logger (`lib/exec.js` `createLogger`) writes an EXPLICIT `WARN`/`ERROR` marker after the
// timestamp via `log.warn()`/`log.error()`; the hundreds of older unmarked `log()` lines are classified by keyword in
// `classifyLogLine` (English + the older Hungarian lines: "error", "failed", "hiba" → error; "skipped", "missing", "timeout", "kihagyva" → warn).
// The Settings → Log subview filters (L2/R2) and highlights errors with it; `exportLog` writes a text file into the home folder
// that can be attached to a bug report.

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const LOG_LEVELS = ['error', 'warn', 'info'];

const TIMESTAMP_RE = /^\[[^\]]*\]\s*/;
const LEVEL_TAG_RE = /^(ERROR|WARN)\b/;
// Classification of the old (unmarked) lines. `\b` is ASCII-based — the Hungarian words are searched
// without word boundaries ("hibát", "hibakód" count as errors too).
const ERROR_RE = /hib[aá]|sikertelen|nem sikerült|\berror\b|\bfailed\b|\bfailure\b|exception|uncaught|\[renderer\]/i;
const WARN_RE = /\bwarn|\bskipped\b|\bnot found\b|\bunavailable\b|\btimed? out\b|\btimeout\b|\bmissing\b|figyelmeztet|kihagyva|nem található|nem érhető el|időtúllép|hiányz/i;

/**
 * Level of a log line: the explicit `ERROR`/`WARN` marker (after the timestamp) wins, otherwise the
 * keywords. Pure.
 * @param {string} line
 * @returns {{ text: string, level: 'error'|'warn'|'info' }}
 */
function classifyLogLine(line) {
    const text = String(line == null ? '' : line);
    const body = text.replace(TIMESTAMP_RE, '');
    const tag = LEVEL_TAG_RE.exec(body);
    if (tag) return { text, level: tag[1] === 'ERROR' ? 'error' : 'warn' };
    if (ERROR_RE.test(body)) return { text, level: 'error' };
    if (WARN_RE.test(body)) return { text, level: 'warn' };
    return { text, level: 'info' };
}

// Local time, for a file name: `2026-09-25_140312`.
function stampOf(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_`
        + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

async function readOr(p, fallback = null) {
    try {
        return await fsp.readFile(p, 'utf8');
    } catch {
        return fallback;
    }
}

/**
 * The log(s) into one text file for a bug report: header (the `header` lines), then the main log (first
 * the rotated `.1`, then the current one), finally the extra logs (watcher / BT trigger), each in its own
 * `=== <name> ===` section. Missing files are skipped. Never throws.
 * @param {Object} o
 * @param {string} o.logFile the main log
 * @param {string[]} [o.extraLogs]
 * @param {string[]} [o.header]
 * @param {string} [o.destDir] default: the home folder
 * @param {Date} [o.now]
 * @returns {Promise<{ ok: true, file: string, bytes: number } | { ok: false, error: string }>}
 */
async function exportLog({ logFile, extraLogs = [], header = [], destDir = os.homedir(), now = new Date() }) {
    try {
        const parts = [...header, `Exported: ${now.toISOString()}`, ''];
        for (const f of [`${logFile}.1`, logFile, ...extraLogs]) {
            const text = await readOr(f);
            if (text == null) continue;
            parts.push(`=== ${path.basename(f)} ===`, text.replace(/\n$/, ''), '');
        }
        const file = path.join(destDir, `launchers-launcher-log-${stampOf(now)}.txt`);
        const data = `${parts.join('\n')}\n`;
        await fsp.writeFile(file, data);
        return { ok: true, file, bytes: Buffer.byteLength(data) };
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
}

// Bytes read from the end of the log for the last N lines (the file grows to 2 MB; 500 lines ~60–100 KB).
const LOG_TAIL_MAX_BYTES = 256 * 1024;

/**
 * The last `maxLines` non-empty lines of the log with levels — only reads the END of the file
 * (`maxBytes`), not the whole (up to 2 MB) log. When not reading from the start of the file, the first
 * (truncated) line is dropped. No log yet (ENOENT) → `[]`; other I/O errors throw.
 * @param {string} file
 * @param {{ maxLines?: number, maxBytes?: number }} [o]
 */
async function readLogTail(file, { maxLines = 500, maxBytes = LOG_TAIL_MAX_BYTES } = {}) {
    let fh;
    try {
        fh = await fsp.open(file, 'r');
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    try {
        const { size } = await fh.stat();
        const len = Math.min(size, maxBytes);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, size - len);
        let lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
        if (len < size) lines = lines.slice(1);
        return lines.filter((l) => l.length > 0).slice(-maxLines).map(classifyLogLine);
    } finally {
        await fh.close();
    }
}

module.exports = { LOG_LEVELS, LOG_TAIL_MAX_BYTES, classifyLogLine, exportLog, readLogTail, stampOf };
