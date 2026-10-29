'use strict';

// lib/ipc/system-power-ipc.js — system actions, sleep timer, quit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeIpcMain } = require('../helpers/ipc.js');
const { registerSystemPowerIpc } = require('../../lib/ipc/system-power-ipc.js');

test('system-power — action, sleep-timer push, quit', () => {
    const ipcMain = fakeIpcMain();
    const calls = [];
    const sent = [];
    registerSystemPowerIpc({
        ipcMain,
        systemPower: {
            dispatchSystemAction: (a) => calls.push(a),
            getSleepTimerState: () => ({ minutes: 0 }),
            setSleepTimer: (m) => ({ minutes: m }),
        },
        sendToRenderer: (ch, p) => sent.push([ch, p]),
        quit: () => calls.push('quit'),
    });
    ipcMain.send('system-action', 'reboot');
    ipcMain.send('set-sleep-timer', 30);
    ipcMain.send('quit-launcher');
    assert.deepEqual(calls, ['reboot', 'quit']);
    assert.deepEqual(sent, [['sleep-timer-changed', { minutes: 30 }]]);
    assert.deepEqual(ipcMain.invoke('get-sleep-timer'), { minutes: 0 });
});
