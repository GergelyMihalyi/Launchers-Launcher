'use strict';

// lib/fatal-policy.js — when an uncaught main-process error is fatal.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFatalPolicy } = require('../lib/fatal-policy.js');

function manual() {
    let pending = null;
    const p = createFatalPolicy({ schedule: (fn) => { pending = fn; } });
    return { p, fire: () => pending && pending() };
}

test('everything is fatal during startup (the self-update rollback makes sense there)', () => {
    const { p } = manual();
    assert.equal(p.isFatal('unhandledRejection'), true);
    assert.equal(p.isFatal('uncaughtException'), true);
    p.settleAfter(30000);
    assert.equal(p.isFatal('unhandledRejection'), true, 'still fatal during the grace period');
});

test('after the grace period a rejection is not fatal, an uncaughtException is; counted', () => {
    const { p, fire } = manual();
    p.settleAfter(30000);
    fire();
    assert.equal(p.isSettled(), true);
    assert.equal(p.isFatal('unhandledRejection'), false);
    assert.equal(p.isFatal('uncaughtException'), true);
    p.noteNonFatal(new Error('forgotten catch'));
    p.noteNonFatal('sima string');
    assert.deepEqual(p.stats(), { count: 2, last: 'sima string' });
});
