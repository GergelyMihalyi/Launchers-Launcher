'use strict';

// lib/output/displays-kde.js — the shared `LayoutPlan` → kscreen-doctor arguments (pure).

const test = require('node:test');
const assert = require('node:assert/strict');
const { kscreenArgs } = require('../../lib/output/displays-kde.js');

test('kscreenArgs — the order of the order is the priority, the disable is disabled', () => {
    assert.deepEqual(kscreenArgs({ order: ['HDMI-A-1', 'DP-3'], disable: ['DP-1'] }), [
        'output.HDMI-A-1.enable', 'output.HDMI-A-1.priority.1',
        'output.DP-3.enable', 'output.DP-3.priority.2',
        'output.DP-1.disable',
    ]);
});

test('kscreenArgs — empty disable: does not touch the others', () => {
    assert.deepEqual(kscreenArgs({ order: ['DP-3'], disable: [] }), ['output.DP-3.enable', 'output.DP-3.priority.1']);
});
