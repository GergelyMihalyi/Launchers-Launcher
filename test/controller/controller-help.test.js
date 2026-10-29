'use strict';

// renderer/controller/controller-help.js — the button-mapping help table. The i18n keys of the
// labels are checked by test/contracts/i18n-keys.test.js (literals).

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONTROLS_HELP } = require('../../renderer/controller/controller-help.js');

// The known actions of `btnIcon()` (renderer/controller/controller-labels.js).
const ACTIONS = ['confirm', 'back', 'menu', 'alt', 'home', 'view', 'start'];

test('CONTROLS_HELP — three sections, every row has a button + a label', () => {
    assert.deepEqual(CONTROLS_HELP.map((s) => s.titleKey), ['help.home', 'help.combos', 'help.games']);
    for (const sec of CONTROLS_HELP) {
        assert.ok(sec.rows.length >= 3, sec.titleKey);
        for (const r of sec.rows) {
            assert.match(r.textKey, /^help\.\w+$/);
            if (r.label) assert.equal(typeof r.label, 'string');
            else for (const k of r.keys) assert.ok(ACTIONS.includes(k), `unknown button action: ${k}`);
        }
    }
});

test('CONTROLS_HELP — the PS combos all start with the PS (home) button', () => {
    const combos = CONTROLS_HELP.find((s) => s.titleKey === 'help.combos');
    for (const r of combos.rows) assert.equal(r.keys[0], 'home');
});
