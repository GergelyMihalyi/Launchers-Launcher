// @ts-check
'use strict';

// IPC of the Wi-Fi network picker.
// ⚠️ The `connect-wifi` payload carries the password: never log the payload here either — `lib/network/wifi.js` only
// writes the SSID + a redacted error.

const { createWifi } = require('../network/wifi.js');
const { requireDeps } = require('./require-deps.js');

/**
 * @param {Object} deps
 * @param {import('../types.js').IpcMainLike} deps.ipcMain
 * @param {(msg: string) => void} deps.log
 * @param {ReturnType<typeof createWifi>} [deps.wifi] overridable for tests
 */
function registerWifiIpc(deps) {
    const { ipcMain, log, wifi = createWifi({ log }) } = deps;
    requireDeps(deps, ['ipcMain', 'log'], 'registerWifiIpc');
    ipcMain.handle('list-wifi', async (event, opts) => {
        try {
            // `rescan: true` = a fresh scan, `cached: true` = NetworkManager's last result (instant), otherwise auto.
            const rescan = opts && opts.rescan === true ? true : opts && opts.cached === true ? 'no' : false;
            return { ok: true, ...(await wifi.listNetworks({ rescan })) };
        } catch (err) {
            log(`Wi-Fi list error: ${err.message}`);
            return { ok: false, device: true, radio: true, items: [] };
        }
    });
    ipcMain.handle('connect-wifi', async (event, payload) => {
        const { ssid, password, hidden } = payload || {};
        try {
            return await wifi.connect(ssid, password == null ? null : String(password), { hidden: hidden === true });
        } catch (_) {
            log(`Wi-Fi connect unexpected error (${typeof ssid === 'string' ? ssid : '?'})`);
            return { ok: false, errorKey: 'failed', ssid };
        }
    });
    ipcMain.handle('set-wifi-radio', (event, on) => wifi.setRadio(!!on));
    // Forget a saved network (delete its profiles).
    ipcMain.handle('forget-wifi', async (event, ssid) => {
        try {
            return await wifi.forget(ssid);
        } catch (_) {
            log('Wi-Fi forget unexpected error');
            return { ok: false, removed: 0 };
        }
    });
}

module.exports = { registerWifiIpc };
