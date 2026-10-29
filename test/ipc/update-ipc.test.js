'use strict';

// lib/ipc/update-ipc.js — update / config restore / "What's new".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { tmpDir } = require('../helpers/fs.js');
const { fakeIpcMain, fakeLog } = require('../helpers/ipc.js');
const { registerUpdateIpc } = require('../../lib/ipc/update-ipc.js');

function setup(configOver = {}) {
    const ipcMain = fakeIpcMain();
    const sent = [];
    const relaunched = [];
    const store = { pendingChangelog: null };
    const repoRoot = tmpDir('gl-upd-');
    registerUpdateIpc({
        ipcMain, log: fakeLog(), repoRoot,
        sendToRenderer: (ch, p) => sent.push([ch, p]),
        safeList: async (label, fn) => ({ ok: true, items: await fn() }),
        relaunch: (reason) => relaunched.push(reason),
        config: {
            get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; },
            listBackups: () => [{ name: 'config-2026-09-26.json' }],
            restoreBackup: (name) => (name === 'jo' ? { ok: true } : { ok: false, error: 'unknown-backup' }),
            ...configOver,
        },
    });
    return { ipcMain, sent, relaunched, store, repoRoot };
}

test('restore-config-backup — error → config-restore-failed, success → relaunch', () => {
    const { ipcMain, sent, relaunched } = setup();
    ipcMain.send('restore-config-backup', 'rossz');
    assert.deepEqual(sent, [['config-restore-failed', { message: 'unknown-backup' }]]);
    assert.deepEqual(relaunched, []);
    ipcMain.send('restore-config-backup', 'jo');
    assert.equal(relaunched.length, 1);
});

test('list-config-backups — in the safeList wrapper', async () => {
    assert.deepEqual(await setup().ipcMain.invoke('list-config-backups'), { ok: true, items: [{ name: 'config-2026-09-26.json' }] });
});

test('get-changelog — the latest section + the pending marker; dismiss deletes it', async () => {
    const { ipcMain, store, repoRoot } = setup();
    fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- new thing\n\n## 1.1.0\n\n- old\n');
    store.pendingChangelog = '1.2.0';
    const res = await ipcMain.invoke('get-changelog');
    assert.equal(res.pending, true);
    assert.match(res.heading, /1\.2\.0/);
    ipcMain.send('dismiss-changelog');
    assert.equal(store.pendingChangelog, '');
    assert.equal((await ipcMain.invoke('get-changelog')).pending, false);
});

test('get-changelog — missing CHANGELOG.md → empty section, does not throw', async () => {
    const res = await setup().ipcMain.invoke('get-changelog');
    assert.deepEqual(res, { pending: false, heading: '', lines: [] });
});

// --- Settings transfer (lib/config-transfer.js) ---

test('export-settings → list-settings-exports → import-settings — the portable keys go through, relaunch', async () => {
    const { withTempHome } = require('../helpers/fs.js');
    await withTempHome(async () => {
        const { ipcMain, store, relaunched, sent } = setup();
        store.language = 'en';
        store.volumeMax = 70;
        store.customLaunchers = [{ id: 'x', cmd: 'rm' }]; // machine-specific — not exported
        const ex = await ipcMain.invoke('export-settings');
        assert.equal(ex.ok, true);
        const list = await ipcMain.invoke('list-settings-exports');
        assert.deepEqual(list.items.map((f) => f.name), [ex.name]);
        const file = JSON.parse(fs.readFileSync(path.join(require('node:os').homedir(), ex.name), 'utf8'));
        assert.deepEqual(Object.keys(file.settings).sort(), ['language', 'volumeMax']);

        store.language = 'hu';
        store.volumeMax = 100;
        ipcMain.send('import-settings', ex.name);
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(store.language, 'en');
        assert.equal(store.volumeMax, 70);
        assert.equal(relaunched.length, 1);
        assert.deepEqual(sent, []);
    });
});

test('import-settings — path traversal / unknown file / invalid content → settings-import-failed, no relaunch', async () => {
    const { withTempHome } = require('../helpers/fs.js');
    await withTempHome(async () => {
        const { ipcMain, relaunched, sent } = setup();
        fs.writeFileSync(path.join(require('node:os').homedir(), 'launchers-launcher-settings-2026-10-01.json'), '{"format":"masik"}');
        for (const bad of ['../x.json', 'launchers-launcher-settings-2026-10-02.json', 'launchers-launcher-settings-2026-10-01.json', 42]) {
            ipcMain.send('import-settings', bad);
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(relaunched.length, 0);
        assert.equal(sent.filter(([ch]) => ch === 'settings-import-failed').length, 4);
    });
});
