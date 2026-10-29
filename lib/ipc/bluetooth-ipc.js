// @ts-check
'use strict';

// IPC of the Settings → Controllers BT device management + the PS-combo target. The actual `bluetoothctl` logic is
// `lib/bluetooth/bluetooth.js`, resolving the PS combo → MAC is the job of `lib/evdev-pads.js`.

const defaultBluetooth = require('../bluetooth/bluetooth.js');
const { requireDeps } = require('./require-deps.js');
const { str, macAddress, plainObject } = require('../validate.js');

/**
 * @param {Object} deps
 * @param {import('../types.js').IpcMainLike} deps.ipcMain
 * @param {((msg: string) => void) & { warn: (msg: string) => void }} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {(label: string, fn: () => Promise<any>) => Promise<{ ok: boolean, items: any[] }>} deps.safeList
 * @param {{ resolveComboPad: () => any }} deps.evdevPads
 * @param {typeof defaultBluetooth} [deps.bluetooth] overridable for tests
 */
function registerBluetoothIpc(deps) {
    const { ipcMain, log, sendToRenderer, safeList, evdevPads, bluetooth = defaultBluetooth } = deps;
    requireDeps(deps, ['ipcMain', 'log', 'sendToRenderer', 'safeList', 'evdevPads'], 'registerBluetoothIpc');
    ipcMain.handle('list-bt-devices', (event, kind) =>
        safeList(`BT device list error (${kind})`, () => bluetooth.listBluetoothDevices(str(kind, 32))));

    // PS-combo target: on which controller (MAC) PS is held NOW with a face button pressed alongside — from
    // kernel evdev events, since the Gamepad API gives no MAC.
    ipcMain.handle('resolve-combo-pad', () => {
        try {
            return evdevPads.resolveComboPad();
        } catch (err) {
            log(`resolve-combo-pad error: ${err.message}`);
            return { ok: false, matched: false, mac: null };
        }
    });

    // Taking over the `{ kind, mac }` payload: `mac` goes into a `bluetoothctl` argument (strict format), `kind` is a
    // short string (bluetooth.js whitelists the known kinds). Invalid → logged and dropped.
    /** @param {string} channel @param {unknown} payload */
    function takeBtTarget(channel, payload) {
        const p = plainObject(payload) ? payload : {};
        const kind = str(p.kind, 32);
        const mac = macAddress(p.mac);
        if (!kind || !mac) {
            log.warn(`${channel}: invalid payload dropped`);
            return null;
        }
        return { kind, mac };
    }

    ipcMain.on('bt-connect', async (event, payload) => {
        const t = takeBtTarget('bt-connect', payload);
        if (t) sendToRenderer('bt-device-changed', await bluetooth.performBtAction(t.kind, 'connect', t.mac, log));
    });
    ipcMain.on('bt-disconnect', async (event, payload) => {
        const t = takeBtTarget('bt-disconnect', payload);
        if (t) sendToRenderer('bt-device-changed', await bluetooth.performBtAction(t.kind, 'disconnect', t.mac, log));
    });

    // Idle controller disconnect: sent by the renderer after `idleDisconnect` minutes of idleness. Every connected
    // BT gamepad; wired pads are not affected.
    ipcMain.on('disconnect-idle-controllers', async () => {
        try {
            const macs = await bluetooth.disconnectGamepads();
            log(`Idle controller disconnect: ${macs.length ? macs.join(', ') : 'no connected BT controller'}`);
        } catch (err) {
            log.warn(`Idle controller disconnect error: ${err.message}`);
        }
    });

    // Device discovery + pairing from the UI.
    ipcMain.on('bt-scan', async (event, payload) => {
        const kind = str(plainObject(payload) ? payload.kind : null, 32);
        if (!kind) { log.warn('bt-scan: invalid payload dropped'); return; }
        let found = null;
        try {
            found = await bluetooth.discoverDevices(kind, log);
        } catch (err) {
            log(`bt-scan error (${kind}): ${err.message}`);
        }
        sendToRenderer('bt-scan-result', { kind, ok: found != null, found: found || [] });
    });
    ipcMain.on('bt-pair', async (event, payload) => {
        const t = takeBtTarget('bt-pair', payload);
        if (t) sendToRenderer('bt-device-changed', await bluetooth.performBtPair(t.kind, t.mac, log));
    });
}

module.exports = { registerBluetoothIpc };
