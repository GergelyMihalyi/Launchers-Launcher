// @ts-check
'use strict';

// Bodies of the "TV mode / CEC" IPC handlers; `registerTvModeIpc({ ipcMain, … })` registers the channels next to them. The
// module does not know Electron's `app` — the caller passes the `app.quit()` needed at the end of `exit-tv-mode` as a `quit()`
// callback (the `getWindow()` pattern of `lib/launch/launch-controller.js`).

const { withTimeout } = require('../exec.js');
const { CEC_STANDBY_TIMEOUT_MS } = require('../timings.js');
const { requireDeps } = require('./require-deps.js');
const { arrayOf, flatpakAppId } = require('../validate.js');

/**
 * @param {Object} deps
 * @param {Object} deps.tvMode
 * @param {Object} deps.cec
 * @param {Object} deps.displays
 * @param {Object} deps.flatpak `lib/flatpak.js` (`listRunningFlatpakApps`)
 * @param {Object} deps.prefs
 * @param {Object} deps.tvModeEnter
 * @param {(msg: string) => void} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {() => void} deps.quit `app.quit()` — the module does not know Electron
 */
function createTvModeHandlers(deps) {
    const {
        tvMode, cec, displays, flatpak, prefs, tvModeEnter, log, sendToRenderer, quit,
    } = deps;
    requireDeps(deps, ['tvMode', 'cec', 'displays', 'flatpak', 'prefs', 'tvModeEnter', 'log', 'sendToRenderer', 'quit'], 'createTvModeHandlers');
    async function exitTvMode() {
        try {
            await tvMode.exitTvModeCleanup(log);
            // Optional TV standby (display.standbyOnExit) — AFTER the monitor/audio/gamepad restore, best effort.
            const cfg = displays.readDisplayConfig();
            if (cfg.standbyOnExit === true && await cec.cecAvailable()) {
                await withTimeout(cec.standbyTv(cfg.cecTarget), CEC_STANDBY_TIMEOUT_MS, 'cec-standby');
            }
        } catch (err) {
            log(`TV mode exit error: ${err.message}`);
        } finally {
            quit();
        }
    }

    async function tvVolume(direction) {
        try {
            if (!await cec.cecAvailable()) return;
            await cec.cecUserControl(
                direction === 'up' ? 'volume-up' : 'volume-down',
                displays.readDisplayConfig().cecTarget,
            );
        } catch (err) {
            log(`TV volume (CEC) error: ${err.message}`);
        }
    }

    async function tvMute() {
        try {
            if (!await cec.cecAvailable()) return;
            await cec.cecUserControl('mute', displays.readDisplayConfig().cecTarget);
        } catch (err) {
            log(`TV mute (CEC) error: ${err.message}`);
        }
    }

    // The TV control capabilities of this machine — the renderer hides the TV hint rows / no-ops based on it.
    // `ddc` is always false for now (the DDC/CI branch is deferred).
    async function getTvCapabilities() {
        return { cec: await cec.cecAvailable(), ddc: false };
    }

    // "TV mode: close" subview — the CURRENTLY running flatpak apps + the already selected `tvMode.closeFlatpak`
    // entries (the non-running ones too, so they can be removed).
    async function listTvModeApps() {
        const runningApps = await flatpak.listRunningFlatpakApps();
        const selected = prefs.getTvMode().closeFlatpak || [];
        return { running: runningApps, selected };
    }

    function setTvMode(patch) {
        try {
            const p = patch && typeof patch === 'object' ? patch : {};
            // The `closeFlatpak` items are flatpak app IDs: they go into the sidecar and from there into a `flatpak kill` argument.
            const next = prefs.setTvMode(Array.isArray(p.closeFlatpak) ? { closeFlatpak: arrayOf(p.closeFlatpak, flatpakAppId) } : {});
            tvModeEnter.writeSidecar(next); // ~/.local/share/launchers-launcher-tvmode for bin/tv-mode-enter.sh
            sendToRenderer('tv-mode-changed', { ...next, ok: true });
        } catch (err) {
            log(`TV mode save error: ${err.message}`);
            sendToRenderer('tv-mode-changed', { ...prefs.getTvMode(), ok: false });
        }
    }

    return {
        exitTvMode, tvVolume, tvMute, getTvCapabilities, listTvModeApps, setTvMode,
    };
}

/**
 * @param {Parameters<typeof createTvModeHandlers>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerTvModeIpc(deps) {
    const { ipcMain } = deps;
    requireDeps(deps, ['ipcMain'], 'registerTvModeIpc');
    const h = createTvModeHandlers(deps);
    ipcMain.on('exit-tv-mode', () => h.exitTvMode());
    ipcMain.on('tv-volume', (event, direction) => h.tvVolume(direction));
    ipcMain.on('tv-mute', () => h.tvMute());
    ipcMain.handle('get-tv-capabilities', () => h.getTvCapabilities());
    ipcMain.handle('list-tv-mode-apps', () => h.listTvModeApps());
    ipcMain.on('set-tv-mode', (event, patch) => h.setTvMode(patch));
    return h;
}

module.exports = { createTvModeHandlers, registerTvModeIpc };
