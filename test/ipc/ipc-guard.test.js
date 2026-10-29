'use strict';

// lib/ipc/ipc-guard.js — a throwing `ipcMain.on` listener must not become a fatal uncaughtException.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeIpcMain } = require('../helpers/ipc.js');
const { guardIpcMain } = require('../../lib/ipc/ipc-guard.js');

test('on — a sync throw and an async rejection are logged, swallowed', async () => {
    const raw = fakeIpcMain();
    const logs = [];
    const ipc = guardIpcMain(raw, (m) => logs.push(m));
    ipc.on('boom', () => { throw new TypeError('bad payload'); });
    ipc.on('async-boom', async () => { throw new Error('async error'); });
    ipc.on('ok', (event, p) => logs.push(`ok ${p}`));
    assert.doesNotThrow(() => raw.send('boom', {}));
    raw.send('async-boom');
    raw.send('ok', 7);
    await new Promise((r) => setImmediate(r));
    assert.match(logs.join('\n'), /\[ipc\] boom error \(swallowed\): TypeError: bad payload/);
    assert.match(logs.join('\n'), /\[ipc\] async-boom error: Error: async error/);
    assert.ok(logs.includes('ok 7'));
});

test('handle — the error is logged, and the invoke is rejected (the renderer .catch handles it)', async () => {
    const raw = fakeIpcMain();
    const logs = [];
    const ipc = guardIpcMain(raw, (m) => logs.push(m));
    ipc.handle('q', (event, x) => { if (x === 'bad') throw new Error('not good'); return x * 2; });
    assert.equal(await raw.invoke('q', 21), 42);
    await assert.rejects(raw.invoke('q', 'bad'), /not good/);
    assert.match(logs.join('\n'), /\[ipc\] q error/);
});

// A real handler with a malformed payload: because of the validated fields, an app-error, not an exception.
test('launch-retroarch-game — object `system`/`path`: app-error, no spawn, no throw', () => {
    const { createLaunchHandlers } = require('../../lib/ipc/launch-ipc.js');
    const sent = [];
    const spawned = [];
    const h = createLaunchHandlers({
        getLaunchers: () => [], spawnGame: (...a) => spawned.push(a), switchToRunning: () => {},
        isLauncherRunning: async () => ({ running: false, pid: null }), corePathForSystem: () => { throw new Error('must not be called'); },
        isSteamRunning: () => false, log: () => {}, sendToRenderer: (ch, p) => sent.push(p), emulatorSources: {},
    });
    assert.doesNotThrow(() => h.launchRetroarchGame({ system: { evil: 1 }, path: ['x'] }));
    assert.equal(spawned.length, 0);
    assert.equal(sent[0].errorKey, 'err.retroMissingPath');
});

// A `handle` that never settles must not leave the renderer's `invoke` pending forever.
test('handle — upper limit: a stuck handler is rejected with a timeout; per-channel override', async () => {
    const raw = fakeIpcMain();
    const logs = [];
    const ipc = guardIpcMain(raw, (m) => logs.push(m), { defaultTimeoutMs: 20, timeouts: { slow: 5000 } });
    ipc.handle('stuck', () => new Promise(() => {}));
    ipc.handle('slow', () => new Promise((r) => setTimeout(() => r('done'), 40)));
    await assert.rejects(raw.invoke('stuck'), /ipc stuck timeout/);
    assert.equal(await raw.invoke('slow'), 'done', 'the overridden channel may wait longer');
    assert.match(logs.join('\n'), /\[ipc\] stuck error/);
});

test('IPC_HANDLE_TIMEOUT_OVERRIDES — every key is an existing ipcMain.handle channel (against renames)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { IPC_HANDLE_TIMEOUT_OVERRIDES, IPC_HANDLE_TIMEOUT_MS } = require('../../lib/timings.js');
    const dir = path.join(__dirname, '..', '..', 'lib', 'ipc');
    const src = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const [ch, ms] of Object.entries(IPC_HANDLE_TIMEOUT_OVERRIDES)) {
        assert.ok(src.includes(`ipcMain.handle('${ch}'`), `no such handle channel: ${ch}`);
        assert.ok(ms > IPC_HANDLE_TIMEOUT_MS, `${ch}: the override must be above the default`);
    }
});
