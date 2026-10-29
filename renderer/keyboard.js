// On-screen keyboard — controller-driven, alphabetical 2D grid, a standalone overlay ABOVE Settings (higher z-index).
// Callback-based: openKeyboard({ title, initial, masked, maxLength, onConfirm(text), onCancel(), ownerStates, layout, dock, live,
// onChange(text), suggestions }). Optional (the Games panel's live search): layout 'compact' (KB_ROWS_COMPACT, no Shift/punctuation),
// dock 'bottom' (transparent background, sits on the bottom edge), live (`onChange` after every edit), suggestions (a top row of ready
// texts, ✕ = insert). `ownerStates` = the caller's *ButtonStates — `syncEdge`-d on close (a still held ✕ must not be a new press).
// Load order: AFTER settings-*.js + setup-wizard.js, BEFORE ipc.js. Background: docs/dev/renderer/input.md#on-screen-keyboard

// Grid model: an array of cells per row. `t` = type, `v` = character, `w` = flex ratio (styling only, every cell is 1 step for navigation).
// Node/test: `createOverlay` from renderer/util.js (a global <script> loaded EARLIER in the browser) — the `createOverlay(...)` call at the
// top of the file needs it on require too.
if (typeof createOverlay === 'undefined' && typeof module !== 'undefined') {
    Object.assign(globalThis, { createOverlay: module.require('./util.js').createOverlay });
}

/** @typedef {{ t: string, v?: string, w?: number }} KbKey — one key (t = type, v = character, w = flex width) */
/** @type {KbKey[][]} */
const KB_ROWS = [
    '1234567890'.split('').map((v) => ({ t: 'char', v })),
    'abcdefghij'.split('').map((v) => ({ t: 'char', v })),
    'klmnopqrst'.split('').map((v) => ({ t: 'char', v })),
    'uvwxyz'.split('').map((v) => ({ t: 'char', v })),
    '.,-_@!?#/:'.split('').map((v) => ({ t: 'char', v })),
    ';+=~%&*()$"\''.split('').map((v) => ({ t: 'char', v })), // the quotes are for the values of the launch options (game details)
    [{ t: 'shift', w: 3 }, { t: 'space', w: 5 }, { t: 'del', w: 3 }],
    [{ t: 'ok', w: 5 }, { t: 'cancel', w: 5 }],
];

// Compact (search) layout: no Shift and punctuation — space and ⌫ go into the letter rows, so 5 rows instead of 8 (the docked keyboard
// covers ~40% less of the list).
/** @type {KbKey[][]} */
const KB_ROWS_COMPACT = [
    '1234567890'.split('').map((v) => ({ t: 'char', v })),
    'abcdefghij'.split('').map((v) => ({ t: 'char', v })),
    'klmnopqrst'.split('').map((v) => ({ t: 'char', v })),
    [...'uvwxyz'.split('').map((v) => ({ t: 'char', v })), { t: 'space', w: 2 }, { t: 'del', w: 2 }],
    [{ t: 'ok', w: 5 }, { t: 'cancel', w: 5 }],
];

let kbRows = KB_ROWS; // the active layout (set by openKeyboard from cfg.layout)
let kbConfig = null;
let kbText = '';
let kbShift = false;
let kbPos = { r: 1, c: 0 };

// Pure grid navigation: `rowLens` = cell count per row, `pos` = { r, c }, `dir` = 'up'|'down'|'left'|'right'. Does NOT wrap at the edge;
// stepping onto a shorter row clamps the column to the row's last cell. test/keyboard.test.js.
function nextKeyFocus(rowLens, pos, dir) {
    const nRows = rowLens.length;
    if (!nRows) return { r: 0, c: 0 };
    let r = Math.max(0, Math.min(nRows - 1, pos.r | 0));
    let c = Math.max(0, Math.min(rowLens[r] - 1, pos.c | 0));
    if (dir === 'left') c = Math.max(0, c - 1);
    else if (dir === 'right') c = Math.min(rowLens[r] - 1, c + 1);
    else if (dir === 'up' || dir === 'down') {
        r = dir === 'up' ? Math.max(0, r - 1) : Math.min(nRows - 1, r + 1);
        c = Math.min(c, rowLens[r] - 1);
    }
    return { r, c };
}

// Lifecycle on the shared `createOverlay` (renderer/util.js).
const keyboardPanel = createOverlay({
    elementId: 'keyboardOverlay',
    // — every call site opens the keyboard as the direct result of a ✕ press, the entering ✕ may still be held.
    enterStates: { cross: true },
    // The calling subview's button watching was not updated while the keyboard was open.
    syncOnClose: () => ({ states: kbConfig ? kbConfig.ownerStates : null, keys: ['cross', 'cancel'] }),
    onOpen: (cfg) => {
        kbConfig = Object.assign(
            {
                title: '', initial: '', masked: false, maxLength: 128, onConfirm: () => {}, onCancel: () => {}, ownerStates: null,
                layout: 'full', dock: null, live: false, onChange: null, suggestions: [],
            },
            cfg || {},
        );
        kbRows = kbConfig.layout === 'compact' ? KB_ROWS_COMPACT : KB_ROWS;
        const sug = (Array.isArray(kbConfig.suggestions) ? kbConfig.suggestions : []).filter(Boolean);
        const hasSug = sug.length > 0;
        if (hasSug) kbRows = [sug.map((v) => ({ t: 'sug', v: String(v) })), ...kbRows];
        // The `docked` class is set ON OPEN (not removed on close): during the 0.15 s fade-out the panel must not jump back to the center.
        $('keyboardOverlay').classList.toggle('docked', kbConfig.dock === 'bottom');
        kbText = String(kbConfig.initial || '');
        kbShift = false;
        kbPos = { r: hasSug ? 2 : 1, c: 0 };
        renderKeyboard();
    },
});

function openKeyboard(cfg) { keyboardPanel.open(cfg); }

function closeKeyboard(gp) { keyboardPanel.close(gp); }

function kbKeyLabel(k) {
    if (k.t === 'char') return kbShift ? k.v.toUpperCase() : k.v;
    if (k.t === 'sug') return k.v || '';
    if (k.t === 'shift') return '⇧';
    if (k.t === 'space') return tr('kb.space');
    if (k.t === 'del') return '⌫';
    if (k.t === 'ok') return tr('kb.ok');
    if (k.t === 'cancel') return tr('kb.cancel');
    return '';
}

function renderKeyboard() {
    $('keyboardTitle').textContent = kbConfig.title || tr('kb.title');
    const shown = kbConfig.masked ? '•'.repeat(kbText.length) : kbText;
    $('keyboardInput').textContent = shown + '▏';
    $('keyboardGrid').innerHTML = kbRows.map((row, r) => {
        const keys = row.map((k, c) => {
            const cls = ['keyboard-key'];
            if (k.t !== 'char') cls.push('keyboard-key-special');
            if (k.t === 'sug') cls.push('keyboard-key-sug');
            if (k.t === 'shift' && kbShift) cls.push('active');
            if (r === kbPos.r && c === kbPos.c) cls.push('focused');
            const style = k.w ? ` style="flex:${k.w}"` : '';
            return `<div class="${cls.join(' ')}"${style}>${esc(kbKeyLabel(k))}</div>`;
        }).join('');
        return `<div class="keyboard-row">${keys}</div>`;
    }).join('');
    $('keyboardHint').innerHTML = `
        <span>▲▼◀▶ ${esc(tr('kb.hintMove'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('kb.hintType'))}</span>
        <span>${btnIcon('alt')} ${esc(tr('kb.hintDelete'))}</span>
        <span>${btnIcon('menu')} ${esc(tr('kb.hintSpace'))}</span>
        ${kbConfig.live
        ? `<span>${btnIcon('start')} / ${btnIcon('back')} ${esc(tr('kb.hintDone'))}</span>`
        : `<span>${btnIcon('start')} ${esc(tr('kb.hintDone'))}</span><span>${btnIcon('back')} ${esc(tr('kb.hintCancel'))}</span>`}
    `;
}

// In live mode (`live` + `onChange`) notifies the caller after every text change.
function kbChanged() {
    if (kbConfig && kbConfig.live && typeof kbConfig.onChange === 'function') kbConfig.onChange(kbText);
}

// □ = ⌫ and △ = space (PlayStation habit) — no need to walk to the ⌫/space key on the grid while typing.
function kbBackspace() {
    if (!kbText) return;
    kbText = kbText.slice(0, -1);
    feedback('back');
    renderKeyboard();
    kbChanged();
}

function kbAppend(ch) {
    if (kbText.length >= kbConfig.maxLength) return;
    kbText += ch;
    feedback('nav');
    renderKeyboard();
    kbChanged();
}

// DONE / CANCEL — the shared core of the grid keys, ○/PS and Start. In live mode the filtering is already visible on the list behind, so
// there ○/PS (and Esc) KEEP the text (like DONE), so the user can move onto the results; the restoring CANCEL is only the grid's CANCEL key.
function kbConfirm(gp) {
    const text = kbText;
    const cb = kbConfig.onConfirm;
    closeKeyboard(gp);
    feedback('nav');
    cb(text);
}

function kbCancel(gp) {
    const cb = kbConfig.onCancel;
    closeKeyboard(gp);
    feedback('back');
    cb();
}

function kbActivate(gp) {
    const k = kbRows[kbPos.r] && kbRows[kbPos.r][kbPos.c];
    if (!k) return;
    if (k.t === 'char' || k.t === 'space') {
        if (kbText.length < kbConfig.maxLength) {
            kbText += k.t === 'space' ? ' ' : (kbShift ? k.v.toUpperCase() : k.v);
            feedback('nav');
            kbChanged();
        }
    } else if (k.t === 'sug') {
        kbText = String(k.v || '').slice(0, kbConfig.maxLength);
        feedback('nav');
        kbChanged();
    } else if (k.t === 'del') {
        kbText = kbText.slice(0, -1);
        feedback('back');
        kbChanged();
    } else if (k.t === 'shift') {
        kbShift = !kbShift;
        feedback('nav');
    } else if (k.t === 'ok') {
        kbConfirm(gp);
        return;
    } else if (k.t === 'cancel') {
        kbCancel(gp);
        return;
    }
    renderKeyboard();
}

function handleKeyboardInput(gp) {
    const bs = keyboardPanel.states;
    const rowLens = kbRows.map((row) => row.length);
    // A held direction repeats (edgeRepeat) — stops at the grid edge (nextKeyFocus does not wrap).
    const move = (dir, rep) => { kbPos = nextKeyFocus(rowLens, kbPos, dir); renderKeyboard(); feedback('nav', { repeated: rep }); };
    edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed || gp.axes[1] < -AXIS_THRESHOLD, (rep) => move('up', rep));
    edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed || gp.axes[1] > AXIS_THRESHOLD, (rep) => move('down', rep));
    edgeRepeat(bs, 'left', gp.buttons[BTN.left]?.pressed || gp.axes[0] < -AXIS_THRESHOLD, (rep) => move('left', rep));
    edgeRepeat(bs, 'right', gp.buttons[BTN.right]?.pressed || gp.axes[0] > AXIS_THRESHOLD, (rep) => move('right', rep));
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => kbActivate(gp));
    edge(bs, 'square', gp.buttons[BTN.square]?.pressed, () => kbBackspace());
    edge(bs, 'triangle', gp.buttons[BTN.triangle]?.pressed, () => kbAppend(' '));
    // Start/Options = DONE (always); ○/PS = DONE in live mode, CANCEL otherwise (see above kbConfirm).
    edge(bs, 'start', gp.buttons[BTN.start]?.pressed, () => kbConfirm(gp));
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        if (kbConfig.live) kbConfirm(gp);
        else kbCancel(gp);
    });
}

// Cleans pasted text: line break/tab → space, other control characters removed, trimmed at the edges; `room` = the number of characters
// that still fit. Returns { text, truncated }.
function sanitizePaste(raw, room) {
    const clean = String(raw || '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    const max = Math.max(0, room | 0);
    return { text: clean.slice(0, max), truncated: clean.length > max };
}

// Ctrl+V: the system clipboard text (main-side `clipboard`, IPC) to the end of the text field.
function kbPasteFromClipboard() {
    window.launcher.readClipboardText().then((res) => {
        if (!keyboardPanel.isOpen() || !res || !res.ok) return;
        const { text, truncated } = sanitizePaste(res.text, kbConfig.maxLength - kbText.length);
        if (truncated) showStatus(tr('kb.pasteTruncated'), true);
        if (!text) return;
        kbText += text;
        feedback('nav');
        renderKeyboard();
        kbChanged();
    }).catch(ignoreError);
}

// Keyboard fallback (debug / test, without a controller) — called by the keydown branch of renderer/main.js if keyboardPanel.isOpen().
// `action`: 'confirm' | 'cancel' | 'backspace' | { dir } | a single character.
function kbKey(action) {
    if (!keyboardPanel.isOpen()) return;
    if (action === 'confirm') {
        const text = kbText; const cb = kbConfig.onConfirm; closeKeyboard(); cb(text); return;
    }
    if (action === 'cancel') {
        if (kbConfig.live) { const text = kbText; const cb = kbConfig.onConfirm; closeKeyboard(); cb(text); return; }
        const cb = kbConfig.onCancel; closeKeyboard(); cb(); return;
    }
    if (action === 'paste') { kbPasteFromClipboard(); return; }
    if (action === 'backspace') { kbText = kbText.slice(0, -1); renderKeyboard(); kbChanged(); return; }
    if (action && typeof action === 'object' && action.dir) {
        kbPos = nextKeyFocus(kbRows.map((row) => row.length), kbPos, action.dir);
        renderKeyboard();
        return;
    }
    if (typeof action === 'string' && action.length === 1 && kbText.length < kbConfig.maxLength) {
        kbText += action;
        renderKeyboard();
        kbChanged();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { nextKeyFocus, sanitizePaste, KB_ROWS, KB_ROWS_COMPACT });
}
