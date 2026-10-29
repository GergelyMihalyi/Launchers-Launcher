'use strict';

// The pure helpers of renderer/errors.js (the global error overlay + error log).
// The DOM/IPC part (overlay, button listener) is behind a `typeof window` guard and does not
// run under node — only the helpers are exported.

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeError, firstStackLines } = require('../renderer/errors.js');

test('summarizeError — Error instance: message + stack', () => {
    const err = new Error('boom');
    const s = summarizeError(err);
    assert.equal(s.message, 'boom');
    assert.ok(s.stack.includes('boom'));
});

test('summarizeError — string', () => {
    assert.deepEqual(summarizeError('something broke'), { message: 'something broke', stack: '' });
});

test('summarizeError — null/undefined does not throw, has a message', () => {
    assert.equal(summarizeError(null).message, '(unknown error)');
    assert.equal(summarizeError(undefined).message, '(unknown error)');
});

test('summarizeError — unpacking a PromiseRejectionEvent-like {reason}', () => {
    assert.equal(summarizeError({ reason: new Error('rejected') }).message, 'rejected');
    assert.equal(summarizeError({ reason: 'string ok' }).message, 'string ok');
});

test('summarizeError — ErrorEvent-like {message, filename, lineno, colno} without error', () => {
    const s = summarizeError({ message: 'ReferenceError: x is not defined', filename: 'renderer/foo.js', lineno: 12, colno: 3 });
    assert.ok(s.message.startsWith('ReferenceError: x is not defined'));
    assert.ok(s.message.includes('renderer/foo.js:12:3'));
});

test('summarizeError — an ErrorEvent .error Error is unpacked to the real error', () => {
    const real = new Error('the real one');
    const s = summarizeError({ message: 'Uncaught Error', filename: 'x.js', lineno: 1, colno: 1, error: real });
    assert.equal(s.message, 'the real one');
    assert.ok(s.stack.includes('the real one'));
});

test('summarizeError — plain object as JSON', () => {
    assert.equal(summarizeError({ a: 1 }).message, '{"a":1}');
});

test('firstStackLines — empty/null -> []', () => {
    assert.deepEqual(firstStackLines(''), []);
    assert.deepEqual(firstStackLines(null), []);
    assert.deepEqual(firstStackLines(undefined), []);
});

test('firstStackLines — trims, skips an empty line, cuts to n', () => {
    const stack = 'Error: boom\n    at a (foo.js:1:1)\n\n    at b (bar.js:2:2)\n    at c (baz.js:3:3)';
    assert.deepEqual(firstStackLines(stack, 3), ['Error: boom', 'at a (foo.js:1:1)', 'at b (bar.js:2:2)']);
});

test('firstStackLines — filters out the node:internal frame noise', () => {
    const stack = 'Error: x\n    at real (app.js:1:1)\n    at process (node:internal/process/task_queues:95:5)';
    assert.deepEqual(firstStackLines(stack, 5), ['Error: x', 'at real (app.js:1:1)']);
});
