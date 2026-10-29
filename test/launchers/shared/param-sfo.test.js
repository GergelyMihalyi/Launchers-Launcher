'use strict';

// lib/launchers/shared/param-sfo.js — the shared PS3/PSP/Vita PARAM.SFO parser (both the RPCS3 and
// the PPSSPP discovery call it; the launcher tests only check the wiring).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFakeParamSfo } = require('../../helpers/fixtures.js');
const { parseParamSfo } = require('../../../lib/launchers/shared/param-sfo.js');

test('parseParamSfo — string (0x0204) and int32 (0x0404) fields, with the PS3 keys seen on the machine', () => {
    const parsed = parseParamSfo(buildFakeParamSfo({
        APP_VER: '01.00', ATTRIBUTE: 0, CATEGORY: 'DG', TITLE: 'God of War® III', TITLE_ID: 'BCES00510',
    }));
    assert.equal(parsed.TITLE, 'God of War® III');
    assert.equal(parsed.TITLE_ID, 'BCES00510');
    assert.equal(parsed.CATEGORY, 'DG');
    assert.equal(parsed.ATTRIBUTE, 0);
});

test('parseParamSfo — PSP keys (DISC_ID + TITLE)', () => {
    const parsed = parseParamSfo(buildFakeParamSfo({ DISC_ID: 'ULES00789', TITLE: 'Dragon Ball Z Shin Budokai 2' }));
    assert.equal(parsed.DISC_ID, 'ULES00789');
    assert.equal(parsed.TITLE, 'Dragon Ball Z Shin Budokai 2');
});

test('parseParamSfo — bad magic / empty buffer -> empty object, does not throw', () => {
    assert.deepEqual(parseParamSfo(Buffer.from('not a psf file')), {});
    assert.deepEqual(parseParamSfo(Buffer.alloc(0)), {});
});

test('the launcher modules re-export the same function', () => {
    assert.equal(require('../../../lib/launchers/rpcs3-library.js').parseParamSfo, parseParamSfo);
    assert.equal(require('../../../lib/launchers/ppsspp-library.js').parseParamSfo, parseParamSfo);
});
