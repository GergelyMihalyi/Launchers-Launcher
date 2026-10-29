// @ts-check
'use strict';

// Foreground guard: on a kiosk the launcher is the shell — if the window loses focus NOT because of a game launch (not hidden, no
// launch sequence running), it takes the foreground back (autostart apps started after login rise above the launcher). Under Wayland
// a plain Electron `focus()` may not be enough (KWin focus-stealing prevention) → fallback to the KWin `WindowsRunner` D-Bus path
// (`windowActivate`). `schedule()` is wired to `blur` (debounced); `guard()` can be called/tested directly (no debounce).
// Background: docs/dev/launching.md#foreground-guard-and-do-not-disturb

/**
 * @param {object} deps
 * @param {() => any} deps.getWindow - the current `BrowserWindow` (may be recreated)
 * @param {() => boolean} deps.getAlwaysOnTop - `alwaysOnTop` config key (the user can turn it off)
 * @param {() => boolean} deps.isLaunchSequenceActive - is a game starting/running (the screen is its own)
 * @param {{ activateWindow: (query: string) => Promise<any> }} deps.windowActivate
 * @param {(msg: string) => void} deps.log
 * @param {number} [deps.delayMs]
 */
function createForegroundGuard({ getWindow, getAlwaysOnTop, isLaunchSequenceActive, windowActivate, log, delayMs = 500 }) {
    let timer = null;

    function guard() {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        if (!getAlwaysOnTop()) return;          // turned off by the user (settings-always-on-top.js)
        if (isLaunchSequenceActive()) return;   // a game is starting/running — the screen is its own
        if (!win.isVisible()) return;           // we are hidden under a game
        if (win.isFocused()) return;            // we already have the focus (it was a passing blur)
        log('Foreground guard: the launcher lost focus without a game — taking it back');
        try {
            win.moveTop();
            win.focus();
        } catch (err) {
            log(`Foreground guard moveTop/focus error: ${err.message}`);
        }
        windowActivate.activateWindow('Launchers Launcher').catch((err) => {
            log(`Foreground guard activateWindow error: ${err.message}`);
        });
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            guard();
        }, delayMs);
    }

    function cancel() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    return { schedule, guard, cancel };
}

module.exports = { createForegroundGuard };
