'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isoDirRecord } = require('../../helpers/fixtures.js');
const { SECTOR_SIZE, findDirEntry, readRootDirectory } = require('../../../lib/launchers/shared/iso9660.js');

test('findDirEntry — searches by name, ignoring the ";N" version suffix and case', () => {
    const dirBuf = Buffer.concat([
        isoDirRecord({ name: 'SYSTEM.CNF;1', lba: 100, size: 200 }),
        isoDirRecord({ name: 'PSP_GAME', lba: 300, size: 400, isDir: true }),
    ]);
    assert.deepEqual(findDirEntry(dirBuf, 'system.cnf;1'), { lba: 100, size: 200, isDir: false });
    assert.deepEqual(findDirEntry(dirBuf, 'PSP_GAME'), { lba: 300, size: 400, isDir: true });
    assert.equal(findDirEntry(dirBuf, 'NOPE'), null);
});

test('findDirEntry — null for a truncated/empty buffer, never throws', () => {
    assert.equal(findDirEntry(Buffer.alloc(0), 'X'), null);
    assert.equal(findDirEntry(Buffer.from([5, 1, 2]), 'X'), null);
});

test('readRootDirectory — PVD magic + root record -> gives the contents of the root directory', () => {
    const rootDirContent = isoDirRecord({ name: 'SYSTEM.CNF;1', lba: 50, size: 64 });
    const pvd = Buffer.alloc(SECTOR_SIZE);
    pvd.write('CD001', 1, 'ascii');
    const rootRecord = pvd.subarray(156, 156 + 34);
    rootRecord.writeUInt32LE(20, 2); // rootLba
    rootRecord.writeUInt32LE(rootDirContent.length, 10); // rootSize

    const reader = (offset, length) => {
        if (offset === 16 * SECTOR_SIZE && length === SECTOR_SIZE) return pvd;
        if (offset === 20 * SECTOR_SIZE && length === rootDirContent.length) return rootDirContent;
        return null;
    };

    const rootDir = readRootDirectory(reader);
    assert.deepEqual(findDirEntry(rootDir, 'SYSTEM.CNF;1'), { lba: 50, size: 64, isDir: false });
});

test('readRootDirectory — bad magic / failed read -> null, never throws', () => {
    assert.equal(readRootDirectory(() => null), null);
    assert.equal(readRootDirectory(() => Buffer.alloc(SECTOR_SIZE)), null); // no "CD001"
});
