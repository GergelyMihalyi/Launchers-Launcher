// Global renderer error handling: (1) every `window` `error`/`unhandledrejection` goes into main's log (`logClientError` → `log-client-error`
// IPC), so the Log subview shows it too; (2) the first error brings up a `#fatalOverlay` (✕ = reload, ○·PS = quit) with a button watcher
// INDEPENDENT of the main `pollGamepad`. Load order: AFTER util.js, BEFORE every other renderer/*.js. Does NOT use `tr()` (i18n may be the
// broken link). The pure helpers are exported (test/errors.test.js). Background: docs/dev/renderer/overview.md#errors-and-fire-and-forget-promises

// --- Pure helpers ---

// Normalizes an error-like value ({message, stack}). Handles: Error, string, ErrorEvent ({message, error, filename, lineno, colno}),
// PromiseRejectionEvent ({reason}), a plain object, null/undefined.
function summarizeError(errLike) {
    if (errLike == null) return { message: '(unknown error)', stack: '' };
    if (typeof errLike === 'string') return { message: errLike, stack: '' };

    // PromiseRejectionEvent: the actual reason is in `reason`
    if (typeof errLike === 'object' && 'reason' in errLike && !(errLike instanceof Error)) {
        return summarizeError(errLike.reason);
    }

    // ErrorEvent: `error` is the actual Error (if any), otherwise we build from the fields
    if (typeof errLike === 'object' && 'message' in errLike && 'filename' in errLike) {
        if (errLike.error instanceof Error) {
            const s = summarizeError(errLike.error);
            return s;
        }
        const loc = errLike.filename
            ? ` (${errLike.filename}:${errLike.lineno || 0}:${errLike.colno || 0})`
            : '';
        return { message: String(errLike.message || 'error') + loc, stack: '' };
    }

    if (errLike instanceof Error || (typeof errLike === 'object' && 'message' in errLike)) {
        return {
            message: String(errLike.message || errLike.name || 'error'),
            stack: typeof errLike.stack === 'string' ? errLike.stack : '',
        };
    }

    try {
        return { message: JSON.stringify(errLike), stack: '' };
    } catch {
        return { message: String(errLike), stack: '' };
    }
}

// The first `n` meaningful lines of the stack (empty lines + node/electron internal frame noise filtered out), cut for length. The first
// line is often the error message itself — it is kept too.
function firstStackLines(stack, n = 4) {
    if (!stack || typeof stack !== 'string') return [];
    return stack
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.includes('node:internal') && !l.includes('node:electron'))
        .slice(0, n);
}

// --- Overlay + IPC (not tested) ---

const FATAL_MAX_FORWARD = 30;        // this many errors per instance are forwarded to the log, after that we only count
const FATAL_SAME_MSG_MS = 2000;      // the same message is forwarded at most this often (against an error loop)

let _fatalVisible = false;
let _fatalExtra = 0;                 // number of further errors thrown after the overlay appeared
let _fwdCount = 0;
const _fwdSeen = new Map();          // message -> timestamp of the last forward
let _fatalRaf = null;
let _fatalEdge = { cross: false, cancel: false };

// The central entry point — callable from anywhere (global in the shared scope). Logs over IPC + brings up the overlay. Never throws (the
// error handler itself must not become a new error source).
function reportClientError(context, errLike) {
    let summary;
    try {
        summary = summarizeError(errLike);
    } catch {
        summary = { message: '(processing the error failed too)', stack: '' };
    }

    try {
        forwardClientError(context, summary);
    } catch { /* logging is best effort */ }

    try {
        if (!_fatalVisible) showFatalOverlay(summary);
        else bumpFatalExtra();
    } catch { /* the overlay is best effort */ }
}

function forwardClientError(context, summary) {
    const now = Date.now();
    const last = _fwdSeen.get(summary.message);
    if (last && now - last < FATAL_SAME_MSG_MS) return;
    if (_fwdCount >= FATAL_MAX_FORWARD) return;
    _fwdSeen.set(summary.message, now);
    _fwdCount += 1;
    const stack = firstStackLines(summary.stack, 6).join('\n');
    if (typeof window !== 'undefined' && window.launcher && window.launcher.logClientError) {
        window.launcher.logClientError({ context: String(context || 'renderer'), message: summary.message, stack });
    }
}

function bumpFatalExtra() {
    _fatalExtra += 1;
    const meta = $('fatalOverlayMeta');
    if (meta) meta.textContent = `+${_fatalExtra} more errors since it appeared`;
}

function showFatalOverlay(summary) {
    const overlay = $('fatalOverlay');
    if (!overlay) return;
    _fatalVisible = true;
    _fatalExtra = 0;
    const msgEl = $('fatalOverlayMessage');
    if (msgEl) {
        const lines = [summary.message, ...firstStackLines(summary.stack, 4)];
        msgEl.textContent = lines.join('\n');
    }
    const meta = $('fatalOverlayMeta');
    if (meta) meta.textContent = '';
    // A direct style change (not a class) — the failsafe path: if styles/*.css did not load, the inline style is the only thing that gives a
    // readable overlay. No need to hide it (the user reloads or quits from here).
    overlay.style.display = 'flex';
    // The edge state is seeded from the CURRENT button state — a button already held (e.g. the X that triggered the error) must not fire
    // immediately.
    _fatalEdge = readFatalButtons();
    startFatalInput();
}

// The aggregated button state of the connected pads — NOT aggregatePad of renderer/gamepad.js (that file may be the broken link); ~10 lines
// of standalone code.
function readFatalButtons() {
    let cross = false;
    let cancel = false;
    try {
        for (const p of navigator.getGamepads()) {
            if (!p || !p.connected) continue;
            if (p.buttons[0] && p.buttons[0].pressed) cross = true;
            if ((p.buttons[1] && p.buttons[1].pressed) || (p.buttons[16] && p.buttons[16].pressed)) cancel = true;
        }
    } catch { /* getGamepads may throw in some states */ }
    return { cross, cancel };
}

function startFatalInput() {
    if (_fatalRaf !== null) return;
    const tick = () => {
        if (!_fatalVisible) { _fatalRaf = null; return; }
        const now = readFatalButtons();
        if (now.cross && !_fatalEdge.cross) { doFatalReload(); return; }
        if (now.cancel && !_fatalEdge.cancel) { doFatalQuit(); return; }
        _fatalEdge = now;
        _fatalRaf = requestAnimationFrame(tick);
    };
    _fatalRaf = requestAnimationFrame(tick);
}

function stopFatalInput() {
    if (_fatalRaf !== null) { cancelAnimationFrame(_fatalRaf); _fatalRaf = null; }
}

function doFatalReload() {
    stopFatalInput();
    try { window.location.reload(); } catch { /* if this fails too, Quit remains */ }
}

function doFatalQuit() {
    stopFatalInput();
    try { window.launcher.quit(); } catch { /* nothing to do */ }
}

function onWindowError(ev) {
    reportClientError('window.onerror', ev);
}

function onWindowRejection(ev) {
    reportClientError('unhandledrejection', ev);
}

// Keyboard fallback (testing without a controller / emergency exit next to a stuck pad) — capture phase, only while the overlay is visible,
// so nothing else catches it first.
function onFatalKey(e) {
    if (!_fatalVisible) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); doFatalReload(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); doFatalQuit(); }
}

if (typeof window !== 'undefined') {
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onWindowRejection);
    document.addEventListener('keydown', onFatalKey, true);
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { summarizeError, firstStackLines });
}
