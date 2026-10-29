// @ts-check
'use strict';

// Runtime "format alarm" for external command output: if a command succeeded and produced output but the parser still found nothing
// (after a distro/DE update, like `pactl` in a Hungarian locale) → a one-off `log.warn` + the `formatDrift` list of `get-selftest`
// (Diagnostics). Usage: `checkParsed('pactl-sinks', stdout, sinks.length)`. Real output samples are recorded by
// `tools/capture-host-output.js` under `test/fixtures/host-output/`. Background: docs/dev/infrastructure.md#diagnostics-log-startup-timeline-format-drift

/** @type {(msg: string) => void} */
let warn = () => {};
/** @type {Map<string, { at: string, bytes: number }>} */
const seen = new Map();

/** main passes `log.warn` at startup (silent until then). @param {(msg: string) => void} fn */
function setFormatDriftLogger(fn) {
    warn = typeof fn === 'function' ? fn : () => {};
}

/**
 * @param {string} probe id of the command + parser (e.g. `pactl-sinks`)
 * @param {string} stdout the command's raw output
 * @param {number} parsedCount the number of items the parser found
 * @param {{ emptyIsNormal?: (stdout: string) => boolean }} [opts] if non-empty output with 0 items can be legit (e.g. only
 *   disconnected monitors), the predicate deciding it
 * @returns {boolean} whether it was suspicious
 */
function checkParsed(probe, stdout, parsedCount, opts = {}) {
    const text = typeof stdout === 'string' ? stdout.trim() : '';
    if (!text || parsedCount > 0) return false;
    if (opts.emptyIsNormal && opts.emptyIsNormal(text)) return false;
    if (!seen.has(probe)) {
        seen.set(probe, { at: new Date().toISOString(), bytes: text.length });
        warn(`[format] ${probe}: the command produced ${text.length} bytes of output, but the parser found nothing in it — `
            + 'the output format may have changed (distro/DE update?). Check: node tools/capture-host-output.js');
    }
    return true;
}

/** Probes found suspicious during the session (for Diagnostics). */
function getFormatDrift() {
    return [...seen.entries()].map(([probe, v]) => ({ probe, ...v }));
}

/** For tests. */
function resetFormatDrift() {
    seen.clear();
}

module.exports = { setFormatDriftLogger, checkParsed, getFormatDrift, resetFormatDrift };
