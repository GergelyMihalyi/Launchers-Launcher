// @ts-check
'use strict';

// Guarded wrapper of Electron's `ipcMain` (`main.js` wraps it ONCE). An exception thrown in an `on` listener would be an
// `uncaughtException` (ALWAYS fatal in `bootstrap.js`), so: `on` → the throw is logged and swallowed; `handle` → logged, the error
// propagates (the `invoke` Promise rejects). The `handle` response is capped at `IPC_HANDLE_TIMEOUT_MS` (overridable per channel).
// Channel literals stay in place (ipc-channels contract test). Background: docs/dev/infrastructure.md#timeouts

const { withTimeout } = require('../exec.js');
const { IPC_HANDLE_TIMEOUT_MS, IPC_HANDLE_TIMEOUT_OVERRIDES } = require('../timings.js');

/**
 * @param {import('../types.js').IpcMainLike} ipcMain
 * @param {(msg: string) => void} log
 * @param {{ defaultTimeoutMs?: number, timeouts?: Record<string, number> }} [opts] overridable for tests
 * @returns {import('../types.js').IpcMainLike}
 */
function guardIpcMain(ipcMain, log, { defaultTimeoutMs = IPC_HANDLE_TIMEOUT_MS, timeouts = IPC_HANDLE_TIMEOUT_OVERRIDES } = {}) {
    const describe = (err) => (err && /** @type {any} */ (err).stack) || String(err);
    return {
        on(channel, fn) {
            return ipcMain.on(channel, (event, ...args) => {
                try {
                    const r = /** @type {any} */ (fn(event, ...args));
                    // a rejection of an async listener must not become an unhandled rejection either
                    if (r && typeof r.then === 'function') r.then(undefined, (err) => log(`[ipc] ${channel} error: ${describe(err)}`));
                } catch (err) {
                    log(`[ipc] ${channel} error (swallowed): ${describe(err)}`);
                }
            });
        },
        handle(channel, fn) {
            const ms = Object.prototype.hasOwnProperty.call(timeouts, channel) ? timeouts[channel] : defaultTimeoutMs;
            return ipcMain.handle(channel, async (event, ...args) => {
                try {
                    return await withTimeout(Promise.resolve().then(() => fn(event, ...args)), ms, `ipc ${channel}`);
                } catch (err) {
                    log(`[ipc] ${channel} error: ${describe(err)}`);
                    throw err;
                }
            });
        },
    };
}

module.exports = { guardIpcMain };
