// Shared renderer helpers: HTML escape, gamepad edge trigger + navList pattern, button indexes, toast, icon fallback. No top-level
// DOM access — so the pure `esc` can be required from Node too (module.exports guard at the bottom of the file), for `test/*.test.js`.
//
// Loaded as a classic <script src> (index.html), AFTER controller-id.js, BEFORE every other renderer/*.js. Top-level
// `let`/`const`/`function` land in the shared global lexical scope, so they are visible from files loaded later (no import/export).

// HTML escape for every interpolated text not coming from code (sink description, BT device name, launcher name from the hand-editable
// `customLaunchers` config key): a `<` / `&` / `"` must not break the layout or allow (theoretical) injection into innerHTML. Button
// icon markup stays raw - that comes from code, not external data.
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Safe HTML template: every `${…}` value is escaped automatically, so a forgotten `esc()` cannot let a ROM file name / SSID / BT name
// through as raw HTML. Ready (trusted, code-built) HTML is marked with `rawHtml(...)`; arrays go in item by item (raw strings escaped,
// `rawHtml`s not); `null`/`undefined`/`false` → ''.
//   $('x').innerHTML = safeHtml`<div class="row">${game.name}${rawHtml(tagHtml)}</div>`;
// Use this in NEW renderer code instead of manual `esc()` chains (existing `esc()` code stays).
// The result of a nested `safeHtml` is a string — put it into another template as `rawHtml(...)`.
/** @param {string} value */
function rawHtml(value) {
    return { __rawHtml: String(value == null ? '' : value) };
}

/** @param {any} v @returns {string} */
function safeHtmlValue(v) {
    if (v == null || v === false) return '';
    if (Array.isArray(v)) return v.map(safeHtmlValue).join('');
    if (typeof v === 'object' && typeof v.__rawHtml === 'string') return v.__rawHtml;
    return esc(v);
}

/** @param {TemplateStringsArray} strings @param {...any} values @returns {string} */
function safeHtml(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += safeHtmlValue(values[i]) + strings[i + 1];
    return out;
}

// Shorthand for document.getElementById (the renderer calls it dozens of times, several times per render for the same element).
// `test/contracts/dom-ids.test.js` checks at source level that every `$('id')` / `getElementById('id')` literal points to an element
// that exists in index.html.
function $(id) {
    return document.getElementById(id);
}

// --- Launcher icon loader ---
// ONE shared loading indicator everywhere the launcher may load (launch overlay, `await`s of the Settings / Games panel, refresh,
// installer, BT search, startup skeleton): the icons of the ACTIVE launchers in a row, lighting up one after another in a wave (pure CSS,
// `.launcher-loader` in styles/*.css). `[data-motion="off"]` stops the wave → a static icon row remains.
const LOADER_MAX_ICONS = 7; // with more launchers than this, it takes from the start of the list (so it does not overflow)

// Pure: `list` = [{ id?, icon? }] (the shape of `launchers`), `opts`: size ('sm'|'md'|'lg', default 'md'), activeId (that icon is
// HIGHLIGHTED, not pulsing — the launch overlay's "what is starting" signal), immediate (true: no 150 ms delayed fade-in — for
// long-running / often redrawn places). Empty list → 3× FALLBACK_ICON; missing `icon` → FALLBACK_ICON (a broken file is replaced by the
// delegated `error` listener of renderer/main.js).
function launcherLoaderHtml(list, opts) {
    const o = opts || {};
    const size = ['sm', 'md', 'lg'].includes(o.size) ? o.size : 'md';
    let items = (Array.isArray(list) ? list : []).filter((l) => l && typeof l === 'object');
    if (items.length > LOADER_MAX_ICONS) {
        const active = o.activeId != null ? items.find((l) => l.id === o.activeId) : null;
        items = items.slice(0, LOADER_MAX_ICONS);
        if (active && !items.includes(active)) items[LOADER_MAX_ICONS - 1] = active;
    }
    if (!items.length) items = [{}, {}, {}];
    const imgs = items.map((l, i) => {
        const src = typeof l.icon === 'string' && l.icon ? l.icon : FALLBACK_ICON;
        const active = o.activeId != null && l.id === o.activeId ? ' loader-icon-active' : '';
        return `<img class="loader-icon${active}" src="${esc(src)}" alt="" style="--i:${i}">`;
    }).join('');
    return `<div class="launcher-loader launcher-loader-${size}${o.immediate ? ' launcher-loader-now' : ''}" aria-hidden="true">${imgs}</div>`;
}

// Thin wrapper reading the `launchers` renderer global (state.js) — safe from Node (tests) and before `launchers` is loaded, thanks to
// the `typeof` guard.
function loadingBlock(size, opts) {
    const list = typeof launchers !== 'undefined' ? launchers : [];
    return launcherLoaderHtml(list, Object.assign({ size: size || 'md' }, opts));
}

// Loading indicator while the Settings subviews / Games panel `await`, instead of a silent "LOADING...". The `n` parameter is a leftover
// of the old row skeleton (so the callers' signature did not change) — the launcher icon loader is a single block, not `n` rows.
function skeletonList(n = 4) {
    return loadingBlock('md');
}

// Uniform empty state: a faint, centered `title` + an optional `hint` second line. The COMPANION of `renderSubviewError()` (settings.js)
// — that one is the "query failed" case, this one "succeeded, but empty". Every list renderer calls it for 0 items instead of a
// hand-written `<div class="settings-empty">…`. Escapes both texts (not from code); the caller may put a `btnGlyph('back')` into `hint`
// (that is a plain glyph).
function emptyState(title, hint) {
    const t = `<span class="empty-state-title">${esc(String(title == null ? '' : title))}</span>`;
    const h = hint ? `<span class="empty-state-hint">${esc(String(hint))}</span>` : '';
    return `<div class="settings-empty empty-state">${t}${h}</div>`;
}

// Icon fallback: if a launcher icon is missing / cannot be loaded (broken asset file), this neutral "controller" SVG is shown instead
// of the broken-image sign.
const FALLBACK_ICON = 'data:image/svg+xml,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#8b8b9b"><path d="M7 8h10a4.5 4.5 0 0 1 4.43 3.7l1.02 5.6A2.2 2.2 0 0 1 19.1 19l-2-3.4H6.9L4.9 19a2.2 2.2 0 0 1-3.37-1.7l1.02-5.6A4.5 4.5 0 0 1 7 8Zm.5 2.2v1.6H5.9v1.6h1.6v1.6h1.6v-1.6h1.6v-1.6H9.1v-1.6zm9 .3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2m-2 2.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2"/></svg>');

// --- Toast (status message) FIFO queue ---
// `showStatus()` used to overwrite the running message, and every call started its own 3 s timeout -> poller-based pushes
// (running-changed / launchers-changed / theme-changed) arriving together swallowed each other, or an old timeout cleared the new one
// early. Now they queue up: one is visible for `TOAST_MS`, then after a short pause the next comes. At `TOAST_MAX` the queue drops the
// oldest (the fresh one matters).
const TOAST_MS = 1800;
const TOAST_ERROR_MS = 3000; // an error toast stays visible longer
const TOAST_GAP_MS = 180;
const TOAST_MAX = 4;
let _toastQueue = [];
let _toastActive = false;

// The pure core of the toast queue: inserting a new item. (1) Text identical to one already waiting OR currently shown is not added
// again (quick consecutive volume/switch toasts); (2) on overflow a NON-error toast drops first (the oldest — if that is the new one,
// then the new one, so an info never pushes out an error), only if all are errors, the oldest error. Returns a new array (the input is
// untouched).
function enqueueToast(queue, item, activeMsg, max) {
    if (item.msg === activeMsg || queue.some((q) => q.msg === item.msg)) return queue;
    const next = [...queue, item];
    while (next.length > max) {
        const i = next.findIndex((q) => !q.isError);
        next.splice(i >= 0 ? i : 0, 1);
    }
    return next;
}

// `opts.ms` — a toast visible longer than usual (e.g. "△ UNDO").
function showStatus(msg, isError = false, opts = {}) {
    const el = $('status');
    const activeMsg = _toastActive && el ? el.textContent : null;
    const ms = (opts && opts.ms) || (isError ? TOAST_ERROR_MS : TOAST_MS);
    _toastQueue = enqueueToast(_toastQueue, { msg: String(msg == null ? '' : msg), isError: !!isError, ms }, activeMsg, TOAST_MAX);
    if (!_toastActive) drainToast();
}

let _toastTimer = null;
function drainToast() {
    const el = $('status');
    const next = _toastQueue.shift();
    if (!next) { _toastActive = false; if (el) el.className = 'status'; return; }
    _toastActive = true;
    el.textContent = next.msg;
    el.className = 'status visible' + (next.isError ? ' error' : '');
    _toastTimer = setTimeout(endToast, next.ms || TOAST_MS);
}

function endToast() {
    _toastTimer = null;
    const el = $('status');
    if (el) el.className = 'status';
    setTimeout(drainToast, TOAST_GAP_MS);
}

// Closes the CURRENTLY visible toast early if it is `msg` (e.g. "△ UNDO" would be misleading after the undo); the rest of the queue
// comes in the usual order.
function dismissStatus(msg) {
    const el = $('status');
    if (!_toastTimer || !el || el.textContent !== String(msg)) return;
    clearTimeout(_toastTimer);
    endToast();
}

// --- Clock (header + future places) ---
// Locale-independent, deterministic formatting (`toLocaleTimeString` would depend on ICU, and it must be stable in
// test/util.test.js too). `formatClock` -> "14:32", `formatDate` -> "2026. 09. 07.".
function formatClock(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}. ${p(d.getMonth() + 1)}. ${p(d.getDate())}.`;
}

// Bytes → "4,2 GB" (base 1024, one decimal below 10; used by the game details file size and the save backups). Missing / negative → ''.
function formatBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let x = v;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    const r = Math.round(x * 10) / 10;
    const num = i === 0 || x >= 10 ? String(Math.round(x)) : String(r).replace('.', ',');
    return `${num} ${units[i]}`;
}

// Playtime ms -> "2h 15m" / "45m" / "0m" (for the Statistics subview). The h/m letters are understood in both UI languages (games UI
// convention). Negative / NaN -> "0m".
function formatDuration(ms) {
    const totalMin = Math.max(0, Math.floor(Number(ms) / 60000)) || 0;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Refreshes the #clock element (called by renderer/main.js at startup + every minute).
function tickClock() {
    const el = $('clock');
    if (!el) return;
    const now = new Date();
    const t = el.querySelector('.clock-time');
    const dt = el.querySelector('.clock-date');
    if (t) t.textContent = formatClock(now);
    if (dt) dt.textContent = formatDate(now);
}

// --- Gamepad edge-trigger helpers ---
// The DualSense standard button indexes the UI watches. `select`/`start` are the left/right "system" buttons of the W3C Standard
// Gamepad mapping (PS Share/Options, Xbox View/Menu, Switch -/+): `select` opens Settings, `start` the quick system menu
// (renderer/home/quick-power.js).
const BTN = { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7, select: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15, ps: 16 };

// Edge trigger: `onPress` only runs at the moment of the press, it does not repeat while the button is held. `states` is a per-view
// object (do not share it between views — the edge states would collide). This replaces the four-liner
//   if (b && !bs.x) { bs.x = true; f(); } else if (!b) { bs.x = false; }
// for every button.
function edge(states, key, pressed, onPress) {
    if (pressed && !states[key]) {
        states[key] = true;
        onPress();
    } else if (!pressed) {
        states[key] = false;
    }
}

// The CURRENT physical state of an edge-watched button. The `'cancel'` pseudo key = Circle OR PS (as navList watches it too); anything
// else is a button index from the `BTN` map.
function edgePressed(gp, key) {
    if (key === 'cancel') return !!(gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed);
    return !!gp.buttons[BTN[key]]?.pressed;
}

// Sets the given edge keys to the pad's current physical state. CALL it on every panel close / view step-back: while the panel was open,
// the edge state of the main nav (or the menu) was not updated, so a button still held would count as a new press on the next frame
// (instant launch / quit).
function syncEdge(states, gp, keys) {
    for (const key of keys) states[key] = edgePressed(gp, key);
}

// Edge trigger WITH REPEAT (sibling of `edge`, for DIRECTION buttons): the first press calls `onPress(false)` immediately, when held
// `onPress(true)` after `delay` ms, then every `interval` ms. No catch-up (at most one fire per poll, time counted against `now`), so a
// slow render does not pile up steps. The timers live in a WeakMap keyed by `states` — reassigning `states = {…}` and `syncEdge` reset
// them. `opts`: { delay = REPEAT_DELAY_MS, interval = REPEAT_INTERVAL_MS, now = Date.now() }.
// ACTION buttons (✕/○/△/□/Start…) need `edge` — repeating would be wrong there.
const REPEAT_DELAY_MS = 380;
const REPEAT_INTERVAL_MS = 95;
const _repeatTimers = new WeakMap();
// "Slow repeat" (`feedback.slowRepeat`): the initial delay AND the rate of every held direction are multiplied by this — for users
// with motor difficulties. Set by `applyRepeatPref()` in settings-theme.js.
const SLOW_REPEAT_SCALE = 2.5;
let repeatScale = 1;
function setRepeatScale(scale) {
    repeatScale = Number(scale) > 0 ? Number(scale) : 1;
}

function edgeRepeat(states, key, pressed, onPress, opts) {
    const o = opts || {};
    let timers = _repeatTimers.get(states);
    if (!pressed) {
        states[key] = false;
        if (timers) delete timers[key];
        return;
    }
    const now = o.now != null ? o.now : Date.now();
    const delay = (o.delay != null ? o.delay : REPEAT_DELAY_MS) * repeatScale;
    const interval = (o.interval != null ? o.interval : REPEAT_INTERVAL_MS) * repeatScale;
    if (!timers) { timers = {}; _repeatTimers.set(states, timers); }
    if (!states[key]) {
        states[key] = true;
        timers[key] = now + delay;
        onPress(false);
    } else if (timers[key] == null) {
        timers[key] = now + delay;
    } else if (now >= timers[key]) {
        timers[key] = now + interval;
        onPress(true);
    }
}

// Short press OR hold on the same button (the home screen card menu's "long ✕" pattern, generalized — the Games panel's "hold ✕ =
// details"): `onHold()` runs once as soon as the button has been held for `holdMs`; if there was no hold, `onTap()` runs on RELEASE of
// the button. Only counts the RISING edge: releasing a button already held on entry (`states[key] === true`) is not a tap. If `onHold()`
// returns `false` (nothing to show on the focused item), the press falls back to a tap (runs on release). The timers — like
// `edgeRepeat` — live in a `WeakMap<states>`: a fresh `states` resets by itself.
const HOLD_MS = 550;
const _holdTimers = new WeakMap();

function edgeHold(states, key, pressed, onTap, onHold, opts) {
    const o = opts || {};
    const now = o.now != null ? o.now : Date.now();
    const holdMs = o.holdMs != null ? o.holdMs : HOLD_MS;
    let timers = _holdTimers.get(states);
    if (!timers) { timers = {}; _holdTimers.set(states, timers); }
    if (pressed) {
        if (!states[key]) timers[key] = { start: now, fired: false, declined: false };
        states[key] = true;
        const t = timers[key];
        if (t && !t.fired && !t.declined && now - t.start >= holdMs) {
            if (onHold && onHold() !== false) t.fired = true;
            else t.declined = true;
        }
        return;
    }
    const t = timers[key];
    if (states[key] && t && !t.fired) onTap();
    states[key] = false;
    delete timers[key];
}

// Steps a focus index on an `n`-item list. A fresh press wraps around (the current behavior); while REPEATING (`repeated === true`,
// held direction) it stops at the end/start of the list — a held ▼ must not spin endlessly on a 3-4 row list. The carousel
// (ringOffset) DELIBERATELY wraps when repeating too; this helper does not step it.
function stepIndex(idx, d, n, repeated) {
    if (!(n > 0)) return 0;
    if (repeated) return Math.max(0, Math.min(n - 1, idx + d));
    return (((idx + d) % n) + n) % n;
}

// Shared "N rows, OPTIONALLY with 2-step confirmation" mechanics (render + arming + reset timer) for quick-power.js and
// settings-system.js; the two CALL SITES stay separate. It lives here (not in settings-toggle.js) because quick-power.js loads much
// earlier (a factory call there would throw a ReferenceError). Details: docs/dev/renderer/overview.md#settings-view-factories
//
// cfg: { rows, isRowArmed?, onImmediate?, onConfirm, rerender, isStillOpen, armMs? }
//   - rows: [{ id, labelKey, icon, armed? }] — `armed: false` = no confirmation (`onImmediate`); may also be `() => rows`; a `label`
//     field overrides `labelKey`, `icon` may be omitted.
//   - onImmediate(row): IMMEDIATE choice of a non-armed row. onConfirm(row): the 2nd ✕ (`feedback('launch')` already played).
//   - rerender(): the caller's own render*, after every state change. isStillOpen(): the reset timer only calls `rerender()` then.
/**
 * @param {Object} cfg
 * @param {Array<Object>|(() => Array<Object>)} cfg.rows
 * @param {(row: any) => boolean} [cfg.isRowArmed]
 * @param {(row: any) => void} [cfg.onImmediate]
 * @param {(row: any) => void} cfg.onConfirm
 * @param {() => void} cfg.rerender
 * @param {() => boolean} cfg.isStillOpen
 * @param {number} [cfg.armMs]
 */
function createArmedActionList({
    rows, isRowArmed, onImmediate, onConfirm, rerender, isStillOpen, armMs = 3000,
}) {
    const rowArmed = isRowArmed || ((row) => row.armed !== false);
    const getRows = typeof rows === 'function' ? rows : () => rows;
    let focusIndex = 0;
    let armedIndex = null;
    let armTimer = null;

    function clearArm() {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        armedIndex = null;
    }

    function rowsHtml() {
        return getRows().map((row, i) => {
            const armed = rowArmed(row) && i === armedIndex;
            const text = row.label != null ? row.label : tr(row.labelKey);
            const label = armed
                ? tr('sv.powerConfirm', { confirm: btnGlyph('confirm') })
                : (row.icon ? `${row.icon}  ${text}` : text);
            const cls = ['settings-item'];
            if (i === focusIndex) cls.push('focused');
            if (armed) cls.push('armed');
            const section = row.sectionKey ? `<div class="settings-subhead">${esc(tr(row.sectionKey))}</div>` : '';
            return `${section}<div class="${cls.join(' ')}"><span class="bt-name">${esc(label)}</span></div>`;
        }).join('');
    }

    function reset() { focusIndex = 0; clearArm(); }

    function moveFocus(d, repeated) {
        focusIndex = stepIndex(focusIndex, d, getRows().length, repeated);
        clearArm();
        feedback('nav', { repeated });
        rerender();
    }

    function select() {
        const row = getRows()[focusIndex];
        if (!row) return;
        if (!rowArmed(row)) { if (onImmediate) onImmediate(row); return; }
        if (armedIndex === focusIndex) {
            clearArm();
            feedback('launch');
            onConfirm(row);
            return;
        }
        clearArm();
        armedIndex = focusIndex;
        feedback('nav');
        rerender();
        armTimer = setTimeout(() => {
            armedIndex = null;
            armTimer = null;
            if (isStillOpen()) rerender();
        }, armMs);
    }

    return {
        rowsHtml, reset, moveFocus, select, clearArm,
    };
}

// The "▲▼ = focus, ✕ = choose, ○ = back" pattern used by almost every Settings subview. The caller supplies `count` and the
// `move(delta, repeated)` / `onSelect` / `onBack` callbacks (the caller keeps the focus index). `count` 0 → ▲▼ is a no-op, ✕/○ work.
// `feedback('nav'|'launch'|'back')` sounds in one place here (only sound when repeating, no rumble); for `cross`, onSelect() RUNS
// FIRST, so a list that triggers a launch wins with its own `feedback('launch')`.
function navList(gp, states, { count, move, onSelect, onBack }) {
    edgeRepeat(states, 'up', gp.buttons[BTN.up]?.pressed, (rep) => { if (count) { move(-1, rep); feedback('nav', { repeated: rep }); } });
    edgeRepeat(states, 'down', gp.buttons[BTN.down]?.pressed, (rep) => { if (count) { move(1, rep); feedback('nav', { repeated: rep }); } });
    edge(states, 'cross', gp.buttons[BTN.cross]?.pressed, () => { onSelect(); feedback('nav'); });
    edge(states, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => { onBack(); feedback('back'); });
}

// Renderer-side normalization of the `recentGamesUi` config key (like `normalizeFeedback` in renderer/feedback.js) — all ON by default.
function normalizeRecentGamesUi(raw) {
    const r = raw || {};
    return {
        continueBar: r.continueBar !== false,
        gamesPanelRecent: r.gamesPanelRecent !== false,
        launcherRecent: r.launcherRecent !== false,
    };
}

// Cover image error fallback: on an `<img>` load error (or for an image that ALREADY failed, if wiring runs later than the innerHTML
// swap) replaces it with a `.recent-game-noart` caption placeholder (quick-launch bar, Continue bar, the Games panel's "Recently played"
// bar). `nameOf(img)` gives the caption (default: `alt`), `checkAlreadyFailed` (default false) also handles `img.complete &&
// naturalWidth === 0`.
function wireCoverFallback(container, selector, nameOf, checkAlreadyFailed) {
    if (!container) return;
    const getName = nameOf || ((img) => img.getAttribute('alt') || '');
    container.querySelectorAll(selector).forEach((img) => {
        const swap = () => {
            const span = document.createElement('span');
            span.className = 'recent-game-noart';
            span.textContent = getName(img);
            img.replaceWith(span);
        };
        img.addEventListener('error', swap, { once: true });
        if (checkAlreadyFailed && img.complete && img.naturalWidth === 0) swap();
    });
}

// Local image path -> file:// URL (the CSP img-src 'self' file: allows it). Segments are encoded separately so a space / accent does not
// break the src. Shared by the games-panel cover grid and the carousel quick-launch bar.
function fileUrl(p) {
    if (!p) return '';
    return 'file://' + String(p).split('/').map(encodeURIComponent).join('/');
}

// `.catch(ignoreError)` for fire-and-forget Promises: otherwise the global `unhandledrejection` handler would bring up #fatalOverlay
// (in production: "unknown error" on every button press). A NAME instead of the `() => {}` repeated everywhere — the rule is greppable,
// the intent ("the error is deliberately dropped") readable. The error is logged anyway if the called IPC handler logs it
// (`lib/ipc/ipc-guard.js`).
function ignoreError() { /* deliberately empty */ }

// --- Shared lifecycle of popups (overlays) ---
// Three rules of every controller-driven popup (against "double exit" bugs): (1) on open, the OWN edge state (`ov.states`) is fresh (the
// opening button may still be held); (2) `.visible` on the overlay element; (3) on close, `syncEdge` of the PARENT edge state to the
// physical buttons. cfg: { elementId, enterStates (an object OR a function computing from the open() arguments), syncOnClose: () => ({
// states, keys }) (`states: null` → skipped; only for close() called with `gp`), onOpen(...args) (AFTER the flag + `ov.states`, BEFORE
// `.visible`), onClose(gp) (AFTER removing `.visible` + the sync) }.
// Returns: { states, isOpen(), open(...args) → bool, close(gp) → bool, reset() } — `reset()` closes without callbacks.
// Background: docs/dev/renderer/overview.md#overlays-createoverlay-and-overlay_stack
/**
 * @param {Object} cfg
 * @param {string} cfg.elementId
 * @param {Object<string, boolean>|((...args: any[]) => Object<string, boolean>)} [cfg.enterStates]
 * @param {() => ({ states: Object|null, keys: string[] })} [cfg.syncOnClose]
 * @param {(...args: any[]) => any} [cfg.onOpen]
 * @param {(gp?: any) => void} [cfg.onClose]
 */
function createOverlay({ elementId, enterStates = {}, syncOnClose = null, onOpen = null, onClose = null }) {
    let openFlag = false;
    const setVisible = (on) => {
        const el = typeof document !== 'undefined' ? document.getElementById(elementId) : null;
        if (el) el.classList.toggle('visible', on);
    };
    const ov = {
        /** @type {Object<string, boolean>} */
        states: {},
        isOpen: () => openFlag,
        open(...args) {
            if (openFlag) return false;
            openFlag = true;
            ov.states = { ...(typeof enterStates === 'function' ? enterStates(...args) : enterStates) };
            if (onOpen) onOpen(...args);
            setVisible(true);
            return true;
        },
        close(gp) {
            if (!openFlag) return false;
            openFlag = false;
            setVisible(false);
            if (gp && syncOnClose) {
                const target = syncOnClose();
                if (target && target.states) syncEdge(target.states, gp, target.keys);
            }
            if (onClose) onClose(gp);
            return true;
        },
        reset() {
            openFlag = false;
            setVisible(false);
        },
    };
    return ov;
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { enqueueToast, ignoreError, createOverlay, launcherLoaderHtml, LOADER_MAX_ICONS, esc, safeHtml, rawHtml, formatClock, formatDate, formatDuration, formatBytes, emptyState, fileUrl, edge, edgeRepeat, setRepeatScale, SLOW_REPEAT_SCALE, edgeHold, HOLD_MS, stepIndex, navList, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, edgePressed, syncEdge, BTN, normalizeRecentGamesUi });
}
