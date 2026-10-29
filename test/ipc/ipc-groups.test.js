'use strict';

// lib/ipc/ipc-groups.js — related IPC domains in one call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeIpcMain } = require('../helpers/ipc.js');
const { fakeDeps } = require('../helpers/launcher-list-deps.js');
const { registerLauncherListIpc } = require('../../lib/ipc/ipc-groups.js');

test('registerLauncherListIpc — the channels of manage AND variant, variant gets the adder of manage', () => {
    const ipcMain = fakeIpcMain();
    const deps = fakeDeps();
    const { manage, variants } = registerLauncherListIpc({ ...deps, ipcMain });
    for (const ch of ['get-launchers', 'add-launcher', 'remove-launcher', 'set-launcher-variant', 'set-launcher-path', 'find-launcher-executables']) {
        assert.ok(ipcMain.channels().includes(ch), ch);
    }
    assert.equal(typeof manage.saveLauncherEntry, 'function');
    assert.equal(typeof variants.repairLauncherVariants, 'function');
    assert.throws(() => registerLauncherListIpc({ ...deps, ipcMain: undefined }), /missing deps: ipcMain/);
});
