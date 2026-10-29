'use strict';

// Tests of the pure (DOM-free) helpers of renderer/util.js — `node --test`.
// On load the file also puts DOM-calling functions into the global scope (showStatus /
// tickClock), but the tested exports do not touch the DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueToast, launcherLoaderHtml, LOADER_MAX_ICONS, esc, formatClock, formatDate, formatDuration, emptyState, fileUrl, edge, edgeRepeat, stepIndex, navList, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, edgePressed, syncEdge, BTN, normalizeRecentGamesUi } = require('../renderer/util.js');

// A minimal "aggregated pad" for the button indexes: only the given indexes are `pressed: true`.
function padWith(...indices) {
    const buttons = [];
    for (let i = 0; i <= 16; i++) buttons[i] = { pressed: indices.includes(i) };
    return { buttons, axes: [0, 0] };
}

test('esc — escaping HTML metacharacters', () => {
    assert.equal(esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(42), '42');
});

test('formatClock — HH:MM, zero-padded', () => {
    assert.equal(formatClock(new Date(2026, 8, 7, 9, 5)), '09:05');
    assert.equal(formatClock(new Date(2026, 0, 1, 0, 0)), '00:00');
    assert.equal(formatClock(new Date(2026, 11, 31, 23, 59)), '23:59');
    assert.equal(formatClock(new Date(2026, 5, 15, 14, 32)), '14:32');
});

test('formatDate — "YYYY. MM. DD.", zero-padded month/day', () => {
    assert.equal(formatDate(new Date(2026, 8, 7)), '2026. 09. 07.');
    assert.equal(formatDate(new Date(2026, 0, 1)), '2026. 01. 01.');
    assert.equal(formatDate(new Date(2026, 11, 31)), '2026. 12. 31.');
});

test('formatDuration — "Xh Ym" / "Ym" / "0m", negative+NaN -> "0m"', () => {
    assert.equal(formatDuration(0), '0m');
    assert.equal(formatDuration(60000), '1m');
    assert.equal(formatDuration(45 * 60000), '45m');
    assert.equal(formatDuration(3600000), '1h 0m');
    assert.equal(formatDuration(3660000), '1h 1m');
    assert.equal(formatDuration(2 * 3600000 + 15 * 60000), '2h 15m');
    assert.equal(formatDuration(-5000), '0m');
    assert.equal(formatDuration(NaN), '0m');
    assert.equal(formatDuration('not a number'), '0m');
});

test('emptyState — title + optional hint, HTML-escape, .empty-state class', () => {
    const only = emptyState('NO DATA');
    assert.match(only, /class="settings-empty empty-state"/);
    assert.match(only, /empty-state-title">NO DATA</);
    assert.ok(!only.includes('empty-state-hint'));

    const both = emptyState('TITLE', '○ back');
    assert.match(both, /empty-state-hint">○ back</);

    assert.match(emptyState('<b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/); // escape
    assert.match(emptyState(null), /empty-state-title"><\/span>/); // null -> empty
});

test('fileUrl — file:// + per-segment encoding, empty -> ""', () => {
    assert.equal(fileUrl('/home/user/Steam Games/cover art.jpg'),
        'file:///home/user/Steam%20Games/cover%20art.jpg');
    assert.equal(fileUrl(''), '');
    assert.equal(fileUrl(null), '');
});

test('edge — onPress runs only at the moment of the press (does not repeat)', () => {
    const st = {};
    let n = 0;
    edge(st, 'x', true, () => n++);   // press -> runs
    edge(st, 'x', true, () => n++);   // held -> does not run
    edge(st, 'x', false, () => n++);  // release -> does not run
    edge(st, 'x', true, () => n++);   // press again -> runs
    assert.equal(n, 2);
});

test('edgePressed — the "cancel" pseudo-key = Circle OR PS', () => {
    assert.equal(edgePressed(padWith(BTN.circle), 'cancel'), true);
    assert.equal(edgePressed(padWith(BTN.ps), 'cancel'), true);
    assert.equal(edgePressed(padWith(BTN.cross), 'cancel'), false);
    assert.equal(edgePressed(padWith(BTN.cross), 'cross'), true);
    assert.equal(edgePressed(padWith(), 'triangle'), false);
});

test('syncEdge — sets the given keys to the current physical state of the pad', () => {
    const st = { cross: false, ps: true, triangle: true };
    syncEdge(st, padWith(BTN.cross), ['cross', 'ps', 'triangle']);
    assert.deepEqual(st, { cross: true, ps: false, triangle: false });
});

// --- edgeRepeat / stepIndex / navList ---

test('edgeRepeat — first press immediately (repeated=false), no repeat before the delay', () => {
    const st = {};
    const calls = [];
    edgeRepeat(st, 'down', true, (rep) => calls.push(rep), { now: 1000 });
    edgeRepeat(st, 'down', true, (rep) => calls.push(rep), { now: 1000 + REPEAT_DELAY_MS - 1 });
    assert.deepEqual(calls, [false]);
});

test('edgeRepeat — after the delay repeated=true, then per interval', () => {
    const st = {};
    const calls = [];
    const f = (rep) => calls.push(rep);
    edgeRepeat(st, 'down', true, f, { now: 0 });
    edgeRepeat(st, 'down', true, f, { now: REPEAT_DELAY_MS });                                   // 1st repeat
    edgeRepeat(st, 'down', true, f, { now: REPEAT_DELAY_MS + REPEAT_INTERVAL_MS - 1 });          // not yet
    edgeRepeat(st, 'down', true, f, { now: REPEAT_DELAY_MS + REPEAT_INTERVAL_MS });              // 2nd repeat
    assert.deepEqual(calls, [false, true, true]);
});

test('edgeRepeat — custom delay/interval option', () => {
    const st = {};
    let n = 0;
    edgeRepeat(st, 'k', true, () => n++, { now: 0, delay: 100, interval: 170 });
    edgeRepeat(st, 'k', true, () => n++, { now: 100, delay: 100, interval: 170 });   // repeat
    edgeRepeat(st, 'k', true, () => n++, { now: 269, delay: 100, interval: 170 });   // not yet
    edgeRepeat(st, 'k', true, () => n++, { now: 270, delay: 100, interval: 170 });   // repeat
    assert.equal(n, 3);
});

test('edgeRepeat — no catch-up after a slow frame (at most one firing per poll)', () => {
    const st = {};
    let n = 0;
    edgeRepeat(st, 'k', true, () => n++, { now: 0 });
    edgeRepeat(st, 'k', true, () => n++, { now: 5000 });   // a huge gap -> a single repeat
    edgeRepeat(st, 'k', true, () => n++, { now: 5001 });   // the next time computed from now
    assert.equal(n, 2);
});

test('edgeRepeat — release resets it (first press again, with the delay)', () => {
    const st = {};
    const calls = [];
    const f = (rep) => calls.push(rep);
    edgeRepeat(st, 'k', true, f, { now: 0 });
    edgeRepeat(st, 'k', true, f, { now: REPEAT_DELAY_MS });
    edgeRepeat(st, 'k', false, f, { now: REPEAT_DELAY_MS + 10 });
    edgeRepeat(st, 'k', true, f, { now: REPEAT_DELAY_MS + 20 });                     // new first press
    edgeRepeat(st, 'k', true, f, { now: REPEAT_DELAY_MS + 21 });                     // nothing before the delay
    assert.deepEqual(calls, [false, true, false]);
    assert.equal(st.k, true);
});

test('edgeRepeat — a new states object resets the timer; a syncEdge-d (true, timer-less) key starts without an immediate firing', () => {
    let st = {};
    let n = 0;
    edgeRepeat(st, 'k', true, () => n++, { now: 0 });
    st = { k: true };                                                                // e.g. set by syncEdge
    edgeRepeat(st, 'k', true, () => n++, { now: 10_000 });                           // no timer -> just records it
    assert.equal(n, 1);
    edgeRepeat(st, 'k', true, () => n++, { now: 10_000 + REPEAT_DELAY_MS });         // repeats after the delay
    assert.equal(n, 2);
});

test('edgeRepeat — onPress does not run twice in any poll, independent per key', () => {
    const st = {};
    const a = [];
    const b = [];
    edgeRepeat(st, 'up', true, (r) => a.push(r), { now: 0 });
    edgeRepeat(st, 'down', true, (r) => b.push(r), { now: 100 });
    edgeRepeat(st, 'up', true, (r) => a.push(r), { now: REPEAT_DELAY_MS });          // up repeats
    edgeRepeat(st, 'down', true, (r) => b.push(r), { now: REPEAT_DELAY_MS });        // down: nothing until 100+delay
    assert.deepEqual(a, [false, true]);
    assert.deepEqual(b, [false]);
});

test('stepIndex — wraps around on a fresh press, on a repeat it stops at the end/start of the list', () => {
    assert.equal(stepIndex(2, 1, 3, false), 0);
    assert.equal(stepIndex(0, -1, 3, false), 2);
    assert.equal(stepIndex(1, 1, 3, false), 2);
    assert.equal(stepIndex(2, 1, 3, true), 2);
    assert.equal(stepIndex(0, -1, 3, true), 0);
    assert.equal(stepIndex(1, 1, 3, true), 2);
    assert.equal(stepIndex(5, 1, 0, false), 0);   // empty list
    assert.equal(stepIndex(5, 1, 0, true), 0);
});

test('navList — ▲▼ repeats while held (move(d, repeated)), only ✕/○ stays edge', () => {
    const calls = [];
    const fb = [];
    global.feedback = (kind, opts) => fb.push([kind, !!(opts && opts.repeated)]);
    try {
        const st = {};
        let selected = 0;
        const cfg = { count: 3, move: (d, rep) => calls.push([d, rep]), onSelect: () => selected++, onBack: () => {} };
        const t0 = Date.now();
        const realNow = Date.now;
        let now = t0;
        Date.now = () => now;
        try {
            navList(padWith(BTN.down), st, cfg);                                     // first press
            now = t0 + REPEAT_DELAY_MS;
            navList(padWith(BTN.down, BTN.cross), st, cfg);                          // repeat + fresh ✕ press
            now = t0 + REPEAT_DELAY_MS + REPEAT_INTERVAL_MS;
            navList(padWith(BTN.down, BTN.cross), st, cfg);                          // repeat, ✕ does NOT repeat
        } finally { Date.now = realNow; }
        assert.deepEqual(calls, [[1, false], [1, true], [1, true]]);
        assert.equal(selected, 1);
        assert.deepEqual(fb.filter((f) => f[0] === 'nav').slice(0, 1), [['nav', false]]);
        assert.ok(fb.some((f) => f[0] === 'nav' && f[1] === true));                  // repeated flag on a repeat
    } finally { delete global.feedback; }
});

// --- Launcher-icon loader ---

test('launcherLoaderHtml — icons in order, --i index, size class, aria-hidden', () => {
    const html = launcherLoaderHtml([{ id: 'a', icon: 'assets/icons/a.svg' }, { id: 'b', icon: 'assets/icons/b.png' }], { size: 'lg' });
    assert.match(html, /^<div class="launcher-loader launcher-loader-lg" aria-hidden="true">/);
    assert.match(html, /src="assets\/icons\/a\.svg" alt="" style="--i:0"/);
    assert.match(html, /src="assets\/icons\/b\.png" alt="" style="--i:1"/);
    assert.equal((html.match(/<img /g) || []).length, 2);
    assert.ok(!html.includes('launcher-loader-now'));
});

test('launcherLoaderHtml — unknown size → md, immediate → launcher-loader-now', () => {
    const html = launcherLoaderHtml([{ icon: 'x.svg' }], { size: 'xxl', immediate: true });
    assert.match(html, /class="launcher-loader launcher-loader-md launcher-loader-now"/);
});

test('launcherLoaderHtml — empty/bad list → 3 fallback icons; missing icon → fallback', () => {
    for (const bad of [[], null, undefined, 'not an array']) {
        assert.equal((launcherLoaderHtml(bad).match(/<img /g) || []).length, 3);
        assert.ok(launcherLoaderHtml(bad).includes('data:image/svg+xml'));
    }
    const html = launcherLoaderHtml([{ id: 'x' }, { id: 'y', icon: '' }, { id: 'z', icon: 'z.svg' }]);
    assert.equal((html.match(/data:image\/svg\+xml/g) || []).length, 2);
    assert.match(html, /src="z\.svg"/);
});

test('launcherLoaderHtml — LOADER_MAX_ICONS ceiling, the highlighted (activeId) icon always stays in', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, icon: `i${i}.svg` }));
    const capped = launcherLoaderHtml(many);
    assert.equal((capped.match(/<img /g) || []).length, LOADER_MAX_ICONS);
    assert.ok(capped.includes('i0.svg') && !capped.includes('i9.svg'));
    assert.ok(!capped.includes('loader-icon-active'));

    const withActive = launcherLoaderHtml(many, { activeId: 'l10' });
    assert.equal((withActive.match(/<img /g) || []).length, LOADER_MAX_ICONS);
    assert.match(withActive, /class="loader-icon loader-icon-active" src="i10\.svg"/);
    assert.equal((withActive.match(/loader-icon-active/g) || []).length, 1);
});

test('launcherLoaderHtml — the highlighted icon is only the one with a matching id, unknown activeId → no highlight', () => {
    const list = [{ id: 'steam', icon: 's.svg' }, { id: 'heroic', icon: 'h.png' }];
    const html = launcherLoaderHtml(list, { activeId: 'heroic' });
    assert.match(html, /class="loader-icon" src="s\.svg"/);
    assert.match(html, /class="loader-icon loader-icon-active" src="h\.png"/);
    assert.ok(!launcherLoaderHtml(list, { activeId: 'missing' }).includes('loader-icon-active'));
});

test('launcherLoaderHtml — the icon path is HTML-escaped (customLaunchers is hand-editable)', () => {
    const html = launcherLoaderHtml([{ icon: 'a"><script>x</script>.svg' }]);
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('normalizeRecentGamesUi — missing/null input: all 3 bars ON', () => {
    const DEF = { continueBar: true, gamesPanelRecent: true, launcherRecent: true };
    assert.deepEqual(normalizeRecentGamesUi(), DEF);
    assert.deepEqual(normalizeRecentGamesUi(null), DEF);
    assert.deepEqual(normalizeRecentGamesUi({}), DEF);
});

test('normalizeRecentGamesUi — only an explicit false turns it off, per field', () => {
    assert.deepEqual(normalizeRecentGamesUi({ continueBar: false }),
        { continueBar: false, gamesPanelRecent: true, launcherRecent: true });
    assert.deepEqual(normalizeRecentGamesUi({ gamesPanelRecent: false, launcherRecent: false }),
        { continueBar: true, gamesPanelRecent: false, launcherRecent: false });
});

// --- createOverlay ---

test('createOverlay — open: flag + fresh entry state + onOpen with arguments; a second open is a no-op', () => {
    const { createOverlay } = require('../renderer/util.js');
    const opened = [];
    const ov = createOverlay({ elementId: 'missing', enterStates: { cross: true }, onOpen: (...a) => opened.push(a) });
    assert.equal(ov.isOpen(), false);
    ov.states.cross = false; // leftover of an earlier session
    assert.equal(ov.open('x', 2), true);
    assert.equal(ov.isOpen(), true);
    assert.deepEqual(ov.states, { cross: true });
    assert.deepEqual(opened, [['x', 2]]);
    assert.equal(ov.open('y'), false);
    assert.equal(opened.length, 1);
});

test('createOverlay — enterStates as a function of the arguments of open()', () => {
    const { createOverlay } = require('../renderer/util.js');
    const ov = createOverlay({ elementId: 'missing', enterStates: (rerun) => (rerun ? { cross: true } : {}) });
    ov.open(true);
    assert.deepEqual(ov.states, { cross: true });
    ov.reset();
    ov.open(false);
    assert.deepEqual(ov.states, {});
});

test('createOverlay — close(gp): syncEdge of the PARENT state to the given buttons, onClose; without gp no sync', () => {
    const { createOverlay, BTN } = require('../renderer/util.js');
    const parent = { cross: false, ps: false };
    const closed = [];
    const ov = createOverlay({
        elementId: 'missing',
        syncOnClose: () => ({ states: parent, keys: ['cross', 'ps'] }),
        onClose: () => closed.push(true),
    });
    ov.open();
    const buttons = [];
    buttons[BTN.cross] = { pressed: true };
    assert.equal(ov.close({ buttons, axes: [] }), true);
    assert.deepEqual(parent, { cross: true, ps: false }, 'the ✕ still held is "pressed" in the parent');
    assert.equal(closed.length, 1);
    assert.equal(ov.close(), false, 'already closed → no-op');

    parent.cross = false;
    ov.open();
    ov.close();
    assert.deepEqual(parent, { cross: false, ps: false }, 'without gp no sync');
});

test('createOverlay — syncOnClose states:null → skipped; reset() closes without callbacks', () => {
    const { createOverlay } = require('../renderer/util.js');
    let onCloseCalls = 0;
    const ov = createOverlay({ elementId: 'missing', syncOnClose: () => ({ states: null, keys: ['cross'] }), onClose: () => { onCloseCalls += 1; } });
    ov.open();
    assert.equal(ov.close({ buttons: [], axes: [] }), true);
    ov.open();
    ov.reset();
    assert.equal(ov.isOpen(), false);
    assert.equal(onCloseCalls, 1);
});

// --- edgeHold (the Games panel's "✕ short = launch, held = details") ---
test('edgeHold — short press: the tap runs on RELEASE, without hold', () => {
    const { edgeHold } = require('../renderer/util.js');
    const st = {};
    const calls = [];
    const tap = () => calls.push('tap');
    const hold = () => { calls.push('hold'); };
    edgeHold(st, 'cross', true, tap, hold, { now: 0, holdMs: 500 });
    edgeHold(st, 'cross', true, tap, hold, { now: 200, holdMs: 500 });
    assert.deepEqual(calls, []);
    edgeHold(st, 'cross', false, tap, hold, { now: 300, holdMs: 500 });
    assert.deepEqual(calls, ['tap']);
});

test('edgeHold — hold: the hold runs ONCE, no tap after the release', () => {
    const { edgeHold } = require('../renderer/util.js');
    const st = {};
    const calls = [];
    const tap = () => calls.push('tap');
    const hold = () => { calls.push('hold'); };
    for (const now of [0, 300, 600, 900]) edgeHold(st, 'cross', true, tap, hold, { now, holdMs: 500 });
    edgeHold(st, 'cross', false, tap, hold, { now: 1000, holdMs: 500 });
    assert.deepEqual(calls, ['hold']);
});

test('edgeHold — releasing a button still held at entry is not a tap', () => {
    const { edgeHold } = require('../renderer/util.js');
    const st = { cross: true };
    const calls = [];
    edgeHold(st, 'cross', true, () => calls.push('tap'), () => calls.push('hold'), { now: 0, holdMs: 500 });
    edgeHold(st, 'cross', true, () => calls.push('tap'), () => calls.push('hold'), { now: 900, holdMs: 500 });
    edgeHold(st, 'cross', false, () => calls.push('tap'), () => calls.push('hold'), { now: 1000, holdMs: 500 });
    assert.deepEqual(calls, []);
    assert.equal(st.cross, false);
});

test('edgeHold — if onHold returns false, the press runs as a short press (on release)', () => {
    const { edgeHold } = require('../renderer/util.js');
    const st = {};
    const calls = [];
    const tap = () => calls.push('tap');
    const hold = () => { calls.push('hold?'); return false; };
    for (const now of [0, 600, 900]) edgeHold(st, 'cross', true, tap, hold, { now, holdMs: 500 });
    edgeHold(st, 'cross', false, tap, hold, { now: 1000, holdMs: 500 });
    assert.deepEqual(calls, ['hold?', 'tap'], 'the declined hold asks only once');
});

test('edgeRepeat — setRepeatScale: the delay and the pace are scaled too (D1 "slow repeat")', () => {
    const { edgeRepeat, setRepeatScale } = require('../renderer/util.js');
    const st = {};
    const hits = [];
    setRepeatScale(2);
    try {
        edgeRepeat(st, 'down', true, (r) => hits.push(r), { now: 0, delay: 100, interval: 50 });
        edgeRepeat(st, 'down', true, (r) => hits.push(r), { now: 150, delay: 100, interval: 50 }); // < 200: not yet
        edgeRepeat(st, 'down', true, (r) => hits.push(r), { now: 200, delay: 100, interval: 50 }); // 2×100
        edgeRepeat(st, 'down', true, (r) => hits.push(r), { now: 260, delay: 100, interval: 50 }); // < 200+100
        edgeRepeat(st, 'down', true, (r) => hits.push(r), { now: 300, delay: 100, interval: 50 }); // 2×50
        assert.deepEqual(hits, [false, true, true]);
    } finally {
        setRepeatScale(1);
    }
});

// --- safeHtml / rawHtml ---
test('safeHtml — escapes every inserted value', () => {
    const { safeHtml } = require('../renderer/util.js');
    const name = '<img src=x onerror="alert(1)"> & \'Mario\'';
    assert.equal(safeHtml`<div title="${name}">${name}</div>`,
        '<div title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;Mario&#39;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;Mario&#39;</div>');
});

test('safeHtml — rawHtml raw, array element by element, null/undefined/false empty, 0 stays', () => {
    const { safeHtml, rawHtml } = require('../renderer/util.js');
    const rows = ['<a>', 'b'].map((x) => rawHtml(safeHtml`<li>${x}</li>`));
    assert.equal(safeHtml`<ul>${rows}</ul>`, '<ul><li>&lt;a&gt;</li><li>b</li></ul>');
    assert.equal(safeHtml`${null}|${undefined}|${false}|${0}|${['<', rawHtml('<br>')]}`, '|||0|&lt;<br>');
});

test('enqueueToast — the same text (waiting in the queue or currently visible) is not added again', () => {
    const q = [{ msg: 'A', isError: false }];
    assert.equal(enqueueToast(q, { msg: 'A', isError: false }, null, 4), q);
    assert.equal(enqueueToast(q, { msg: 'B', isError: false }, 'B', 4), q); // visible right now
    assert.deepEqual(enqueueToast(q, { msg: 'B', isError: false }, null, 4).map((x) => x.msg), ['A', 'B']);
});

test('enqueueToast — on overflow the non-error toast drops out first; only if all are errors, the oldest', () => {
    const e = (msg) => ({ msg, isError: true });
    const i = (msg) => ({ msg, isError: false });
    // [error, info, info] + new info (max 3): the oldest INFO drops out, the error stays
    assert.deepEqual(enqueueToast([e('E1'), i('I1'), i('I2')], i('I3'), null, 3).map((x) => x.msg), ['E1', 'I2', 'I3']);
    // all errors: the oldest error drops out
    assert.deepEqual(enqueueToast([e('E1'), e('E2'), e('E3')], e('E4'), null, 3).map((x) => x.msg), ['E2', 'E3', 'E4']);
    // all errors, a new info does NOT push an error out of a full queue (the new info is dropped)
    assert.deepEqual(enqueueToast([e('E1'), e('E2')], i('I1'), null, 2).map((x) => x.msg), ['E1', 'E2']);
});
