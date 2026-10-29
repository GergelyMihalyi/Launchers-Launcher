'use strict';

// The pure idle-decision function (`isIdle`) - renderer/home/idle.js is a classic <script> in the
// browser, but there is a module.exports guard at the bottom of the file (like carousel.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { isIdle, stepAxis, resolveIdleFocus } = require('../../renderer/home/idle.js');

test('isIdle — the threshold time has not elapsed yet', () => {
    assert.equal(isIdle(1000, 1000 + 60_000, 180_000), false);
});

test('isIdle — has just crossed the threshold', () => {
    assert.equal(isIdle(1000, 1000 + 180_000, 180_000), true);
});

test('isIdle — expired long ago', () => {
    assert.equal(isIdle(1000, 1000 + 999_999, 180_000), true);
});

test('isIdle — a zero threshold is idle immediately', () => {
    assert.equal(isIdle(1000, 1000, 0), true);
});

// stepAxis — the "DVD logo" wall bounce of the bouncing icons on one axis.
test('stepAxis — movement within the bounds does not bounce', () => {
    const r = stepAxis(10, 100, 0.1, 64, 400); // 10 + 10 = 20, max = 400-64 = 336
    assert.equal(r.pos, 20);
    assert.equal(r.v, 100);
});

test('stepAxis — hitting the right/bottom edge the position is clamped to the bound and the velocity reverses', () => {
    const r = stepAxis(330, 100, 1, 64, 400); // 330 + 100 = 430 > max (336)
    assert.equal(r.pos, 336);
    assert.equal(r.v, -100);
});

test('stepAxis — hitting the left/top edge (negative velocity) it reverses too', () => {
    const r = stepAxis(5, -50, 1, 64, 400); // 5 - 50 = -45 < 0
    assert.equal(r.pos, 0);
    assert.equal(r.v, 50);
});

test('stepAxis — with a boundMax smaller than the icon size the max is clamped to 0 (not negative)', () => {
    const r = stepAxis(0, 100, 1, 64, 30); // boundMax(30) < size(64)
    assert.equal(r.pos, 0);
    assert.equal(r.v, -100);
});

// resolveIdleFocus — the screensaver only counts with a focused window, and
// from zero when focus returns (time spent in the background does not count).
test('resolveIdleFocus — no focus: not running, lastInputAt unchanged', () => {
    const r = resolveIdleFocus(false, true, 5000, 1000);
    assert.deepEqual(r, { run: false, hadFocus: false, lastInputAt: 1000 });
});

test('resolveIdleFocus — focus return (hadFocus false -> true): lastInputAt resets to now', () => {
    const r = resolveIdleFocus(true, false, 5000, 1000);
    assert.deepEqual(r, { run: true, hadFocus: true, lastInputAt: 5000 });
});

test('resolveIdleFocus — continuous focus: running, lastInputAt untouched', () => {
    const r = resolveIdleFocus(true, true, 5000, 1000);
    assert.deepEqual(r, { run: true, hadFocus: true, lastInputAt: 1000 });
});

test('resolveIdleFocus — time spent in the background does not exceed the threshold on return', () => {
    const bootAt = 1000;
    // 2 hours of play in the background, then back to the launcher:
    const backAt = bootAt + 2 * 60 * 60 * 1000;
    const r = resolveIdleFocus(true, false, backAt, bootAt);
    assert.equal(isIdle(r.lastInputAt, backAt, 180_000), false);
});
