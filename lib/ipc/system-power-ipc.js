// @ts-check
'use strict';

const { requireDeps } = require('./require-deps.js');

// System control + sleep timer + closing the launcher — IPC. The whitelist/state machine lives in `lib/system-power.js`;
// the renderer sends `system-action` AFTER a 2-step confirmation (double ✕).

/**
 * @param {Object} deps
 * @param {import('../types.js').IpcMainLike} deps.ipcMain
 * @param {ReturnType<typeof import('../system-power.js').createSystemPower>} deps.systemPower
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {() => void} deps.quit `app.quit()` — the module does not know Electron
 */
function registerSystemPowerIpc(deps) {
    const { ipcMain, systemPower, sendToRenderer, quit } = deps;
    requireDeps(deps, ['ipcMain', 'systemPower', 'sendToRenderer', 'quit'], 'registerSystemPowerIpc');
    ipcMain.on('system-action', (event, action) => systemPower.dispatchSystemAction(action));
    ipcMain.handle('get-sleep-timer', () => systemPower.getSleepTimerState());
    ipcMain.on('set-sleep-timer', (event, minutes) => {
        sendToRenderer('sleep-timer-changed', systemPower.setSleepTimer(minutes));
    });
    ipcMain.on('quit-launcher', () => quit());
}

module.exports = { registerSystemPowerIpc };
