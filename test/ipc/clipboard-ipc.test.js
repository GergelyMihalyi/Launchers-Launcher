'use strict';

// lib/ipc/clipboard-ipc.js — clipboard read for the on-screen keyboard's Ctrl+V.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeIpcMain, fakeLog } = require('../helpers/ipc.js');
const { registerClipboardIpc, CLIPBOARD_MAX_CHARS } = require('../../lib/ipc/clipboard-ipc.js');

test('clipboard — text returned, with a length limit (the Promise-based readText too)', async () => {
    const ipcMain = fakeIpcMain();
    registerClipboardIpc({ ipcMain, clipboard: { readText: () => Promise.resolve('x'.repeat(CLIPBOARD_MAX_CHARS + 10)) } });
    const res = await ipcMain.invoke('read-clipboard-text');
    assert.equal(res.ok, true);
    assert.equal(res.text.length, CLIPBOARD_MAX_CHARS);
});

test('clipboard — on a throw { ok: false } + a warning', async () => {
    const ipcMain = fakeIpcMain();
    const log = fakeLog();
    registerClipboardIpc({ ipcMain, clipboard: { readText: () => { throw new Error('boom'); } }, log });
    assert.deepEqual(await ipcMain.invoke('read-clipboard-text'), { ok: false, text: '' });
});
