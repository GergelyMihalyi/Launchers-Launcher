// @ts-check
'use strict';

const { requireDeps } = require('./require-deps.js');

// Reads the system clipboard text for the on-screen keyboard's Ctrl+V. The main-side `clipboard` is deterministic
// (the renderer's `navigator.clipboard` is not, because of the file:// origin + permissions) — the module does not know Electron.

/** Even a huge clipboard must not burden the renderer (the keyboard cuts to `maxLength` anyway). */
const CLIPBOARD_MAX_CHARS = 4096;

/**
 * @param {Object} deps
 * @param {import('../types.js').IpcMainLike} deps.ipcMain
 * @param {{ readText: () => string | Promise<string> }} deps.clipboard
 * @param {import('../types.js').Logger} [deps.log]
 */
function registerClipboardIpc(deps) {
    const { ipcMain, clipboard, log } = deps;
    requireDeps(deps, ['ipcMain', 'clipboard'], 'registerClipboardIpc');
    ipcMain.handle('read-clipboard-text', async () => {
        try {
            // In Electron 44 `readText()` is a Promise (it follows the W3C API) — older/fake: a plain string.
            return { ok: true, text: String((await clipboard.readText()) || '').slice(0, CLIPBOARD_MAX_CHARS) };
        } catch (err) {
            if (log) /** @type {any} */ (log).warn(`[clipboard] read error: ${err && err.message}`);
            return { ok: false, text: '' };
        }
    });
}

module.exports = { registerClipboardIpc, CLIPBOARD_MAX_CHARS };
