'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    setFormatDriftLogger, checkParsed, getFormatDrift, resetFormatDrift,
} = require('../../lib/host-deps/format-drift.js');

test('checkParsed — empty output or found items: not suspicious', () => {
    resetFormatDrift();
    assert.equal(checkParsed('p', '', 0), false);
    assert.equal(checkParsed('p', '  \n', 0), false);
    assert.equal(checkParsed('p', 'Sink #1', 1), false);
    assert.deepEqual(getFormatDrift(), []);
});

test('checkParsed — non-empty output, 0 items: logs once, appears in the list', () => {
    resetFormatDrift();
    const warns = [];
    setFormatDriftLogger((m) => warns.push(m));
    assert.equal(checkParsed('pactl-sinks', 'Senkó #1\n\tNév: x', 0), true);
    assert.equal(checkParsed('pactl-sinks', 'Senkó #1\n\tNév: x', 0), true);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /\[format\] pactl-sinks/);
    assert.deepEqual(getFormatDrift().map((d) => d.probe), ['pactl-sinks']);
    setFormatDriftLogger(null);
});

test('checkParsed — emptyIsNormal: a legitimately empty result does not alert', () => {
    resetFormatDrift();
    assert.equal(checkParsed('kscreen-doctor', '{"outputs":[]}', 0, { emptyIsNormal: () => true }), false);
    assert.deepEqual(getFormatDrift(), []);
});
