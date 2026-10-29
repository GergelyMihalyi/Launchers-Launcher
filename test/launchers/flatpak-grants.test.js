'use strict';

// lib/launchers/flatpak-grants.js — registry of the flatpak permissions granted by the launcher + the narrow-folder gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlatpakGrants, isSafeGrantDir } = require('../../lib/launchers/flatpak-grants.js');

function setup({ failExec = false } = {}) {
    const store = {};
    const calls = [];
    const grants = createFlatpakGrants({
        config: { get: (k, d) => (k in store ? structuredClone(store[k]) : d), set: (k, v) => { store[k] = structuredClone(v); } },
        exec: async (file, args) => { calls.push([file, ...args]); if (failExec) throw new Error('boom'); },
        now: () => 123,
    });
    return { grants, store, calls };
}

test('isSafeGrantDir — needs a narrow, absolute, normalized folder; a system folder, :, a broad path is not accepted', () => {
    const home = '/home/u';
    assert.equal(isSafeGrantDir('/mnt/roms', home), '/mnt/roms');
    assert.equal(isSafeGrantDir('/run/media/u/NTFS/ROMs', home), '/run/media/u/NTFS/ROMs');
    for (const bad of ['/', '/mnt', '/media', '/etc/x', '/usr', '/proc/1', '/run', '/run/user/1000', home, 'relativ/ut', '/mnt/roms/', '/mnt/../etc', '/mnt/a:rw', '/mnt/a\nb', '', null, 5]) {
        assert.equal(isSafeGrantDir(bad, home), null, String(bad));
    }
});

test('grant — calls the flatpak override, records it in the registry, does not record twice', async () => {
    const { grants, store, calls } = setup();
    assert.deepEqual(await grants.grant('net.pcsx2.PCSX2', '/mnt/roms/ps2'), { ok: true });
    assert.deepEqual(calls, [['flatpak', 'override', '--user', '--filesystem=/mnt/roms/ps2', 'net.pcsx2.PCSX2']]);
    assert.deepEqual(store.flatpakGrants, [{ appId: 'net.pcsx2.PCSX2', path: '/mnt/roms/ps2', at: 123 }]);
    await grants.grant('net.pcsx2.PCSX2', '/mnt/roms/ps2');
    assert.equal(store.flatpakGrants.length, 1);
});

test('grant — an invalid app-id / dangerous folder does not call flatpak; an exec error does not book', async () => {
    const a = setup();
    assert.equal((await a.grants.grant('-rossz', '/mnt/roms')).ok, false);
    assert.equal((await a.grants.grant('net.pcsx2.PCSX2', '/etc')).ok, false);
    assert.deepEqual(a.calls, []);
    const b = setup({ failExec: true });
    const res = await b.grants.grant('net.pcsx2.PCSX2', '/mnt/roms');
    assert.equal(res.ok, false);
    assert.equal(b.store.flatpakGrants, undefined);
});

test('revoke — revokes only a recorded permission (--nofilesystem), does not touch the others', async () => {
    const { grants, store, calls } = setup();
    assert.equal((await grants.revoke('net.pcsx2.PCSX2', '/mnt/roms')).ok, false); // not granted by the launcher
    assert.deepEqual(calls, []);
    await grants.grant('net.pcsx2.PCSX2', '/mnt/roms');
    calls.length = 0;
    assert.deepEqual(await grants.revoke('net.pcsx2.PCSX2', '/mnt/roms'), { ok: true });
    assert.deepEqual(calls, [['flatpak', 'override', '--user', '--nofilesystem=/mnt/roms', 'net.pcsx2.PCSX2']]);
    assert.deepEqual(store.flatpakGrants, []);
});

test('adoptExisting — books only folders outside $HOME, without duplicates', () => {
    const { grants } = setup();
    grants.adoptExisting('net.kuribo64.melonDS', ['/home/u/roms', '/mnt/nds', '/mnt/nds'], '/home/u');
    assert.deepEqual(grants.list().map((g) => g.path), ['/mnt/nds']);
});
