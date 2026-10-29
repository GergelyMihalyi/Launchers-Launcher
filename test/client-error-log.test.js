'use strict';

// lib/client-error-log.js — the log-line shape of a renderer-side error. Pure function.

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatClientErrorLine } = require('../lib/client-error-log.js');

test('formatClientErrorLine — context + message, without stack', () => {
    assert.equal(
        formatClientErrorLine({ context: 'gamepad.js', message: 'something crashed' }),
        '[renderer] gamepad.js: something crashed',
    );
});

test('formatClientErrorLine — with stack: goes on a new line', () => {
    assert.equal(
        formatClientErrorLine({ context: 'x', message: 'y', stack: 'Error: y\n at foo' }),
        '[renderer] x: y\nError: y\n at foo',
    );
});

test('formatClientErrorLine — missing context/message -> "unknown"/"(no message)"', () => {
    assert.equal(formatClientErrorLine({}), '[renderer] unknown: (no message)');
    assert.equal(formatClientErrorLine(null), '[renderer] unknown: (no message)');
    assert.equal(formatClientErrorLine(undefined), '[renderer] unknown: (no message)');
});

test('formatClientErrorLine — non-object payload (string/number) -> "unknown"/"(no message)"', () => {
    assert.equal(formatClientErrorLine('plain string'), '[renderer] unknown: (no message)');
    assert.equal(formatClientErrorLine(42), '[renderer] unknown: (no message)');
});

test('formatClientErrorLine — fields coerced to string (e.g. number/object context)', () => {
    assert.equal(formatClientErrorLine({ context: 42, message: { toString: () => 'obj-msg' } }),
        '[renderer] 42: obj-msg');
});

test('formatClientErrorLine — length cap: every field truncated to maxField', () => {
    const long = 'x'.repeat(20);
    const out = formatClientErrorLine({ context: long, message: long, stack: long }, 5);
    assert.equal(out, `[renderer] ${'x'.repeat(5)}: ${'x'.repeat(5)}\n${'x'.repeat(5)}`);
});

test('formatClientErrorLine — default maxField 4000', () => {
    const long = 'x'.repeat(5000);
    const out = formatClientErrorLine({ context: 'c', message: long });
    assert.equal(out.length, '[renderer] c: '.length + 4000);
});
