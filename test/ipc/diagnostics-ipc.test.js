'use strict';

// lib/ipc/diagnostics-ipc.js — Log + Diagnostics channels.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { tmpDir } = require('../helpers/fs.js');
const { fakeIpcMain, fakeLog } = require('../helpers/ipc.js');
const { registerDiagnosticsIpc } = require('../../lib/ipc/diagnostics-ipc.js');

async function safeList(label, fn) {
    try { return { ok: true, items: await fn() }; } catch { return { ok: false, items: [] }; }
}

function setup(over = {}) {
    const ipcMain = fakeIpcMain();
    const log = fakeLog();
    const dir = tmpDir('gl-diag-');
    const logFile = path.join(dir, 'launchers-launcher.log');
    const marks = [];
    const hostInstall = [];
    registerDiagnosticsIpc({
        ipcMain, log, safeList, logFile, extraLogs: [], exportHeader: 'GL test',
        startupTimeline: { mark: (n) => { marks.push(n); return true; }, list: () => [{ name: 'appReady', ms: 1 }] },
        appInfo: () => ({ version: '1.2.3', gpu: 'enabled' }),
        onHostInstall: (a) => hostInstall.push(a),
        selftest: { checkCommands: async () => [{ cmd: 'pactl', ok: true }] },
        ...over,
    });
    return { ipcMain, log, logFile, marks, hostInstall };
}

test('registers the expected channels', () => {
    const { ipcMain } = setup();
    assert.deepEqual(ipcMain.channels(), [
        'export-log', 'get-app-info', 'get-selftest', 'get-startup-timeline', 'install-host-packages',
        'log-client-error', 'read-log', 'startup-mark',
    ]);
});

test('read-log — no log → ok + empty; there is → leveled lines', async () => {
    const { ipcMain, logFile } = setup();
    assert.deepEqual(await ipcMain.invoke('read-log'), { ok: true, items: [] });
    fs.writeFileSync(logFile, '[t] indul\n[t] ERROR baj\n');
    const res = await ipcMain.invoke('read-log');
    assert.equal(res.ok, true);
    assert.deepEqual(res.items.map((i) => i.level), ['info', 'error']);
});

test('get-app-info — the Electron-dependent part + the format alert', () => {
    const info = setup().ipcMain.invoke('get-app-info');
    assert.equal(info.version, '1.2.3');
    assert.ok('formatDrift' in info);
});

test('startup-mark — launchersRendered logs the timeline', () => {
    const { ipcMain, marks, log } = setup();
    ipcMain.send('startup-mark', 'launchersRendered');
    assert.deepEqual(marks, ['launchersRendered']);
    assert.match(log.lines.join('\n'), /\[startup\]/);
});

test('log-client-error — logs as an ERROR line', () => {
    const { ipcMain, log } = setup();
    ipcMain.send('log-client-error', { context: 'x', message: 'y' });
    assert.match(log.lines[0], /^ERROR \[renderer\]/);
});

test('install-host-packages — the foreground guard pauses during the install; exception → install-failed', async () => {
    const ok = setup({ hostPackages: { installMissingCommands: async () => ({ ok: true }) } });
    assert.deepEqual(await ok.ipcMain.invoke('install-host-packages'), { ok: true });
    assert.deepEqual(ok.hostInstall, [true, false]);
    const bad = setup({ hostPackages: { installMissingCommands: async () => { throw new Error('boom'); } } });
    const res = await bad.ipcMain.invoke('install-host-packages');
    assert.equal(res.error, 'install-failed');
    assert.deepEqual(bad.hostInstall, [true, false]);
});
