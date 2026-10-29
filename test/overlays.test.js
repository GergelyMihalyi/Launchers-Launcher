'use strict';

// renderer/overlays.js — the return session-summary decision and the loader screen's
// cover URL. A classic <script>, module.exports guard at the bottom of the file.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fileUrl } = require('../renderer/util.js');

globalThis.fileUrl = fileUrl; // a global in the browser (renderer/util.js)
const { sessionSummary, SESSION_SUMMARY_MIN_MS, loadingCoverSrc, playtimeReminderText } = require('../renderer/overlays.js');

const MIN = 60 * 1000;

test('sessionSummary — short / missing session or name: no summary', () => {
    assert.equal(SESSION_SUMMARY_MIN_MS, MIN);
    assert.equal(sessionSummary(undefined, 'Zelda'), null);
    assert.equal(sessionSummary({ sessionMs: 59 * 1000, totalMs: 10 * MIN }, 'Zelda'), null);
    assert.equal(sessionSummary({ sessionMs: 5 * MIN, totalMs: 10 * MIN }, ''), null);
    assert.equal(sessionSummary({ sessionMs: 'x' }, 'Zelda'), null);
});

test('sessionSummary — with the total, if there was earlier playtime', () => {
    assert.deepEqual(sessionSummary({ appId: 'a', sessionMs: 72 * MIN, totalMs: 14 * 60 * MIN }, 'Zelda'), {
        key: 'toast.sessionSummary', name: 'ZELDA', sessionMs: 72 * MIN, totalMs: 14 * 60 * MIN,
    });
});

test('sessionSummary — first time / unknown total: only the current one', () => {
    assert.equal(sessionSummary({ sessionMs: 5 * MIN, totalMs: 5 * MIN }, 'Zelda').key, 'toast.sessionSummaryFirst');
    assert.equal(sessionSummary({ sessionMs: 5 * MIN, totalMs: null }, 'Zelda').key, 'toast.sessionSummaryFirst');
});

test('loadingCoverSrc — local path → file:// URL, URL shape unchanged, empty → empty', () => {
    assert.equal(loadingCoverSrc('/home/u/a b/c.png'), 'file:///home/u/a%20b/c.png');
    assert.equal(loadingCoverSrc('file:///x.png'), 'file:///x.png');
    assert.equal(loadingCoverSrc(null), '');
});

test('playtimeReminderText — gives text only when enabled and the threshold is reached', () => {
    const t = (key, p) => `${key}:${p.time}`;
    const fmt = (ms) => `${Math.round(ms / 60000)}m`;
    const H = 60 * MIN;
    assert.equal(playtimeReminderText({ todayMs: 3 * H }, 0, t, fmt), null); // off
    assert.equal(playtimeReminderText({ todayMs: 2 * H - 1 }, 2, t, fmt), null); // not reached yet
    assert.equal(playtimeReminderText({ todayMs: 2 * H }, 2, t, fmt), 'toast.playtimeReminder:120m');
    assert.equal(playtimeReminderText({ todayMs: null }, 2, t, fmt), null);
    assert.equal(playtimeReminderText(null, 2, t, fmt), null);
});
