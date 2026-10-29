'use strict';

// lib/startup-timeline.js — startup timeline.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStartupTimeline, formatTimeline, MARKS } = require('../lib/startup-timeline.js');

test('mark — only a known milestone, once; list in chronological order', () => {
    let t = 100.4;
    const tl = createStartupTimeline({ now: () => t });
    assert.equal(tl.mark('windowCreated'), true);
    t = 50;
    assert.equal(tl.mark('appReady'), true);
    t = 999;
    assert.equal(tl.mark('appReady'), false, 'a renderer reload must not overwrite it');
    assert.equal(tl.mark('unknown'), false);
    assert.deepEqual(tl.list(), [{ name: 'appReady', ms: 50 }, { name: 'windowCreated', ms: 100 }]);
    assert.equal(tl.has('warmupDone'), false);
});

test('formatTimeline — one log line', () => {
    assert.equal(formatTimeline([{ name: 'appReady', ms: 180 }, { name: 'windowCreated', ms: 640 }]),
        '[startup] appReady 180ms · windowCreated 640ms');
    assert.ok(MARKS.includes('launchersRendered'));
});

test('default clock: the positive ms elapsed since the process start', () => {
    const tl = createStartupTimeline();
    tl.mark('appReady');
    assert.ok(tl.list()[0].ms > 0);
});
