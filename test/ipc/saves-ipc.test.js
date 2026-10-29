'use strict';

// lib/ipc/saves-ipc.js — the handlers of "Save backups", with fake deps.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('../helpers/fs.js');
const { createSavesHandlers } = require('../../lib/ipc/saves-ipc.js');

function fakes({ dir = null, auto = null, backups = [{ name: 'n', path: '/b/n', bytes: 3, mtimeMs: 1 }], gameActive = false, createResult = { ok: true, file: '/b/x.tar.zst', bytes: 10, sources: 1 } } = {}) {
    const store = { saveBackup: { ...(dir ? { dir } : {}), ...(auto ? { auto } : {}) } };
    const sent = [];
    const calls = { create: [], restore: [] };
    let release;
    const gate = new Promise((r) => { release = r; });
    const handlers = createSavesHandlers({
        config: { get: (k, d) => (k in store ? store[k] : d), patch: (k, p) => { store[k] = { ...store[k], ...p }; } },
        log: () => { },
        isGameActive: () => gameActive,
        sendToRenderer: (ch, data) => sent.push([ch, data]),
        saveSources: { detectSaveSources: async () => [{ id: 'pcsx2', name: 'PCSX2', bytes: 8, paths: [{ path: '/p', bytes: 8 }] }] },
        saveBackup: {
            SAVE_BACKUP_KEEP: 5,
            defaultSaveBackupDir: () => '/home/x/launchers-launcher-saves',
            listSaveBackups: async () => backups,
            isBackupName: (n) => /^launchers-launcher-saves-/.test(n),
            readBackupManifest: async () => ({ createdAt: 'x', sources: [{ id: 'pcsx2', name: 'PCSX2', paths: ['/p'] }] }),
            restoreSaveBackup: async (o) => { calls.restore.push(o); return { ok: true, restored: 1 }; },
            detectCompressor: async () => 'zstd',
            createSaveBackup: async (o) => { calls.create.push(o); await gate; return createResult; },
        },
    });
    return { handlers, store, sent, calls, release };
}

test('getSaveBackupState — default target folder, sources, earlier backups (without the path)', async () => {
    const { handlers } = fakes();
    const st = await handlers.getSaveBackupState();
    assert.equal(st.ok, true);
    assert.equal(st.dir, '/home/x/launchers-launcher-saves');
    assert.equal(st.isDefaultDir, true);
    assert.equal(st.sources[0].id, 'pcsx2');
    assert.deepEqual(st.backups, [{ name: 'n', bytes: 3, mtimeMs: 1 }]);
    assert.equal(st.compressor, 'zstd');
});

test('setSaveBackupDir — only an existing, absolute folder; writes to the config', async () => {
    const { handlers, store } = fakes();
    assert.deepEqual(await handlers.setSaveBackupDir('relative/dir'), { ok: false });
    assert.deepEqual(await handlers.setSaveBackupDir('/no/such/dir'), { ok: false });
    assert.deepEqual(await handlers.setSaveBackupDir(42), { ok: false });
    const dir = tmpDir();
    assert.deepEqual(await handlers.setSaveBackupDir(dir), { ok: true, dir });
    assert.equal(store.saveBackup.dir, dir);
    assert.equal((await handlers.getSaveBackupState()).isDefaultDir, false);
});

test('runSaveBackup — one at a time; at the end a save-backup-done push, to the configured target', async () => {
    const { handlers, sent, calls, release } = fakes({ dir: '/mnt/usb' });
    const first = handlers.runSaveBackup();
    assert.equal(handlers.isRunning(), true);
    await handlers.runSaveBackup(); // meanwhile: no-op
    release();
    await first;
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].destDir, '/mnt/usb');
    assert.equal(calls.create[0].compressor, 'zstd');
    assert.deepEqual(sent, [['save-backup-done', { ok: true, file: '/b/x.tar.zst', bytes: 10, sources: 1 }]]);
    assert.equal(handlers.isRunning(), false);
});

test('setSaveBackupAuto — only a known mode; the state shows it', async () => {
    const { handlers, store } = fakes();
    assert.deepEqual(handlers.setSaveBackupAuto('hetente'), { ok: false });
    assert.deepEqual(handlers.setSaveBackupAuto('daily'), { ok: true, auto: 'daily' });
    assert.equal(store.saveBackup.auto, 'daily');
    assert.equal((await handlers.getSaveBackupState()).auto, 'daily');
});

test('autoBackup — does not run when disabled / fresh backup / game running; on due, an auto:true push', async () => {
    const off = fakes({ auto: 'off', backups: [] });
    off.release();
    await off.handlers.autoBackup('afterGame');
    assert.equal(off.calls.create.length, 0);

    const fresh = fakes({ auto: 'afterGame', backups: [{ name: 'n', path: '/b/n', bytes: 3, mtimeMs: Date.now() - 60 * 1000 }] });
    fresh.release();
    await fresh.handlers.autoBackup('afterGame');
    assert.equal(fresh.calls.create.length, 0); // the latest is 1 minute old < 1 hour

    const busyGame = fakes({ auto: 'afterGame', backups: [], gameActive: true });
    busyGame.release();
    await busyGame.handlers.autoBackup('afterGame');
    assert.equal(busyGame.calls.create.length, 0);

    const due = fakes({ auto: 'afterGame', backups: [{ name: 'n', path: '/b/n', bytes: 3, mtimeMs: 1 }] });
    due.release();
    await due.handlers.autoBackup('afterGame');
    assert.equal(due.calls.create.length, 1);
    assert.equal(due.sent[0][0], 'save-backup-done');
    assert.equal(due.sent[0][1].auto, true);
});

test('autoBackup — in "afterGame" mode the startup attempt does not count; in "daily" it does', async () => {
    const a = fakes({ auto: 'afterGame', backups: [] });
    a.release();
    await a.handlers.autoBackup('startup');
    assert.equal(a.calls.create.length, 0);
    const d = fakes({ auto: 'daily', backups: [] });
    d.release();
    await d.handlers.autoBackup('startup');
    assert.equal(d.calls.create.length, 1);
});

test('restoreSaveBackup — safety backup first, then the restore; save-restore-done push', async () => {
    const { handlers, sent, calls, release } = fakes();
    release();
    await handlers.restoreSaveBackup({ name: 'launchers-launcher-saves-2026-01-01_000000.tar.gz', sourceId: 'pcsx2' });
    assert.equal(calls.create.length, 1); // safety backup of the current state
    assert.equal(calls.create[0].keep, Number.MAX_SAFE_INTEGER); // does not prune the old ones
    assert.equal(calls.restore.length, 1);
    assert.equal(calls.restore[0].sourceId, 'pcsx2');
    assert.equal(sent.at(-1)[0], 'save-restore-done');
    assert.equal(sent.at(-1)[1].ok, true);
    assert.equal(handlers.isRunning(), false);
});

test('restoreSaveBackup — invalid name / running game / failed safety backup → does not write back', async () => {
    const bad = fakes();
    bad.release();
    await bad.handlers.restoreSaveBackup({ name: '../x', sourceId: 'all' });
    assert.equal(bad.calls.restore.length, 0);
    assert.equal(bad.sent.at(-1)[1].ok, false);

    const game = fakes({ gameActive: true });
    game.release();
    await game.handlers.restoreSaveBackup({ name: 'launchers-launcher-saves-2026-01-01_000000.tar.gz', sourceId: 'all' });
    assert.equal(game.sent.at(-1)[1].error, 'game-running');
    assert.equal(game.calls.create.length, 0);

    const failSafety = fakes({ createResult: { ok: false, error: 'tele a lemez' } });
    failSafety.release();
    await failSafety.handlers.restoreSaveBackup({ name: 'launchers-launcher-saves-2026-01-01_000000.tar.gz', sourceId: 'all' });
    assert.equal(failSafety.calls.restore.length, 0); // no overwrite without a safety backup
    assert.equal(failSafety.sent.at(-1)[1].ok, false);
});

test('getSaveBackupContents — only a valid archive name; the sources id+name', async () => {
    const { handlers } = fakes();
    assert.equal((await handlers.getSaveBackupContents('../x')).ok, false);
    const c = await handlers.getSaveBackupContents('launchers-launcher-saves-2026-01-01_000000.tar.gz');
    assert.deepEqual(c, { ok: true, createdAt: 'x', sources: [{ id: 'pcsx2', name: 'PCSX2' }] });
});
