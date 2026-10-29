'use strict';

// lib/launchers/shared/png-encode.js — the hand-written 8-bit RGBA PNG encoder (the shared core of
// the Cemu TGA->PNG and the melonDS NDS icon->PNG covers).

const test = require('node:test');
const assert = require('node:assert/strict');
const { inflatePngPixels } = require('../../helpers/fixtures.js');
const { encodePng } = require('../../../lib/launchers/shared/png-encode.js');

// 2×2: red, green / blue, half-transparent white.
const SAMPLE_2X2 = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 128,
]);

test('encodePng — PNG signature + IHDR (size, 8-bit RGBA)', () => {
    const png = encodePng(2, 2, SAMPLE_2X2);
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), 2); // width
    assert.equal(png.readUInt32BE(20), 2); // height
    assert.equal(png[24], 8); // bit depth
    assert.equal(png[25], 6); // color type: RGBA
});

test('encodePng — the IDAT decoded back to pixels is exactly the input', () => {
    assert.deepEqual(inflatePngPixels(encodePng(2, 2, SAMPLE_2X2), 2, 2), SAMPLE_2X2);
});

test('the launcher modules re-export the same function', () => {
    assert.equal(require('../../../lib/launchers/cemu-library.js').encodePng, encodePng);
    assert.equal(require('../../../lib/launchers/melonds-library.js').encodePng, encodePng);
});
