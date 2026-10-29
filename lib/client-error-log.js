// @ts-check
'use strict';

// Log-line shape of a renderer-side error (see renderer/errors.js + the global error overlay), used by
// the `log-client-error` handler. On a kiosk machine without devtools this is the ONLY trace of a
// renderer crash. Defensive: fields coerced to strings + length cap (an error loop throwing every frame
// must not flood the log rotation).

const DEFAULT_MAX_FIELD = 4000;

function formatClientErrorLine(payload, maxField = DEFAULT_MAX_FIELD) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const cap = (v) => String(v == null ? '' : v).slice(0, maxField);
    const context = cap(p.context) || 'unknown';
    const message = cap(p.message) || '(no message)';
    const stack = cap(p.stack);
    return `[renderer] ${context}: ${message}${stack ? `\n${stack}` : ''}`;
}

module.exports = { formatClientErrorLine, DEFAULT_MAX_FIELD };
