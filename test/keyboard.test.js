'use strict';

// renderer/keyboard.js — the pure grid navigation of `nextKeyFocus` (does not wrap at the edge,
// the column clamps when stepping onto a shorter row) + the integrity of the KB_ROWS model.

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextKeyFocus, KB_ROWS, KB_ROWS_COMPACT } = require('../renderer/keyboard.js');

const LENS = KB_ROWS.map((row) => row.length); // [10,10,10,6,10,10,3,2]

test('KB_ROWS — every cell has a type, a char cell has a 1-character v', () => {
    assert.ok(KB_ROWS.length >= 6);
    for (const row of KB_ROWS) {
        assert.ok(row.length >= 1);
        for (const k of row) {
            assert.ok(['char', 'shift', 'space', 'del', 'ok', 'cancel'].includes(k.t));
            if (k.t === 'char') assert.equal(typeof k.v, 'string');
            if (k.t === 'char') assert.equal(k.v.length, 1);
        }
    }
});

test('nextKeyFocus — left/right within the row, stops at the edge', () => {
    assert.deepEqual(nextKeyFocus(LENS, { r: 1, c: 3 }, 'right'), { r: 1, c: 4 });
    assert.deepEqual(nextKeyFocus(LENS, { r: 1, c: 3 }, 'left'), { r: 1, c: 2 });
    assert.deepEqual(nextKeyFocus(LENS, { r: 1, c: 0 }, 'left'), { r: 1, c: 0 });
    assert.deepEqual(nextKeyFocus(LENS, { r: 1, c: 9 }, 'right'), { r: 1, c: 9 });
});

test('nextKeyFocus — up/down keeps the column, stops at the edge of the list', () => {
    assert.deepEqual(nextKeyFocus(LENS, { r: 1, c: 5 }, 'down'), { r: 2, c: 5 });
    assert.deepEqual(nextKeyFocus(LENS, { r: 1, c: 5 }, 'up'), { r: 0, c: 5 });
    assert.deepEqual(nextKeyFocus(LENS, { r: 0, c: 5 }, 'up'), { r: 0, c: 5 });
    const last = LENS.length - 1;
    assert.equal(nextKeyFocus(LENS, { r: last, c: 0 }, 'down').r, last);
});

test('nextKeyFocus — stepping to a shorter row the column clamps to the last cell of the row', () => {
    // r2 (10 cells) c8 -> down to r3 (uvwxyz, 6 cells) -> c5
    assert.deepEqual(nextKeyFocus(LENS, { r: 2, c: 8 }, 'down'), { r: 3, c: 5 });
    // r7 (OK/Cancel, 2 cells) c1 -> up to r6 (3 cells) -> c1 stays
    assert.deepEqual(nextKeyFocus(LENS, { r: 7, c: 1 }, 'up'), { r: 6, c: 1 });
});

test('nextKeyFocus — out-of-range input clamps', () => {
    assert.deepEqual(nextKeyFocus(LENS, { r: 99, c: 99 }, 'left'), { r: LENS.length - 1, c: LENS[LENS.length - 1] - 2 });
    assert.deepEqual(nextKeyFocus([], { r: 0, c: 0 }, 'up'), { r: 0, c: 0 });
});

test('KB_ROWS_COMPACT — the compact layout of the search: digits, a-z, space + ⌫ in the letter row, DONE/CANCEL; no Shift', () => {
    const cells = KB_ROWS_COMPACT.flat();
    const letters = cells.filter((k) => k.t === 'char').map((k) => k.v).join('');
    assert.equal(letters, '1234567890abcdefghijklmnopqrstuvwxyz');
    assert.ok(cells.some((k) => k.t === 'space'));
    assert.ok(cells.some((k) => k.t === 'del'));
    assert.ok(cells.some((k) => k.t === 'ok'));
    assert.ok(cells.some((k) => k.t === 'cancel'));
    assert.ok(!cells.some((k) => k.t === 'shift'));
    assert.ok(KB_ROWS_COMPACT.length < KB_ROWS.length, 'lower than the full keyboard');
});

test('nextKeyFocus — works on the compact layout too (clamps to a shorter row, stops at the edge)', () => {
    const lens = KB_ROWS_COMPACT.map((row) => row.length); // [10,10,10,8,2]
    assert.deepEqual(nextKeyFocus(lens, { r: 2, c: 9 }, 'down'), { r: 3, c: 7 });
    assert.deepEqual(nextKeyFocus(lens, { r: 3, c: 7 }, 'down'), { r: 4, c: 1 });
    assert.deepEqual(nextKeyFocus(lens, { r: 4, c: 1 }, 'down'), { r: 4, c: 1 });
});

test('sanitizePaste — line break/control character cleaning, maxLength truncation', () => {
    const { sanitizePaste } = require('../renderer/keyboard.js');
    assert.deepEqual(sanitizePaste('a\r\nb\tc\u0007', 50), { text: 'a b c', truncated: false });
    assert.deepEqual(sanitizePaste('abcdef', 3), { text: 'abc', truncated: true });
    assert.deepEqual(sanitizePaste('abc', 0), { text: '', truncated: true });
    assert.deepEqual(sanitizePaste('', 5), { text: '', truncated: false });
});
