'use strict';

// lib/ipc/game-sources-ipc.js — game source settings (custom ROM source, melonDS folders) + the
// folder browser. The custom source together with its list: test/ipc/games-ipc.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeIpcMain } = require('../helpers/ipc.js');
const { registerGameSourcesIpc } = require('../../lib/ipc/game-sources-ipc.js');

function fakeRomDirScan(dirsById = {}) {
    const calls = [];
    const fn = async (id, ...args) => { calls.push([id, ...args]); return dirsById[id] || []; };
    fn.invalidate = () => { calls.push('invalidate'); };
    fn.calls = calls;
    return fn;
}

function registered(extra = {}) {
    const ipcMain = fakeIpcMain();
    const store = {};
    const sent = [];
    const synced = [];
    const h = registerGameSourcesIpc({
        ipcMain,
        config: { get: (k, d) => (k in store ? structuredClone(store[k]) : d), set: (k, v) => { store[k] = structuredClone(v); } },
        log: () => {},
        sendToRenderer: (ch, payload) => sent.push({ ch, payload }),
        emulatorSources: { melonds: { library: { syncFlatpakOverrides: async (prev, next) => { synced.push([prev, next]); } } } },
        invalidateGameSource: () => {},
        getLaunchers: () => [],
        workerScans: { romDirs: fakeRomDirScan() },
        ...extra,
    });
    return { ipcMain, h, store, sent, synced };
}

test('registerGameSourcesIpc — the source-settings + folder-browser channels', () => {
    assert.deepEqual(registered().ipcMain.channels().sort(), [
        'browse-dir', 'get-custom-game-sources', 'get-melonds-rom-dirs', 'get-rom-access', 'grant-rom-access',
        'list-rom-grants', 'revoke-rom-access', 'set-custom-game-source', 'set-melonds-rom-dirs',
    ]);
});

test('set-melonds-rom-dirs — filters, saves, flatpak override sync, push', () => {
    const { ipcMain, store, sent, synced } = registered();
    ipcMain.send('set-melonds-rom-dirs', ['/roms/nds', '', 5]);
    assert.deepEqual(store.melondsRomDirs, ['/roms/nds']);
    assert.deepEqual(synced, [[[], ['/roms/nds']]]);
    assert.deepEqual(sent, [{ ch: 'melonds-rom-dirs-changed', payload: { dirs: ['/roms/nds'], ok: true } }]);
    assert.deepEqual(ipcMain.invoke('get-melonds-rom-dirs'), ['/roms/nds']);
});

test('browse-dir — nonexistent folder → ok:false, does not throw', () => {
    const res = registered().ipcMain.invoke('browse-dir', '/no/such/dir-gl');
    assert.equal(res.ok, false);
    assert.equal(res.path, '/no/such/dir-gl');
});

test('get-rom-access — only flatpak-variant emulators with romDirArgs; a folder not seen is visible:false', async () => {
    const romDirs = fakeRomDirScan({ pcsx2: [{ dir: '/mnt/roms/ps2', real: '/mnt/roms/ps2' }] });
    const asked = [];
    const { ipcMain } = registered({
        workerScans: { romDirs },
        emulatorSources: {
            pcsx2: { label: 'PCSX2', romDirArgs: () => ['/cfg/pcsx2'] },
            dolphin: { label: 'Dolphin', romDirArgs: () => ['/cfg/dolphin'] },
        },
        getLaunchers: () => [
            { id: 'pcsx2', cmd: 'flatpak', args: ['run', 'net.pcsx2.PCSX2'] },
            { id: 'dolphin', cmd: '/usr/bin/dolphin-emu', args: [] }, // native: no sandbox
            { id: 'steam', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam'] }, // no romDirArgs
        ],
        readFlatpakFilesystems: async (appId) => { asked.push(appId); return ['home', 'xdg-run/gvfs']; },
    });
    const res = await ipcMain.invoke('get-rom-access', {});
    assert.equal(res.ok, true);
    assert.deepEqual(res.items, [{ source: 'pcsx2', name: 'PCSX2', appId: 'net.pcsx2.PCSX2', dir: '/mnt/roms/ps2', visible: false }]);
    assert.deepEqual(asked, ['net.pcsx2.PCSX2']);
    assert.deepEqual(romDirs.calls, [['pcsx2', '/cfg/pcsx2']]);
    await ipcMain.invoke('get-rom-access', {});
    assert.deepEqual(asked, ['net.pcsx2.PCSX2'], 'the second request from the cache');
    await ipcMain.invoke('get-rom-access', { refresh: true });
    assert.equal(asked.length, 2, 'refresh: queries again');
    assert.ok(romDirs.calls.includes('invalidate'), 'refresh: the worker-scan cache is cleared too');
});

test('get-rom-access — failed permission query (null): does not judge, no items', async () => {
    const { ipcMain } = registered({
        workerScans: { romDirs: fakeRomDirScan({ pcsx2: [{ dir: '/mnt/x', real: null }] }) },
        emulatorSources: { pcsx2: { label: 'PCSX2', romDirArgs: () => [] } },
        getLaunchers: () => [{ id: 'pcsx2', cmd: 'flatpak', args: ['run', 'net.pcsx2.PCSX2'] }],
        readFlatpakFilesystems: async () => null,
    });
    assert.deepEqual(await ipcMain.invoke('get-rom-access'), { ok: true, items: [] });
});

test('grant-rom-access — only for the (app, folder) pair reported as not seen by the fresh check; revoke only for a recorded one', async () => {
    const execCalls = [];
    const romDirs = fakeRomDirScan({ pcsx2: [{ dir: '/mnt/roms/ps2', real: '/mnt/roms/ps2' }] });
    const { ipcMain, store } = registered({
        workerScans: { romDirs },
        getLaunchers: () => [{ id: 'pcsx2', cmd: 'flatpak', args: ['run', 'net.pcsx2.PCSX2'] }],
        emulatorSources: {
            melonds: { library: { syncFlatpakOverrides: async () => {} } },
            pcsx2: { label: 'PCSX2', romDirArgs: () => [] },
        },
        readFlatpakFilesystems: async () => ['home'],
        exec: async (file, args) => { execCalls.push([file, ...args]); },
    });
    // unlisted folder → rejected, flatpak does not run
    const bad = await ipcMain.invoke('grant-rom-access', { appId: 'net.pcsx2.PCSX2', dir: '/mnt/mas' });
    assert.equal(bad.ok, false);
    assert.deepEqual(execCalls, []);
    // the folder not visible → granted + recorded
    const ok = await ipcMain.invoke('grant-rom-access', { appId: 'net.pcsx2.PCSX2', dir: '/mnt/roms/ps2' });
    assert.equal(ok.ok, true);
    assert.deepEqual(execCalls, [['flatpak', 'override', '--user', '--filesystem=/mnt/roms/ps2', 'net.pcsx2.PCSX2']]);
    assert.deepEqual((await ipcMain.invoke('list-rom-grants')).items.map((g) => g.path), ['/mnt/roms/ps2']);
    assert.equal(store.flatpakGrants.length, 1);
    // revoke
    assert.equal((await ipcMain.invoke('revoke-rom-access', { appId: 'net.pcsx2.PCSX2', dir: '/mnt/roms/ps2' })).ok, true);
    assert.equal((await ipcMain.invoke('revoke-rom-access', { appId: 'net.pcsx2.PCSX2', dir: '/mnt/roms/ps2' })).ok, false);
    assert.equal((await ipcMain.invoke('grant-rom-access', 'not-an-object')).ok, false);
});

test('set-melonds-rom-dirs — a folder outside $HOME is recorded in the registry, the removed one drops out', async () => {
    const { ipcMain, store } = registered({
        emulatorSources: { melonds: { library: { MELONDS_FLATPAK_ID: 'net.kuribo64.melonDS', syncFlatpakOverrides: async () => {} } } },
    });
    ipcMain.send('set-melonds-rom-dirs', ['/mnt/nds']);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(store.flatpakGrants.map((g) => g.path), ['/mnt/nds']);
    ipcMain.send('set-melonds-rom-dirs', []);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(store.flatpakGrants, []);
});
