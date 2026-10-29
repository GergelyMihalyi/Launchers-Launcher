'use strict';

// lib/ipc/prefs-ipc.js — the language (registerPrefChannel) + the synchronous boot state.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempConfigHome } = require('../helpers/fs.js');
const { fakeIpcMain, fakeLog } = require('../helpers/ipc.js');

const { reset } = useTempConfigHome('gl-prefsipc-');
const prefs = require('../../lib/prefs.js');
const { registerPrefsIpc } = require('../../lib/ipc/prefs-ipc.js');

function setup(over = {}) {
    const ipcMain = fakeIpcMain();
    const sent = [];
    registerPrefsIpc({
        ipcMain, prefs, log: fakeLog(), sendToRenderer: (ch, p) => sent.push([ch, p]),
        mainController: { writeSidecar: () => {} }, autostart: { writeSidecar: () => {} },
        xdgAutostart: { writeAutostartEntry: () => {}, removeAutostartEntry: () => {} },
        repoRoot: '/repo', stopDoNotDisturb: () => {},
        getLauncherIcons: () => ['assets/icons/steam.svg'], safeModeReason: null,
        ...over,
    });
    return { ipcMain, sent };
}

test('set-language — valid language → language-changed ok; unknown → the prefs default (hu)', () => {
    reset();
    const { ipcMain, sent } = setup();
    ipcMain.send('set-language', 'en');
    assert.deepEqual(sent.pop(), ['language-changed', { ok: true, language: 'en' }]);
    assert.equal(ipcMain.invoke('get-language'), 'en');
    ipcMain.send('set-language', 'klingon');
    assert.deepEqual(sent.pop(), ['language-changed', { ok: true, language: prefs.getLanguage() }]);
    assert.equal(prefs.getLanguage(), 'hu');
});

test('get-boot-state — sync: theme, background map, launcher icons, safe mode', () => {
    reset();
    const state = setup({ safeModeReason: 'env' }).ipcMain.sendSync('get-boot-state');
    assert.equal(typeof state.theme, 'string');
    assert.deepEqual(state.launcherIcons, ['assets/icons/steam.svg']);
    assert.equal(state.safeMode, 'env');
});

test('get-boot-state — answers even on error (the renderer <head> script blocks on it)', () => {
    reset();
    const state = setup({ getLauncherIcons: () => { throw new Error('x'); } }).ipcMain.sendSync('get-boot-state');
    assert.deepEqual(state, { theme: 'neon', background: {}, launcherIcons: [], safeMode: null });
});
