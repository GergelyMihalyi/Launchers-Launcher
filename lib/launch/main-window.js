// @ts-check
'use strict';

// Creating + hardening the kiosk window. The caller passes Electron's `BrowserWindow` — the module does not require electron (so it is
// testable). `test/contracts/window-hardening.test.js` guards the `webPreferences` and the wiring of the two guards at source level.

// The window background shows until the first paint (before the renderer CSS loads) — a neutral dark close to the `--bg` of the most
// common dark themes, so it does not flash.
const WINDOW_BG = '#0a0a0f';

/**
 * @param {string} preloadPath
 * @param {string} [iconPath] the window icon (PNG; the logo) — X11 uses it, Wayland takes the icon from the `.desktop` file
 */
function mainWindowOptions(preloadPath, iconPath) {
    return {
        fullscreen: true,
        frame: false,
        backgroundColor: WINDOW_BG,
        ...(iconPath ? { icon: iconPath } : {}),
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            // Also the Electron 20+ default — spelled out because the preload depends on it (it cannot `require` a local file, see the
            // "Preload and the sandbox" section of docs/dev/architecture.md).
            sandbox: true,
            // There is no text field (the on-screen keyboard has its own DOM); on Linux Chromium would download a spell-check dictionary
            // from the Google CDN.
            spellcheck: false,
        },
    };
}

/**
 * Navigation lock: the kiosk window never leaves its own `index.html` — an accidental `<a href>` / drag-and-drop / `window.open`
 * would otherwise navigate the whole window away, with no way back by controller. The renderer's own `location.reload()` is not
 * a `will-navigate`.
 * @param {any} contents `webContents`
 * @param {string} indexUrl the `file://` URL of `index.html`
 * @param {{ warn: (msg: string) => void }} log
 */
function guardNavigation(contents, indexUrl, log) {
    contents.setWindowOpenHandler(({ url }) => {
        log.warn(`navigation lock: window.open blocked (${url})`);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        if (url.split('#')[0] === indexUrl) return;
        event.preventDefault();
        log.warn(`navigation lock: will-navigate blocked (${url})`);
    });
}

/**
 * Renderer crash: without this a dying renderer (OOM, GPU driver) leaves an empty window while the main process lives. Reload; above
 * the `guard` limit `onGiveUp()` (the caller decides: relaunch in safe mode / quit).
 * @param {any} contents `webContents`
 * @param {{ guard: { record: () => string, count: () => number }, limit: number,
 *   log: ((msg: string) => void) & { warn: (msg: string) => void, error: (msg: string) => void },
 *   onGiveUp: () => void }} o
 */
function watchRendererCrashes(contents, { guard, limit, log, onGiveUp }) {
    contents.on('render-process-gone', (event, details) => {
        if (details.reason === 'clean-exit') return;
        const verdict = guard.record();
        log.error(`renderer crash: ${details.reason} (exit ${details.exitCode}) — ${guard.count()}/${limit}`);
        if (verdict === 'reload') {
            if (!contents.isDestroyed()) contents.reload();
            return;
        }
        onGiveUp();
    });
    contents.on('unresponsive', () => log.warn('the renderer is not responding'));
    contents.on('responsive', () => log('the renderer responds again'));
}

/**
 * Log line of the GPU (and other helper) process going away (on the `app` `child-process-gone`): Chromium falls back by itself, but it
 * should leave a trace in the log.
 * @param {{ type: string, reason: string, exitCode: number, name?: string }} details
 * @param {{ warn: (msg: string) => void, error: (msg: string) => void }} log
 */
function logChildProcessGone(details, log) {
    if (details.reason === 'clean-exit') return;
    const line = `${details.type} process gone: ${details.reason} (exit ${details.exitCode})${details.name ? ` [${details.name}]` : ''}`;
    if (details.type === 'GPU') log.error(line);
    else log.warn(line);
}

/**
 * The launcher window: created with the hardened options, navigation lock + crash guard, `index.html`.
 * @param {Object} deps
 * @param {new (opts: any) => any} deps.BrowserWindow
 * @param {string} deps.preloadPath
 * @param {string} [deps.iconPath] the window icon (PNG)
 * @param {string} deps.indexPath absolute path of `index.html`
 * @param {string} deps.indexUrl the same as a `file://` URL (for the navigation lock)
 * @param {Parameters<typeof watchRendererCrashes>[1]} deps.crash
 * @param {Parameters<typeof watchRendererCrashes>[1]['log']} deps.log
 */
function createMainWindow({ BrowserWindow, preloadPath, iconPath, indexPath, indexUrl, crash, log }) {
    const win = new BrowserWindow(mainWindowOptions(preloadPath, iconPath));
    guardNavigation(win.webContents, indexUrl, log);
    watchRendererCrashes(win.webContents, crash);
    win.loadFile(indexPath);
    return win;
}

module.exports = {
    WINDOW_BG, mainWindowOptions, guardNavigation, watchRendererCrashes, logChildProcessGone, createMainWindow,
};
