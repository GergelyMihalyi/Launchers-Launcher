'use strict';

// lib/fs-atomic.js — atomic file write (mkdir + temp + rename)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers/fs.js');
const { writeFileAtomic } = require('../lib/fs-atomic.js');

test('writeFileAtomic — creates a missing parent folder, writes the content, no temp file remains', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a', 'b', 'x.txt');
    writeFileAtomic(file, 'hello\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.txt']);
});

test('writeFileAtomic — overwrite and Buffer content', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'y.bin');
    writeFileAtomic(file, 'old');
    writeFileAtomic(file, Buffer.from([1, 2, 3]));
    assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3]);
    assert.deepEqual(fs.readdirSync(dir), ['y.bin']);
});

test('writeFileAtomic — throws on a failed write, and leaves no temp file', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'dir-as-target');
    fs.mkdirSync(target); // a file cannot be renamed onto a FOLDER
    assert.throws(() => writeFileAtomic(target, 'x'));
    assert.deepEqual(fs.readdirSync(dir), ['dir-as-target']);
});

// `{ fsync: true }` → the temp file is forced to disk BEFORE the rename; no fsync by default.
test('writeFileAtomic — with the fsync option it fsyncs before the rename, without it it does not', () => {
    const dir = tmpDir();
    const calls = [];
    const origFsync = fs.fsyncSync;
    const origRename = fs.renameSync;
    fs.fsyncSync = (fd) => { calls.push('fsync'); return origFsync(fd); };
    fs.renameSync = (a, b) => { calls.push('rename'); return origRename(a, b); };
    try {
        writeFileAtomic(path.join(dir, 'a.json'), '{"x":1}\n', { fsync: true });
        writeFileAtomic(path.join(dir, 'b.bin'), Buffer.from([1, 2, 3]));
        writeFileAtomic(path.join(dir, 'c.txt'), '', { fsync: true });
    } finally {
        fs.fsyncSync = origFsync;
        fs.renameSync = origRename;
    }
    assert.deepEqual(calls, ['fsync', 'rename', 'rename', 'fsync', 'rename']);
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), '{"x":1}\n');
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'b.bin'))], [1, 2, 3]);
    assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), '');
});

test('writeFileAtomic — the mode option sets the file permissions (with and without fsync)', () => {
    const dir = tmpDir('atomic-mode-');
    const prev = process.umask(0o022);
    try {
        writeFileAtomic(path.join(dir, 'a'), 'x', { mode: 0o600 });
        writeFileAtomic(path.join(dir, 'b'), 'x', { mode: 0o600, fsync: true });
        for (const f of ['a', 'b']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
    } finally { process.umask(prev); }
});
