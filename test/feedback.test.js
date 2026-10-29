'use strict';

// `normalizeFeedback()` of renderer/feedback.js — fills the raw (IPC / config) feedback object
// into a complete, typed state. `sound`/`rumble`/`motion` default ON, `contrast`
// default OFF. All three load sites in renderer/ipc.js call it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFeedback } = require('../renderer/feedback.js');

const DEF = { sound: true, rumble: true, motion: true, contrast: false, slowRepeat: false, screenReader: false };

test('normalizeFeedback — missing/null input: sound/rumble/motion ON, contrast OFF', () => {
    assert.deepEqual(normalizeFeedback(), DEF);
    assert.deepEqual(normalizeFeedback(null), DEF);
    assert.deepEqual(normalizeFeedback({}), DEF);
});

test('normalizeFeedback — only an explicit false turns it off (sound/rumble/motion)', () => {
    assert.deepEqual(normalizeFeedback({ sound: false }),
        { ...DEF, sound: false });
    assert.deepEqual(normalizeFeedback({ motion: false, rumble: false }),
        { ...DEF, rumble: false, motion: false });
});

test('normalizeFeedback — contrast turns on only for an explicit true', () => {
    assert.equal(normalizeFeedback({ contrast: true }).contrast, true);
    assert.equal(normalizeFeedback({ contrast: 1 }).contrast, false);
    assert.equal(normalizeFeedback({ contrast: 'yes' }).contrast, false);
});

test('normalizeFeedback — slowRepeat / screenReader only for an explicit true (D1)', () => {
    assert.equal(normalizeFeedback({ slowRepeat: true }).slowRepeat, true);
    assert.equal(normalizeFeedback({ screenReader: true }).screenReader, true);
    assert.equal(normalizeFeedback({ slowRepeat: 1, screenReader: 'on' }).slowRepeat, false);
});
