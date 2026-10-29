'use strict';

// lib/launchers/shared/zip-reader.js — the shared, minimal zip reader.
// Synthetic zip fixture: `buildFakeZip` in test/helpers/fixtures.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('../../helpers/fs.js');
const { buildFakeZip } = require('../../helpers/fixtures.js');
const {
    findEndOfCentralDirectory, parseCentralDirectory, extractZipEntry, listZipEntriesFromFile, readZipEntryPrefixes,
    ZIP_PREFIX_SIZES,
} = require('../../../lib/launchers/shared/zip-reader.js');

const romA = Buffer.from('plain content, uncompressed');
const romB = Buffer.alloc(2000, 7); // well-compressible, repetitive content
const twoEntries = () => buildFakeZip([
    { name: 'a.nds', data: romA, method: 0 },
    { name: 'b.nds', data: romB, method: 8 },
]);

test('findEndOfCentralDirectory / parseCentralDirectory — one stored + one deflate entry', () => {
    const zip = twoEntries();
    const eocd = findEndOfCentralDirectory(zip);
    assert.equal(eocd.cdEntries, 2);
    const entries = parseCentralDirectory(zip, eocd);
    assert.deepEqual(entries.map((e) => [e.name, e.method, e.uncompressedSize]), [['a.nds', 0, romA.length], ['b.nds', 8, 2000]]);
});

test('findEndOfCentralDirectory — non-zip / too short buffer -> null', () => {
    assert.equal(findEndOfCentralDirectory(Buffer.from('not a zip')), null);
    assert.equal(findEndOfCentralDirectory(Buffer.alloc(5)), null);
});

test('extractZipEntry — returns the original content byte-identically for both a stored AND a deflate entry', () => {
    const zip = twoEntries();
    const entries = parseCentralDirectory(zip, findEndOfCentralDirectory(zip));
    assert.ok(Buffer.compare(extractZipEntry(zip, entries[0]), romA) === 0);
    assert.ok(Buffer.compare(extractZipEntry(zip, entries[1]), romB) === 0);
});

test('listZipEntriesFromFile — gives the same as the buffer-based parse (positioned); nonexistent / non-zip → []', () => {
    const dir = tmpDir('gl-zip-reader-');
    const zip = twoEntries();
    const zipPath = path.join(dir, 'x.zip');
    fs.writeFileSync(zipPath, zip);
    const fromBuf = parseCentralDirectory(zip, findEndOfCentralDirectory(zip));
    assert.deepEqual(listZipEntriesFromFile(zipPath), fromBuf);
    assert.deepEqual(listZipEntriesFromFile(path.join(dir, 'missing.zip')), []);
    fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
    assert.deepEqual(listZipEntriesFromFile(path.join(dir, 'bad.zip')), []);
});

test('readZipEntryPrefixes — growing prefix, a `true` from the callback stops it; the deflate prefix is the start of the original', () => {
    const dir = tmpDir('gl-zip-reader-');
    const big = Buffer.concat([Buffer.from('HEADER'), require('crypto').randomBytes(ZIP_PREFIX_SIZES[1] + 1000)]);
    const zipPath = path.join(dir, 'big.zip');
    fs.writeFileSync(zipPath, buildFakeZip([{ name: 'big.bin', data: big, method: 8 }]));
    const [entry] = listZipEntriesFromFile(zipPath);

    const sizes = [];
    readZipEntryPrefixes(zipPath, entry, (decoded) => {
        sizes.push(decoded.length);
        assert.equal(decoded.subarray(0, 6).toString(), 'HEADER');
        return false; // always ask for more → grows to the end of the entry
    });
    assert.ok(sizes.length >= 2 && sizes[sizes.length - 1] > sizes[0], `did not grow: ${sizes}`);

    const once = [];
    readZipEntryPrefixes(zipPath, entry, (decoded) => { once.push(decoded.length); return true; });
    assert.equal(once.length, 1, 'stops after the first `true`');
    // unknown compression method / nonexistent file: no call, no throw
    const none = [];
    readZipEntryPrefixes(zipPath, { ...entry, method: 12 }, () => none.push(1));
    readZipEntryPrefixes(path.join(dir, 'missing.zip'), entry, () => none.push(1));
    assert.deepEqual(none, []);
});
