'use strict';

// renderer/home/tips.js — pure helpers of the first-use tips.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TIPS, unseenTips } = require('../../renderer/home/tips.js');

test('TIPS — unique identifiers, each has an i18n key and a params function', () => {
    const ids = TIPS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of TIPS) {
        assert.match(t.textKey, /^tip\./);
        assert.equal(typeof t.params, 'function');
    }
});

test('unseenTips — only the identifiers not yet seen, in order', () => {
    assert.deepEqual(unseenTips(['a', 'b', 'c'], new Set(['b'])), ['a', 'c']);
    assert.deepEqual(unseenTips(['a'], new Set(['a'])), []);
});
