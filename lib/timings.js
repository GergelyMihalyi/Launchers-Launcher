// @ts-check
'use strict';

// The main process's TIMEOUTS and background scheduling delays in ONE place (ms). Tune here on a slower machine; the modules take the
// values from here. Guarded by `test/contracts/timings.test.js`: no literal `timeout:`/`withTimeout(…, <number>)` in lib/, and the
// renderer-side pairs are longer than the main-side ones. NOT here: cache lifetimes, the safe-mode counter, poller intervals and the
// renderer's UI-feel constants. Background: docs/dev/infrastructure.md#timeouts

// --- Launch / window-hide state machine (lib/launch/launch-controller.js) ---
// `createLaunchController({ timings })` may override these (the test uses short values).
const LAUNCH_TIMINGS = Object.freeze({
    // If neither `spawn` nor `error` arrives within this, the launch is stuck → `app-error`.
    spawnWatchdogMs: 6000,
    // In the first ~1.5 s after `spawn`, a blur is not the app taking focus but a notification / KWin OSD
    // during loading — do NOT hide immediately then.
    hideMinMs: 1500,
    // Fallback after `blur`: hide the launcher after this even if no blur arrived.
    hideFallbackMs: 8000,
    // Delay after the `child` 'close'/'error' before bringing the launcher back.
    bringToFrontMs: 1500,
    // A non-zero exit within this = failed launch (toast with the specific reason, see lib/launch/launch-errors.js).
    quickExitMs: 8000,
    // Poll interval + upper bound of the external-PID watcher (switching to an already running launcher).
    externalWatchMs: 1500,
    externalWatchMaxMs: 12 * 60 * 60 * 1000,
});

// --- External commands ---
// Uniform timeout for every external command (lib/exec.js `EXEC_TIMEOUT_MS`/`PACTL_OPTS`). Without it a
// stuck helper process causes a forever-hanging `ipcMain.handle` → the UI is stuck on "LOADING..." with
// no way out by controller.
const EXEC_TIMEOUT_MS = 8000;
// `bluetoothctl connect/disconnect/trust` (lib/exec.js `BT_TIMEOUT_OPTS`). A successful connect is usually
// ~1 s; for an unreachable device BlueZ's "page timeout" fails by itself after ~5 s — this is only a safety
// net against a rarer ("connection busy") hang.
const BT_CONNECT_TIMEOUT_MS = 12000;
// `bluetoothctl pair` (pairing from the UI, lib/bluetooth/bluetooth.js).
const BT_PAIR_TIMEOUT_MS = 25000;
// `bluetoothctl --timeout N scan on` exits by itself after N s; this much slack on top.
const BT_SCAN_GRACE_MS = 8000;
// Wi-Fi (lib/network/wifi.js): `nmcli dev wifi list --rescan yes` takes ~6 s (measured on the laptop);
// connecting also waits for a DHCP lease — `nmcli --wait` is 5 s shorter than this.
const WIFI_SCAN_TIMEOUT_MS = 15000;
const WIFI_CONNECT_TIMEOUT_MS = 40000;
// The quick flatpak queries (`list`/`info`/`ps`) — shorter than the general one: catalog detection runs
// in parallel for every entry, one slow call must not drag the list.
const FLATPAK_QUERY_TIMEOUT_MS = 5000;
// The two steps of the in-app flatpak install (lib/ipc/launcher-manage-ipc.js `installFlatpak`):
// `remote-add` is quick and network-bound; `install` can take minutes for a big package.
const FLATPAK_REMOTE_TIMEOUT_MS = 25000;
const FLATPAK_INSTALL_TIMEOUT_MS = 300000;
// `lutris --list-games --installed --json` (~0.6-0.7 s on the machine).
const LUTRIS_LIST_TIMEOUT_MS = 8000;
// Self-update (lib/update/self-update.js): `git fetch`/`pull` is network-bound; `npm install` may download
// the ~280 MB binary on an electron version change; the rollback's `git reset --hard` (bootstrap.js) is local.
const GIT_FETCH_TIMEOUT_MS = 25000;
const NPM_INSTALL_TIMEOUT_MS = 300000;
const GIT_RESET_TIMEOUT_MS = 15000;
// Dependency hygiene (lib/update/dep-health.js): `npm outdated` / `npm audit` — network-bound, informational only.
const NPM_QUERY_TIMEOUT_MS = 30000;
// Downloading one cover (default of lib/net.js `downloadFile`).
const DOWNLOAD_TIMEOUT_MS = 8000;
// The tar archive of game saves (lib/saves/save-backup.js) — raise it for a slow / USB target drive.
const SAVE_BACKUP_TIMEOUT_MS = 10 * 60 * 1000;
// Automatic save backup (lib/ipc/saves-ipc.js `autoBackup`): minimum gap between two backups in "after game" /
// "daily" mode, the delay of the startup attempt (must not compete with the startup), and the post-game delay
// (the disk load must not coincide with the picture switch after the launcher returns).
const SAVE_AUTO_AFTER_GAME_MIN_MS = 60 * 60 * 1000;
const SAVE_AUTO_DAILY_MIN_MS = 24 * 60 * 60 * 1000;
const SAVE_AUTO_STARTUP_DELAY_MS = 2 * 60 * 1000;
const SAVE_AUTO_AFTER_GAME_DELAY_MS = 30 * 1000;
// Installing missing system packages from the launcher (lib/host-deps/host-packages.js): the polkit password
// prompt + the package manager download together — the user may be sitting at the password dialog.
const HOST_PACKAGE_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

// --- Startup: outputs, TV, CEC (main.js, lib/output/startup-outputs.js) ---
// We wait at most this long for the startup outputs (monitor + audio) BEFORE creating the window —
// after that the window opens regardless.
const STARTUP_OUTPUTS_MAX_WAIT_MS = 7000;
// Own limit of each startup step (monitor or audio device) — shorter than the wait above so a stuck step
// is logged under its own name.
const STARTUP_STEP_TIMEOUT_MS = 6000;
// The second (confirming) round of the startup window move after `did-finish-load`.
const STARTUP_WINDOW_MOVE_RETRY_MS = 1500;
// X11 window move (GNOME, `main.js` `moveLauncherToOutput`): waiting for leaving fullscreen
// (`leave-full-screen`), and for a just-enabled monitor to appear in Electron's `screen` list (it updates
// asynchronously after the monitor switch) — at this interval, this many times.
const X11_FULLSCREEN_LEAVE_MS = 600;
const X11_DISPLAY_POLL_MS = 250;
const X11_DISPLAY_POLL_TRIES = 12;
// GPU status check after `did-finish-load` (lib/gpu-fallback.js): by then Chromium has switched to software
// rendering after a failed GPU process.
const GPU_CHECK_DELAY_MS = 3000;
// TV power-on over CEC (`cec-toolbox on` / `cec-ctl --image-view-on`).
const CEC_POWER_ON_TIMEOUT_MS = 6000;
// The startup audio device (the TV's HDMI sink) only shows up in PipeWire once the TV has woken up — after the
// CEC power-on, seconds AFTER the launcher started. A missing sink is re-checked at this interval, this many times
// (`audio.waitForStartupSink`, in the background — the window does not wait for it).
const STARTUP_SINK_POLL_MS = 1000;
const STARTUP_SINK_POLL_TRIES = 30;

// --- TV-mode exit (lib/output/tv-mode.js, lib/ipc/tv-mode-ipc.js) ---
// Monitor and audio restore per step; disconnecting the controllers over BT takes longer (several devices,
// `bluetoothctl disconnect` one by one).
const TV_EXIT_STEP_TIMEOUT_MS = 6000;
// A DISABLED monitor can flap its hotplug line (HPD) — the ultrawide on HDMI-A-1 disconnects/reconnects every ~5 s while it gets no
// signal (journal 2026-11-02) — so at the desktop restore it may be "not connected" for a second or two. Re-checked at this interval,
// this many times (together shorter than TV_EXIT_STEP_TIMEOUT_MS).
const MONITOR_RESTORE_RETRY_MS = 500;
const MONITOR_RESTORE_RETRY_TRIES = 8;
const TV_EXIT_GAMEPAD_TIMEOUT_MS = 8000;
// The optional TV standby (`display.standbyOnExit`) AFTER the above.
const CEC_STANDBY_TIMEOUT_MS = 4000;

// --- Monitor switch confirmation (lib/ipc/output-ipc.js) ---
// How long to wait for the ✕ confirmation before the previous layout is restored. The timer runs on the
// MAIN side — the renderer may be on a dark screen.
const MONITOR_CONFIRM_MS = 15000;
// If the output to restore (typically the TV turned off meanwhile) is not connected yet, try once more this
// long after the CEC wake-up.
const MONITOR_REVERT_RETRY_MS = 4000;

// --- Undo of a launcher removal (lib/ipc/launcher-manage-ipc.js) ---
// How long main keeps the last removed launcher (the renderer's "△ UNDO" toast is shorter); after that its
// imported icon is deleted too and undo is no longer possible.
const LAUNCHER_REMOVE_UNDO_MS = 30000;

// --- Scheduling background work at startup / on return (main.js) ---
// Delay of the Games cache warmup after the window has loaded: the first paint / card render must not
// compete with the scans.
const GAMES_WARMUP_START_DELAY_MS = 2000;
// After returning from a game/app (after `bringToFront`), this much pause before the targeted rewarm.
const GAMES_WARMUP_RETURN_DELAY_MS = 1500;
// First refresh of the derived "recently played" sources updated in the background — the first
// `get-launchers` response + the first card paint go out first.
const DERIVED_RECENT_REFRESH_DELAY_MS = 600;

// --- Background scans (lib/scan/scan-pool.js, lib/games/games-warmup.js) ---
// Upper bound of a worker-scan request from submission (queue wait included). melonDS takes ~13 s cold on
// NFS — this is well above that; on expiry the worker is discarded (a read stuck on an unreachable network
// folder must not hold the lists forever).
const SCAN_JOB_TIMEOUT_MS = 90000;
// Upper bound of ONE warmup step (above the scan limit, so that one fires first).
const GAMES_WARMUP_STEP_TIMEOUT_MS = 120000;
// After `MAX_RESPAWNS` consecutive worker deaths / timeouts, NO new worker starts for this long (requests
// fail immediately), then a fresh attempt.
const SCAN_WORKER_COOLDOWN_MS = 60000;

// --- Error policy (lib/fatal-policy.js, bootstrap.js) ---
// For this long after the renderer's first load an `unhandledRejection` is still fatal (startup window — the
// self-update rollback makes sense here); after that it is only logged + counted.
const STARTUP_FATAL_GRACE_MS = 30000;

// --- IPC `invoke` upper bound (lib/ipc/ipc-guard.js) ---
// Upper bound of an `ipcMain.handle` response: even a never-settling handler must not keep the UI loading
// forever (the renderer gets a rejection → error state). The internal chains (exec, worker scan, warmup step)
// have their own limits BELOW it; legitimately long operations are overridden per channel.
const IPC_HANDLE_TIMEOUT_MS = 120000;
const IPC_HANDLE_TIMEOUT_OVERRIDES = Object.freeze({
    'install-host-packages': HOST_PACKAGE_INSTALL_TIMEOUT_MS + 60000, // pkcon / pkexec + the polkit password
    'refresh-games': 5 * 60000, // full rescan (the worker-scan limit + the synchronous steps)
});

module.exports = {
    LAUNCH_TIMINGS,
    EXEC_TIMEOUT_MS, BT_CONNECT_TIMEOUT_MS, BT_PAIR_TIMEOUT_MS, BT_SCAN_GRACE_MS,
    WIFI_SCAN_TIMEOUT_MS, WIFI_CONNECT_TIMEOUT_MS,
    FLATPAK_QUERY_TIMEOUT_MS, FLATPAK_REMOTE_TIMEOUT_MS, FLATPAK_INSTALL_TIMEOUT_MS,
    LUTRIS_LIST_TIMEOUT_MS, GIT_FETCH_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS, GIT_RESET_TIMEOUT_MS, NPM_QUERY_TIMEOUT_MS,
    DOWNLOAD_TIMEOUT_MS, SAVE_BACKUP_TIMEOUT_MS,
    SAVE_AUTO_AFTER_GAME_MIN_MS, SAVE_AUTO_DAILY_MIN_MS, SAVE_AUTO_STARTUP_DELAY_MS, SAVE_AUTO_AFTER_GAME_DELAY_MS, HOST_PACKAGE_INSTALL_TIMEOUT_MS,
    STARTUP_OUTPUTS_MAX_WAIT_MS, STARTUP_STEP_TIMEOUT_MS, STARTUP_WINDOW_MOVE_RETRY_MS, X11_FULLSCREEN_LEAVE_MS, X11_DISPLAY_POLL_MS, X11_DISPLAY_POLL_TRIES, GPU_CHECK_DELAY_MS,
    CEC_POWER_ON_TIMEOUT_MS, STARTUP_SINK_POLL_MS, STARTUP_SINK_POLL_TRIES,
    TV_EXIT_STEP_TIMEOUT_MS, TV_EXIT_GAMEPAD_TIMEOUT_MS, CEC_STANDBY_TIMEOUT_MS, MONITOR_RESTORE_RETRY_MS, MONITOR_RESTORE_RETRY_TRIES,
    MONITOR_CONFIRM_MS, MONITOR_REVERT_RETRY_MS, LAUNCHER_REMOVE_UNDO_MS,
    GAMES_WARMUP_START_DELAY_MS, GAMES_WARMUP_RETURN_DELAY_MS, DERIVED_RECENT_REFRESH_DELAY_MS,
    SCAN_JOB_TIMEOUT_MS, GAMES_WARMUP_STEP_TIMEOUT_MS, SCAN_WORKER_COOLDOWN_MS, STARTUP_FATAL_GRACE_MS,
    IPC_HANDLE_TIMEOUT_MS, IPC_HANDLE_TIMEOUT_OVERRIDES,
};
