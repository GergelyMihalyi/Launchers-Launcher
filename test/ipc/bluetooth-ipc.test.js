'use strict';

// lib/ipc/bluetooth-ipc.js — BT device management + PS-combo pad.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeIpcMain, fakeLog } = require('../helpers/ipc.js');
const { registerBluetoothIpc } = require('../../lib/ipc/bluetooth-ipc.js');

test('bluetooth — list in safeList, connect → bt-device-changed, scan error → ok:false, combo-pad error → does not throw', async () => {
    const ipcMain = fakeIpcMain();
    const sent = [];
    registerBluetoothIpc({
        ipcMain, log: fakeLog(), sendToRenderer: (ch, p) => sent.push([ch, p]),
        safeList: async (label, fn) => ({ ok: true, items: await fn() }),
        evdevPads: { resolveComboPad: () => { throw new Error('no evdev'); } },
        bluetooth: /** @type {any} */ ({
            listBluetoothDevices: async (kind) => [{ kind }],
            performBtAction: async (kind, action, mac) => [{ mac, action }],
            performBtPair: async () => [],
            discoverDevices: async () => { throw new Error('busy'); },
            disconnectGamepads: async () => ['AA'],
        }),
    });
    assert.deepEqual(await ipcMain.invoke('list-bt-devices', 'audio'), { ok: true, items: [{ kind: 'audio' }] });
    await ipcMain.send('bt-connect', { kind: 'gamepad', mac: 'AA:BB:CC:DD:EE:FF' });
    await ipcMain.send('bt-connect', { kind: 'gamepad', mac: '--help' }); // invalid MAC → dropped
    await ipcMain.send('bt-connect'); // no throw even without a payload
    await ipcMain.send('bt-scan', { kind: 'gamepad' });
    assert.deepEqual(sent, [
        ['bt-device-changed', [{ mac: 'AA:BB:CC:DD:EE:FF', action: 'connect' }]],
        ['bt-scan-result', { kind: 'gamepad', ok: false, found: [] }],
    ]);
    assert.deepEqual(ipcMain.invoke('resolve-combo-pad'), { ok: false, matched: false, mac: null });
});
