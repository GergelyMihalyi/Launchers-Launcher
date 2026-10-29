'use strict';

// lib/saves/save-backup.js — the save archive. It calls the real `tar`,
// with gzip (zstd is not on every machine).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir, writeFile } = require('../helpers/fs.js');
const {
    backupFileName, tarArgs, listSaveBackups, pruneSaveBackups, createSaveBackup, defaultSaveBackupDir,
    MANIFEST_NAME, BACKUP_NAME_RE, isBackupName, readBackupManifest, safeRestoreMembers, restoreArgs, restoreSaveBackup,
} = require('../../lib/saves/save-backup.js');

test('backupFileName — local time, sortable, extension per the compressor', () => {
    const d = new Date(2026, 8, 25, 14, 3, 12);
    assert.equal(backupFileName(d, 'zstd'), 'launchers-launcher-saves-2026-09-25_140312.tar.zst');
    assert.equal(backupFileName(d, 'gzip'), 'launchers-launcher-saves-2026-09-25_140312.tar.gz');
    assert.match(backupFileName(d, 'zstd'), BACKUP_NAME_RE);
    assert.equal(defaultSaveBackupDir('/h'), '/h/launchers-launcher-saves');
});

test('tarArgs — paths relative to /, the manifest from its own folder', () => {
    assert.deepEqual(
        tarArgs({ archivePath: '/b/x.tar.zst', compressor: 'zstd', paths: ['/home/a/saves', '/mnt/nds/x.sav'], manifestDir: '/tmp/m' }),
        ['-c', '--zstd', '-f', '/b/x.tar.zst', '-C', '/', 'home/a/saves', 'mnt/nds/x.sav', '-C', '/tmp/m', MANIFEST_NAME],
    );
    assert.equal(tarArgs({ archivePath: 'a', compressor: 'gzip', paths: ['/x'], manifestDir: '/m' })[1], '-z');
});

test('listSaveBackups / pruneSaveBackups — only its own archives, the newest first, N remain', async () => {
    const dir = tmpDir();
    for (const n of ['launchers-launcher-saves-2026-01-01_000000.tar.zst', 'launchers-launcher-saves-2026-03-01_000000.tar.gz',
        'launchers-launcher-saves-2026-02-01_000000.tar.zst', 'something.tar.zst', '.launchers-launcher-saves-2026-04-01_000000.tar.zst.partial']) {
        writeFile(dir, n, 'x');
    }
    const list = await listSaveBackups(dir);
    assert.deepEqual(list.map((b) => b.name.slice('launchers-launcher-saves-'.length, 'launchers-launcher-saves-'.length + 10)), ['2026-03-01', '2026-02-01', '2026-01-01']);
    assert.deepEqual(await pruneSaveBackups(dir, 2), ['launchers-launcher-saves-2026-01-01_000000.tar.zst']);
    assert.equal((await listSaveBackups(dir)).length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'something.tar.zst')), 'does not touch a foreign file');
    assert.deepEqual(await listSaveBackups(path.join(dir, 'missing')), []);
});

test('createSaveBackup — real tar (gzip): the files + the manifest, no .partial, the old one deleted', async () => {
    const src = tmpDir();
    writeFile(src, 'memcards/Mcd001.ps2', 'card');
    const sav = writeFile(src, 'nds/game.sav', 'sav');
    const dest = path.join(tmpDir(), 'backups');
    fs.mkdirSync(dest);
    writeFile(dest, 'launchers-launcher-saves-2020-01-01_000000.tar.gz', 'old');
    const res = await createSaveBackup({
        destDir: dest, compressor: 'gzip', keep: 1, version: '9.9.9', now: new Date(2026, 8, 25, 14, 3, 12),
        sources: [
            { id: 'pcsx2', name: 'PCSX2', paths: [{ path: path.join(src, 'memcards') }] },
            { id: 'melonds', name: 'melonDS', paths: [{ path: sav }] },
        ],
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.name, 'launchers-launcher-saves-2026-09-25_140312.tar.gz');
    assert.equal(res.sources, 2);
    assert.deepEqual(res.pruned, ['launchers-launcher-saves-2020-01-01_000000.tar.gz']);
    assert.deepEqual(fs.readdirSync(dest), [res.name]);
    const members = execFileSync('tar', ['-tzf', res.file], { encoding: 'utf8' }).trim().split('\n');
    const rel = (p) => p.replace(/^\//, '');
    assert.ok(members.includes(`${rel(path.join(src, 'memcards'))}/Mcd001.ps2`), members.join('\n'));
    assert.ok(members.includes(rel(sav)));
    assert.ok(members.includes(MANIFEST_NAME));
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', res.file, MANIFEST_NAME], { encoding: 'utf8' }));
    assert.equal(manifest.launcherVersion, '9.9.9');
    assert.equal(manifest.restore, `tar -xf ${res.name} -C /`);
    assert.deepEqual(manifest.sources.map((s) => s.id), ['pcsx2', 'melonds']);
});

test('createSaveBackup — tar failure: ok:false, the half-finished .partial deleted', async () => {
    const dest = tmpDir();
    const exec = async (cmd, args) => {
        fs.writeFileSync(args[args.indexOf('-f') + 1], 'half');
        throw Object.assign(new Error('tar: error'), { code: 2, stderr: 'tar: Cannot open: Permission denied\n' });
    };
    const res = await createSaveBackup({
        destDir: dest, compressor: 'gzip', exec, sources: [{ id: 'x', name: 'X', paths: [{ path: '/x' }] }],
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Permission denied/);
    assert.deepEqual(fs.readdirSync(dest), []);
});

test('createSaveBackup — exit code 1 of tar (file changed while reading) is NOT an error', async () => {
    const dest = tmpDir();
    const exec = async (cmd, args) => {
        fs.writeFileSync(args[args.indexOf('-f') + 1], 'archive');
        throw Object.assign(new Error('file changed as we read it'), { code: 1 });
    };
    const res = await createSaveBackup({
        destDir: dest, compressor: 'gzip', exec, sources: [{ id: 'x', name: 'X', paths: [{ path: '/x' }] }],
    });
    assert.equal(res.ok, true);
    assert.equal(res.bytes, 7);
});

test('createSaveBackup — no source: ok:false, does not call tar', async () => {
    let called = false;
    const res = await createSaveBackup({ destDir: tmpDir(), compressor: 'gzip', exec: async () => { called = true; }, sources: [] });
    assert.deepEqual(res, { ok: false, error: 'no-sources' });
    assert.equal(called, false);
});

test('isBackupName / safeRestoreMembers / restoreArgs — no path traversal, only a member under $HOME', () => {
    assert.equal(isBackupName('launchers-launcher-saves-2026-09-25_140312.tar.zst'), true);
    assert.equal(isBackupName('../launchers-launcher-saves-2026-09-25_140312.tar.zst'), false);
    assert.equal(isBackupName('x.tar.gz'), false);
    assert.deepEqual(safeRestoreMembers(['/home/u/a', '/etc/passwd', '/home/u/../x', 'rel/x', '/home/u/b/'], '/home/u'), ['home/u/a']);
    assert.deepEqual(restoreArgs({ file: 'f', members: ['home/u/a'] }), ['-xf', 'f', '--no-same-owner', '-C', '/', 'home/u/a']);
});

test('backup → modify → restore — one source or all, with a real tar (gzip)', async () => {
    const home = tmpDir('gl-restore-');
    writeFile(home, '.config/emuA/saves/a.sav', 'A-eredeti');
    writeFile(home, '.config/emuB/saves/b.sav', 'B-eredeti');
    const dest = tmpDir('gl-restore-dest-');
    const sources = [
        { id: 'emuA', name: 'EmuA', paths: [{ path: path.join(home, '.config/emuA/saves') }] },
        { id: 'emuB', name: 'EmuB', paths: [{ path: path.join(home, '.config/emuB/saves') }] },
    ];
    const made = await createSaveBackup({ destDir: dest, sources, compressor: 'gzip' });
    assert.equal(made.ok, true);
    const manifest = await readBackupManifest(made.file);
    assert.deepEqual(manifest.sources.map((x) => x.id), ['emuA', 'emuB']);

    fs.writeFileSync(path.join(home, '.config/emuA/saves/a.sav'), 'A-elromlott');
    fs.writeFileSync(path.join(home, '.config/emuB/saves/b.sav'), 'B-elromlott');
    const one = await restoreSaveBackup({ file: made.file, sourceId: 'emuA', manifest, home });
    assert.equal(one.ok, true);
    assert.equal(fs.readFileSync(path.join(home, '.config/emuA/saves/a.sav'), 'utf8'), 'A-eredeti');
    assert.equal(fs.readFileSync(path.join(home, '.config/emuB/saves/b.sav'), 'utf8'), 'B-elromlott'); // did not touch the other one

    const all = await restoreSaveBackup({ file: made.file, sourceId: 'all', manifest, home });
    assert.equal(all.ok, true);
    assert.equal(fs.readFileSync(path.join(home, '.config/emuB/saves/b.sav'), 'utf8'), 'B-eredeti');
    assert.equal(fs.existsSync(path.join(home, MANIFEST_NAME)), false); // the manifest is not written under /
    assert.equal((await restoreSaveBackup({ file: made.file, sourceId: 'missing', manifest, home })).ok, false);
});

test('restoreSaveBackup — a manifest path outside $HOME cannot be written back', async () => {
    const res = await restoreSaveBackup({
        file: '/missing.tar.gz', sourceId: 'all', home: '/home/u',
        manifest: { sources: [{ id: 'x', paths: ['/etc/evil', '/home/u/../etc'] }] },
        exec: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(res, { ok: false, error: 'no-safe-paths' });
});
