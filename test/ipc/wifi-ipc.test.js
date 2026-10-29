'use strict';

// lib/ipc/wifi-ipc.js — Wi-Fi network picker.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeIpcMain, fakeLog } = require('../helpers/ipc.js');
const { registerWifiIpc } = require('../../lib/ipc/wifi-ipc.js');

test('wifi — list error → ok:false; unexpected connect error → failed, the password does not get into the log', async () => {
    const ipcMain = fakeIpcMain();
    const log = fakeLog();
    registerWifiIpc({
        ipcMain, log,
        wifi: /** @type {any} */ ({
            listNetworks: async () => { throw new Error('nmcli'); },
            connect: async () => { throw new Error('titok123'); },
            setRadio: async (on) => ({ ok: true, on }),
        }),
    });
    assert.deepEqual(await ipcMain.invoke('list-wifi', {}), { ok: false, device: true, radio: true, items: [] });
    assert.deepEqual(await ipcMain.invoke('connect-wifi', { ssid: 'Otthon', password: 'titok123' }),
        { ok: false, errorKey: 'failed', ssid: 'Otthon' });
    assert.ok(!log.lines.join('\n').includes('titok123'));
    assert.deepEqual(await ipcMain.invoke('set-wifi-radio', 1), { ok: true, on: true });
});

test('wifi — list-wifi: `rescan: true` → fresh scan, `cached: true` → the NetworkManager cache', async () => {
    const ipcMain = fakeIpcMain();
    const seen = [];
    registerWifiIpc({
        ipcMain, log: fakeLog(),
        wifi: /** @type {any} */ ({ listNetworks: async (o) => { seen.push(o.rescan); return { device: true, radio: true, items: [] }; } }),
    });
    await ipcMain.invoke('list-wifi', { rescan: true });
    await ipcMain.invoke('list-wifi', { cached: true });
    await ipcMain.invoke('list-wifi', {});
    assert.deepEqual(seen, [true, 'no', false]);
});
