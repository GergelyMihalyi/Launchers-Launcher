// @ts-check
'use strict';

// The real Electron entry point (`package.json` "main") — NOT `main.js` directly. A broken commit pulled in by a self-update
// (e.g. a syntax error) throws at PARSE time in `require('./main.js')`, which a try/catch INSIDE `main.js` could never catch. This wrapper
// tries to recover: a valid `pendingUpdateRollback` marker (written by apply-update with the pre-update HEAD SHA) → `git reset --hard` + relaunch;
// otherwise the crash-restart logic of `bin/launchers-launcher-watcher.sh` takes over. The `process.on('uncaughtException'/'unhandledRejection')`
// handlers also cover async startup errors. Scope: main-process errors only — a broken `renderer/*.js` is NOT caught here.
// Background: docs/dev/install-update.md#self-update-and-rollback

const { app } = require('electron');
const path = require('path');
const os = require('os');
const { createLogger } = require('./lib/exec.js');
const selfUpdate = require('./lib/update/self-update.js');
const { fatalPolicy } = require('./lib/fatal-policy.js');
const { STARTUP_FATAL_GRACE_MS } = require('./lib/timings.js');

const LOG_FILE = path.join(os.homedir(), '.local', 'share', 'launchers-launcher.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const log = createLogger(LOG_FILE, LOG_MAX_BYTES);

// `performPendingRollback` is async (waits on git) — a SECOND error arriving while the first one is
// still being handled must not start a parallel rollback attempt.
let handlingFatalError = false;

// `main.js` `module.exports.forceQuitCleanup` — if the file loaded, this stops the detached helper processes
// (e.g. the do-not-disturb kde-inhibit) before EVERY `app.exit()`, because `app.exit()` SKIPS `will-quit`
// (where this cleanup is normally wired) — without it a running inhibit could stay up for up to 24 hours.
let mainModule = null;

function cleanupBeforeExit() {
    try {
        if (mainModule && typeof mainModule.forceQuitCleanup === 'function') mainModule.forceQuitCleanup();
    } catch (err) {
        log(`[bootstrap] cleanupBeforeExit error (swallowed): ${(err && err.stack) || err}`);
    }
}

function onFatalError(source, err) {
    // Once startup is over, an unhandled rejection does NOT take the kiosk down (a forgotten `.catch` must not
    // restart the launcher hours later) — it is only logged + counted (lib/fatal-policy.js).
    // `uncaughtException` and the startup window stay fatal.
    if (!fatalPolicy.isFatal(source)) {
        fatalPolicy.noteNonFatal(err);
        log.error(`[bootstrap] ${source} (non-fatal, after start-up): ${(err && err.stack) || err}`);
        return;
    }
    if (handlingFatalError) {
        log(`[bootstrap] ${source} error while handling (swallowed): ${(err && err.stack) || err}`);
        return;
    }
    handlingFatalError = true;
    log(`[bootstrap] ${source}: ${(err && err.stack) || err}`);
    selfUpdate.performPendingRollback(__dirname, log)
        .then((rolledBack) => {
            cleanupBeforeExit();
            if (rolledBack) {
                // Same convention as a successful apply-update (`app.relaunch(); app.exit(0)`)
                // — so `bin/launchers-launcher-watcher.sh` does not restart it a second time.
                app.relaunch();
                app.exit(0);
            } else {
                // No (valid) rollback marker -> let the watcher's crash-restart logic take over.
                app.exit(1);
            }
        })
        .catch((rollbackErr) => {
            log(`[bootstrap] rollback error: ${rollbackErr.message}`);
            cleanupBeforeExit();
            app.exit(1);
        });
}

// End of the startup window: the first window's renderer has loaded + `STARTUP_FATAL_GRACE_MS`.
app.once('browser-window-created', (event, win) => {
    win.webContents.once('did-finish-load', () => fatalPolicy.settleAfter(STARTUP_FATAL_GRACE_MS));
});

process.on('uncaughtException', (err) => onFatalError('uncaughtException', err));
process.on('unhandledRejection', (reason) => onFatalError('unhandledRejection', reason));

// Single-instance lock — BEFORE `main.js` is loaded: a second instance (the TV-mode watcher / systemd
// trigger may fire twice) runs no config operation and registers nothing; the first instance's
// `second-instance` handler (main.js) brings the existing window forward. Callable before `app.whenReady()`.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    try {
        mainModule = require('./main.js');
    } catch (err) {
        onFatalError('require(main.js)', err);
    }
}
