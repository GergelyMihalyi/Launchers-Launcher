// @ts-check
// The Electron main process "composition root": constructs the `lib/` services, wires the
// `registerXIpc({ ipcMain, … })` functions of the `lib/ipc/` modules (the channel name lives next to
// its handler body), and drives the lifecycle. No business logic belongs here.
//
// Sections — each relies only on the ones above it; callbacks passed at construction time
// (e.g. `launchersPayload`) only run AFTER `app.whenReady()`, by when everything is constructed:
//   1. Early steps (BEFORE ready)   2. Launcher-list state   3. Services
//   4. Window                       5. IPC per domain (+ the launch state machine)   6. Lifecycle
const { app, BrowserWindow, clipboard, ipcMain: rawIpcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const config = require('./lib/config.js');
const { bootConfig } = require('./lib/config-boot.js');
const { pickOzonePlatform } = require('./lib/ozone-platform.js');
const { execFileAsync, EXEC_TIMEOUT_MS, createLogger, withTimeout } = require('./lib/exec.js');
const {
    STARTUP_OUTPUTS_MAX_WAIT_MS, STARTUP_WINDOW_MOVE_RETRY_MS, GPU_CHECK_DELAY_MS,
    GAMES_WARMUP_START_DELAY_MS, GAMES_WARMUP_RETURN_DELAY_MS, DERIVED_RECENT_REFRESH_DELAY_MS,
} = require('./lib/timings.js');
const { dataHome, setAppVariants } = require('./lib/xdg.js');
const { desktopEnv } = require('./lib/desktop-env.js');
const safeModeLib = require('./lib/safe-mode.js');
const gpuFallback = require('./lib/gpu-fallback.js');
const { createStartupTimeline, formatTimeline } = require('./lib/startup-timeline.js');
const { setFormatDriftLogger } = require('./lib/host-deps/format-drift.js');
const selftest = require('./lib/host-deps/selftest.js');
const prefs = require('./lib/prefs.js');
const launchersLib = require('./lib/launcher-list.js');
const flatpak = require('./lib/flatpak.js');
const { downloadFileDetailed } = require('./lib/net.js');
// Launcher discovery (the registry emulators' modules lazily, in the descriptor — lib/launchers/emulator-sources.js)
const {
    findInstalledGamesCached: findInstalledSteamGames, findRecentlyPlayed: findSteamRecentlyPlayed,
    defaultSteamRoot, isSteamRunning,
} = require('./lib/launchers/steam-library.js');
const { findInstalledGamesCached: findInstalledHeroicGames, heroicConfigRoot } = require('./lib/launchers/heroic-library.js');
const lutrisLibrary = require('./lib/launchers/lutris-library.js');
const {
    findSystemCountsCached: findRetroarchSystemCounts, findGamesForSystemCached: findRetroarchGamesForSystem,
    findRecentGames: findRetroarchRecentGames, ensureRecentThumbnails: ensureRetroarchThumbnails,
    resolveRetroarchThumbnail, corePathForSystem, retroarchConfigRoot,
} = require('./lib/launchers/retroarch-library.js');
const { createEmulatorSources } = require('./lib/launchers/emulator-sources.js');
const { createCoverMissCache } = require('./lib/launchers/shared/cover-miss-cache.js');
const { applyCoverOverridesToEntries } = require('./lib/launchers/shared/cover-override.js');
// Scan / recent / covers
const { SCAN_SOURCES } = require('./lib/scan/scan-sources.js');
const { createScanPool } = require('./lib/scan/scan-pool.js');
const { defaultScanCacheDir } = require('./lib/scan/scan-meta-cache.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('./lib/ttl-cache.js');
const { createUsage, mergeRecentGameLists } = require('./lib/recent/usage.js');
const { createRecentCovers } = require('./lib/recent/recent-covers.js');
const { createRecentGamesMerge } = require('./lib/recent/recent-games-merge.js');
const { createSessionRefresh } = require('./lib/recent/session-refresh.js');
// Outputs / TV / devices
const displays = require('./lib/output/displays.js');
const audio = require('./lib/output/audio.js');
const cec = require('./lib/output/cec.js');
const tvMode = require('./lib/output/tv-mode.js');
const startupOutputs = require('./lib/output/startup-outputs.js');
const { createEvdevPads } = require('./lib/evdev-pads.js');
const { createSystemPower } = require('./lib/system-power.js');
// Sidecars
const mainController = require('./lib/sidecars/main-controller.js');
const tvModeEnter = require('./lib/sidecars/tv-mode-enter.js');
const autostart = require('./lib/sidecars/autostart.js');
const xdgAutostart = require('./lib/sidecars/xdg-autostart.js');
const { resyncSidecars } = require('./lib/sidecars/sidecar-sync.js');
// Launch / window
const running = require('./lib/launch/running.js');
const { createRunningPoll } = require('./lib/launch/running-poll.js');
const { createLaunchController } = require('./lib/launch/launch-controller.js');
const windowActivate = require('./lib/launch/window-activate.js');
const { createLauncherMover } = require('./lib/launch/window-to-output.js');
const { createForegroundGuard } = require('./lib/launch/foreground-guard.js');
const { createDoNotDisturb } = require('./lib/launch/do-not-disturb.js');
const { createMainWindow, logChildProcessGone } = require('./lib/launch/main-window.js');
// IPC — one `register*Ipc` per domain
const { registerLaunchIpc, steamExecSpec, findSteamLauncher } = require('./lib/ipc/launch-ipc.js');
const { registerLauncherListIpc, registerGamesDomainIpc } = require('./lib/ipc/ipc-groups.js');
const { registerOutputIpc } = require('./lib/ipc/output-ipc.js');
const { registerTvModeIpc } = require('./lib/ipc/tv-mode-ipc.js');
const { registerBluetoothIpc } = require('./lib/ipc/bluetooth-ipc.js');
const { registerWifiIpc } = require('./lib/ipc/wifi-ipc.js');
const { registerPrefsIpc } = require('./lib/ipc/prefs-ipc.js');
const { registerSetupIpc } = require('./lib/ipc/finish-setup.js');
const { registerSavesIpc } = require('./lib/ipc/saves-ipc.js');
const { registerSystemPowerIpc } = require('./lib/ipc/system-power-ipc.js');
const { registerClipboardIpc } = require('./lib/ipc/clipboard-ipc.js');
const { registerDiagnosticsIpc, electronAppInfo } = require('./lib/ipc/diagnostics-ipc.js');
const { registerUpdateIpc } = require('./lib/ipc/update-ipc.js');

// ═══ 1. Early steps (BEFORE ready) ═══════════════════════════════════════════════════════════

// The single-instance lock lives in `bootstrap.js` (BEFORE `require('./main.js')`) — a second
// instance never loads this file. Only the bring-to-front is here.
let mainWindow;
app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        sendToRenderer('launcher-revealed'); // the loader must not get stuck next to a running game
    }
});

// The log comes first (it only depends on `dataHome()`) so every startup step can log in place.
// It lives under `~/.local/share` (not `app.getPath('logs')`) — the host scripts look there too.
// Launched games' stdout does NOT go here (see `DEBUG_CHILD`).
const logFile = path.join(dataHome(), 'launchers-launcher.log');
const log = createLogger(logFile, 2 * 1024 * 1024);
setFormatDriftLogger((msg) => log.warn(msg));

// The catalog of addable launchers (every active launcher lives in `customLaunchers`).
const launcherCatalog = require('./data/launcher-catalog.json');

// Config: corrupt-file rescue → legacy migration → normalization → daily backup → schema migrations.
bootConfig({ repoRoot: __dirname, catalog: launcherCatalog, log });

// Safe mode: if none of the previous starts reached the "healthy" point (or `LAUNCHERS_LAUNCHER_SAFE=1`),
// skip everything that changes the machine state / starts heavy I/O (output switch, CEC, warmup, evdev).
const safeMode = safeModeLib.beginStartup();
if (safeMode.safe) {
    const why = safeMode.reason === 'env' ? 'LAUNCHERS_LAUNCHER_SAFE=1'
        : safeMode.reason === 'renderer' ? 'repeated renderer crashes'
            : `${safeMode.prevCount} unfinished starts in a row`;
    log(`SAFE MODE (${why}) — output switch/CEC/warmup/evdev skipped`);
}
const startupTimeline = createStartupTimeline();

// GPU: software rendering in safe mode, with `LAUNCHERS_LAUNCHER_DISABLE_GPU=1`,
// or after an earlier GPU failure (on the same Electron + Mesa signature).
const gpu = gpuFallback.decideAtStartup({ safe: safeMode.safe, electronVersion: process.versions.electron, log });
if (gpu.disabled) app.disableHardwareAcceleration();

// Screen reader: on Linux Electron's `setAccessibilitySupportEnabled` has no effect —
// this switch is the fallback; it takes effect on the NEXT start.
if (prefs.getFeedback().screenReader === true) app.commandLine.appendSwitch('force-renderer-accessibility');

// The graphics platform (Wayland / X11) MATTERS: never decide from env variables
// (XDG_SESSION_TYPE/WAYLAND_DISPLAY) — the systemd --user watcher does not reliably inherit them
// (instant SIGSEGV on every start). `pickOzonePlatform()` decides from the existence of the Wayland
// SOCKET; manual override: `LAUNCHERS_LAUNCHER_OZONE=wayland|x11`. The `package.json` `start` script
// deliberately has no `--ozone-platform` (`bin/start.js` passes the same decision on the CLI).
const ozone = pickOzonePlatform();
if (ozone.display && !process.env.DISPLAY) process.env.DISPLAY = ozone.display;
app.commandLine.appendSwitch('ozone-platform', ozone.platform);
log(`[ozone] ${ozone.platform} — ${ozone.reason}`);
log(`[desktop] ${desktopEnv()} (XDG_CURRENT_DESKTOP=${process.env.XDG_CURRENT_DESKTOP || '-'})`);

// The navigation blips (Web Audio) play on gamepad buttons, which Chromium does not always treat as
// a "user gesture" — without this the AudioContext could stay suspended.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// The launched app's stdout/stderr only reaches the log with this (otherwise a running game would bloat it).
const DEBUG_CHILD = process.env.LAUNCHER_DEBUG_CHILD === '1';

// ═══ 2. Launcher-list state ══════════════════════════════════════════════════════════════════

// The active launchers: `launchersRaw` = `customLaunchers` (read by the maintenance handlers),
// `launchers` = ordered + with accent overrides (the cards, launching).
let launchersRaw = [];
let launchers = [];
let appVariantsKey = null;

// Rereads from disk; writes the chosen native/flatpak variants into `lib/xdg.js` (the library modules
// use it to know which data root to read). `true` = the variant map changed (the first call does not count).
function loadLaunchers() {
    launchersRaw = launchersLib.readCustomLaunchers();
    const ordered = launchersLib.orderLaunchers(launchersLib.readLauncherOrder(), launchersRaw);
    launchers = launchersLib.applyAccentOverrides(ordered, config.get('launcherAccents', {}));
    const map = launchersLib.appVariantsFromLaunchers(launchersRaw, launcherCatalog);
    const key = JSON.stringify(Object.entries(map).sort());
    if (key === appVariantsKey) return false;
    const first = appVariantsKey === null;
    appVariantsKey = key;
    setAppVariants(map);
    return !first;
}
loadLaunchers();

// ═══ 3. Services (Electron-free factories) ═══════════════════════════════════════════════════

// Guarded renderer send: during close/reload the window may already be null when an async command ends.
function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Uniform response wrapper of query handlers: `{ ok, items }` — "no device" (ok, []) and
// "query failed" (ok:false) stay distinguishable (e.g. a timed-out pactl).
async function safeList(label, fn) {
    try {
        return { ok: true, items: await fn() };
    } catch (err) {
        log(`${label}: ${err.message}`);
        return { ok: false, items: [] };
    }
}

// The HEAVY (ROM-folder walking) library scans run in a worker thread; one TTL cache per source
// from `SCAN_SOURCES` (a new heavy source = 1 row there). The per-file metadata cache is persisted.
const scanPool = createScanPool({ log, persistDir: defaultScanCacheDir() });
const workerScans = Object.fromEntries(Object.keys(SCAN_SOURCES).map((key) => [
    key, createTtlCache((...args) => scanPool.scan(key, args), GAMES_CACHE_TTL_MS),
]));

// The emulator descriptor. The RPCS3 root and the quick-launch cover fetcher are a CIRCULAR dependency
// (`recentGamesMerge`/`recentCovers` get the descriptor themselves) — hence lazy getters; they only run after ready.
const emulatorSources = createEmulatorSources({
    config, workerScans,
    activeRpcs3ConfigRoot: () => recentGamesMerge.activeRpcs3ConfigRoot(),
    coverFetcher: (kind) => recentCovers.RECENT_COVER_FETCHERS[kind],
});

// `usage` (favorite badge) + `recentGames` (quick-launch bar) bookkeeping + decorating the launcher
// payload. Derived sources built on a full library scan refresh in the background and "pop in"
// with a `running-changed` push.
const usage = createUsage({
    config,
    log: (msg) => log(msg),
    fetchSteamRecent: () => findSteamRecentlyPlayed(defaultSteamRoot(), 3),
    fetchRetroarchRecent: () => {
        const list = findRetroarchRecentGames(retroarchConfigRoot(), 3);
        recentCovers.RECENT_COVER_FETCHERS.retroarch(list); // missing top-3 covers, fire-and-forget
        return list;
    },
    emulatorFetchers: Object.fromEntries(Object.entries(emulatorSources)
        .filter(([, src]) => src.recent).map(([id, src]) => [id, src.recent.fetch])),
    backgroundSources: Object.keys(emulatorSources).filter((id) => emulatorSources[id].recent && emulatorSources[id].recent.background),
    refreshDelayMs: DERIVED_RECENT_REFRESH_DELAY_MS,
    onDerivedChanged: () => pushLauncherState(),
});

// SHARED entry point of network cover downloads: a 404/410 cover is not requested again for 7 days.
const coverMisses = createCoverMissCache({
    file: path.join(dataHome(), 'launchers-launcher', 'cover-misses.json'),
    download: (url, dest) => downloadFileDetailed(url, dest),
    log,
});
const coverDownload = (url, dest) => coverMisses.download(url, dest);

const recentCovers = createRecentCovers({
    config, log, sendToRenderer, prefs, downloadFile: coverDownload,
    launchersPayload: () => launchersWithUsage(),
    invalidateDerivedRecent: (id) => usage.invalidateDerivedRecent(id),
    retroarchConfigRoot, resolveRetroarchThumbnail, ensureRetroarchThumbnails,
    emulatorSources, findInstalledSteamGames,
});

const recentGamesMerge = createRecentGamesMerge({
    getLaunchers: () => launchers,
    lutrisLibrary, rpcs3Library: emulatorSources.rpcs3.library, usage, mergeRecentGameLists,
    config, log, sendToRenderer, launchersPayload: () => launchersWithUsage(),
});

// The launchers currently RUNNING on the machine ("● RUNNING" badge + the `launch-app` "running → switch"
// branch); only while the launcher window is visible.
const runningPoll = createRunningPoll({
    running, homeDir: os.homedir(), getLaunchers: () => launchers, log, sendToRenderer,
    launchersPayload: () => launchersWithUsage(),
});

// The `get-launchers` / `launchers-changed` / `running-changed` payload (with manual cover overrides
// on the quick-launch bar covers).
function launchersWithUsage() {
    return usage.decorateLaunchers(launchers, runningPoll.getRunningIds()).map((l) => {
        const recent = applyCoverOverridesToEntries(l.recentGames);
        return recent === l.recentGames ? l : { ...l, recentGames: recent };
    });
}

// Refreshes the cards' "● RUNNING" badge + the quick-launch / Continue bars.
function pushLauncherState() {
    sendToRenderer('running-changed', launchersWithUsage());
}

// PS combo → which controller (MAC), from kernel evdev events (the Gamepad API gives no MAC).
const evdevPads = createEvdevPads({ log });

// Do-not-disturb while playing — wired to the launch sequence.
// `recover()` restores GNOME notifications left disabled by an earlier crashed run.
const doNotDisturb = createDoNotDisturb({
    log, execFileAsync, spawn, execTimeoutMs: EXEC_TIMEOUT_MS,
    desktop: desktopEnv(),
    markerFile: path.join(dataHome(), 'launchers-launcher', 'gnome-dnd-active'),
});
doNotDisturb.recover();

// System-action whitelist + sleep timer.
const systemPower = createSystemPower({ log, sendToRenderer });

// ═══ 4. Window ══════════════════════════════════════════════════════════════════════════════

// Foreground guard: on a kiosk machine the launcher is the shell — unless a game is running/starting,
// the screen is always its own. `launchSequenceActive` is the "game is starting" case (set by the
// launch controller), `hostInstallActive` the polkit password dialog (package install).
let launchSequenceActive = false;
let hostInstallActive = false;
const foregroundGuard = createForegroundGuard({
    getWindow: () => mainWindow,
    getAlwaysOnTop: () => prefs.getAlwaysOnTop(),
    isLaunchSequenceActive: () => launchSequenceActive || hostInstallActive,
    windowActivate,
    log,
});

// Moves the launcher window to an output (KWin script / GNOME+X11: Electron).
const launcherMover = createLauncherMover({
    screen, getWindow: () => mainWindow, displays, platform: ozone.platform, log,
});

const INDEX_PATH = path.join(__dirname, 'index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).href;
const rendererCrashGuard = safeModeLib.createRendererCrashGuard();

// Repeated renderer crashes: relaunch in safe mode (GPU OFF); if we are ALREADY in safe mode,
// `app.exit(1)` → the watcher's crash-restart (its burst limit closes the loop).
function onRepeatedRendererCrash() {
    safeModeLib.forceNext('renderer');
    if (safeMode.safe) {
        log.error('renderer crash: repeats even in safe mode — exiting (watcher)');
        forceQuitCleanup();
        app.exit(1);
        return;
    }
    relaunch('renderer crash: repeating — restarting in safe mode (GPU OFF)', log.error);
}

function createWindow() {
    mainWindow = createMainWindow({
        BrowserWindow, preloadPath: path.join(__dirname, 'preload.js'), iconPath: path.join(__dirname, 'assets', 'logo', 'logo-512.png'), indexPath: INDEX_PATH, indexUrl: INDEX_URL, log,
        crash: { guard: rendererCrashGuard, limit: safeModeLib.RENDERER_CRASH_LIMIT, log, onGiveUp: onRepeatedRendererCrash },
    });
    // `once`: a renderer reload (fatal overlay ✕) must not restart the warmup.
    mainWindow.webContents.once('did-finish-load', () => {
        startupTimeline.mark('rendererLoaded');
        if (!safeMode.safe) {
            // Warmup of the Games panel sources.
            gamesHandlers.scheduleGamesWarmup('startup', {}, GAMES_WARMUP_START_DELAY_MS, () => {
                if (startupTimeline.mark('warmupDone')) log(formatTimeline(startupTimeline.list()));
            });
            // KWin does not necessarily open a new window on the "priority 1" output — move it to the
            // startup monitor. TWICE: while the window is still entering fullscreen, KWin may override the
            // early move ("did not start fullscreen the first time"); the 2nd call runs on the finished
            // window and is a no-op if it is already in place.
            launcherMover.moveToStartupMonitor();
            setTimeout(() => launcherMover.moveToStartupMonitor(), STARTUP_WINDOW_MOVE_RETRY_MS).unref();
        }
        // The renderer loaded and lived for `HEALTHY_AFTER_MS` → healthy start.
        setTimeout(() => safeModeLib.markHealthy(), safeModeLib.HEALTHY_AFTER_MS).unref();
        setTimeout(() => gpuFallback.checkAfterLoad({
            decision: gpu, status: app.getGPUFeatureStatus().gpu_compositing, log,
        }), GPU_CHECK_DELAY_MS).unref();
    });
    // Debounced: a passing blur (notification, KWin OSD) must not fight the window; a game launch sets
    // `launchSequenceActive` to `true` synchronously before this runs.
    mainWindow.on('blur', foregroundGuard.schedule);
}

app.on('child-process-gone', (event, details) => logChildProcessGone(details, log));

// ═══ 5. IPC per domain (+ the launch state machine) ══════════════════════════════════════════
// An exception thrown in a listener must not become a fatal `uncaughtException` (lib/ipc/ipc-guard.js).
const ipcMain = require('./lib/ipc/ipc-guard.js').guardIpcMain(rawIpcMain, (m) => log.error(m));

// Launcher list: query, order, accent, add/remove, flatpak install, variant.
// After a native ↔ flatpak variant switch the game lists came from the old root → reload.
function reloadLaunchers() {
    if (!loadLaunchers()) return;
    log(`[launcher] variant switch → reloading the game lists: ${appVariantsKey}`);
    usage.invalidateDerivedRecent();
    gamesHandlers.refreshGames().catch((err) => log(`[warmup] variant: ${err.message}`));
}
const { variants: launcherVariants } = registerLauncherListIpc({
    ipcMain, launchersLib, launcherCatalog, log, sendToRenderer, reloadLaunchers, flatpak, config, repoRoot: __dirname,
    getLaunchersRaw: () => launchersRaw, setLaunchers: (list) => { launchers = list; }, launchersPayload: () => launchersWithUsage(),
});

// Games panel (lists, covers, warmup) + favorites/Continue/stats + source settings.
const { games: gamesHandlers, gameSources } = registerGamesDomainIpc({
    ipcMain, config, log, sendToRenderer, safeList, usage, emulatorSources, recentGamesMerge, recentCovers,
    findInstalledSteamGames, defaultSteamRoot, findInstalledHeroicGames, heroicConfigRoot,
    prefs, downloadFile: coverDownload, lutrisLibrary, workerScans, pushLauncherState, coverMisses,
    findRetroarchSystemCounts, findRetroarchGamesForSystem, ensureRetroarchThumbnails, retroarchConfigRoot,
    invalidateDerivedRecent: () => usage.invalidateDerivedRecent(),
    getActiveLaunchers: () => launchers, getLaunchers: () => launchersRaw,
});

// "Recently played" bookkeeping around a session + targeted cache invalidation / warmup.
const sessionRefresh = createSessionRefresh({
    usage, recentCovers, emulatorSources, lutrisLibrary, recentGamesMerge,
    scheduleReturnWarmup: (appId) => {
        if (safeMode.safe) return;
        gamesHandlers.scheduleGamesWarmup('return', { invalidate: gamesHandlers.warmupSourcesForAppId(appId) },
            GAMES_WARMUP_RETURN_DELAY_MS);
    },
});

// The launcher window becomes visible again → "● RUNNING" poller + PS-combo evdev watcher. With a hidden
// window (a game is running) neither is needed — the main thread must not drain the controller events.
function startLauncherWatchers() {
    runningPoll.start();
    if (!safeMode.safe) evdevPads.start();
}

// The launch window state machine (spawn + watchdog, blur-hide, `bringToFront`, external-PID watch) —
const { spawnGame, switchToRunning, killActiveGame, cancelLaunch, getActiveSession, resumeActiveSession } = createLaunchController({
    getWindow: () => mainWindow,
    log,
    sendToRenderer,
    killFlatpakApp: (appId) => flatpak.killFlatpakApp(appId),
    isFlatpakInstalled: (appId) => flatpak.flatpakAppInstalled(appId),
    recordUsage: (appId) => usage.recordUsage(appId),
    recordUsageDuration: (appId, ms) => usage.recordUsageDuration(appId, ms),
    todayPlaytimeMs: () => usage.todayPlaytimeMs(),
    recordRecentGame: (meta) => sessionRefresh.recordRecentGame(meta),
    invalidateRecent: (appId) => sessionRefresh.afterSession(appId),
    launchersPayload: () => launchersWithUsage(),
    onLauncherShown: startLauncherWatchers,
    onLauncherHidden: () => { runningPoll.stop(); evdevPads.stop(); },
    onLaunchSequenceStart: () => { launchSequenceActive = true; if (prefs.getDoNotDisturb()) doNotDisturb.start(); },
    onLaunchSequenceEnd: () => { launchSequenceActive = false; doNotDisturb.stop(); savesHandlers.autoBackupAfterGame(); },
    activateWindow: (query) => windowActivate.activateWindow(query),
    raiseSteamBigPicture: () => {
        // Native OR flatpak Steam — according to the added steam launcher (lib/ipc/launch-ipc.js).
        const spec = steamExecSpec(findSteamLauncher(launchers), ['steam://open/bigpicture']);
        return execFileAsync(spec.cmd, spec.args, { timeout: EXEC_TIMEOUT_MS });
    },
    debugChild: DEBUG_CHILD,
});

// Game/launcher launch (payload validation, "running → switch", cmd/args) + force close.
registerLaunchIpc({
    ipcMain,
    getLaunchers: () => launchers,
    spawnGame,
    switchToRunning,
    killActiveGame,
    cancelLaunch,
    getLaunchOption: (key) => prefs.getGameLaunchOption(key),
    getActiveSession,
    resumeActiveSession,
    isLauncherRunning: (launcher) => running.isLauncherRunning(launcher, os.homedir()),
    corePathForSystem: (system) => corePathForSystem(retroarchConfigRoot(), system),
    isSteamRunning: () => isSteamRunning(os.homedir()),
    log,
    sendToRenderer,
    getCustomGameSources: () => gameSources.getCustomGameSources().sources,
    emulatorSources,
});

// Audio + Display.
const outputHandlers = registerOutputIpc({
    ipcMain, audio, displays, startupOutputs, log, sendToRenderer, safeList,
    moveWindowToOutput: (output) => launcherMover.moveTo(output),
    getVolumeMax: prefs.getVolumeMax,
});

// TV mode / CEC (`exit-tv-mode` ends with `app.quit()`).
registerTvModeIpc({
    ipcMain, tvMode, cec, displays, flatpak, prefs, tvModeEnter, log, sendToRenderer,
    quit: () => app.quit(),
});

// Controllers (BT) + Wi-Fi.
registerBluetoothIpc({ ipcMain, log, sendToRenderer, safeList, evdevPads });
registerWifiIpc({ ipcMain, log });

// Preferences (theme, feedback, background, language, the trivial switches) + the synchronous boot state.
registerPrefsIpc({
    ipcMain, prefs, sendToRenderer, log, mainController, autostart, xdgAutostart,
    repoRoot: __dirname,
    stopDoNotDisturb: () => doNotDisturb.stop(),
    getLauncherIcons: () => launchers.map((l) => l.icon).filter((i) => typeof i === 'string' && i),
    safeModeReason: safeMode.safe ? safeMode.reason : null,
});

// Setup wizard.
registerSetupIpc({
    ipcMain, launchersLib, launcherCatalog, displays, audio, prefs, mainController,
    log, loadLaunchers: reloadLaunchers, launchersWithUsage, sendToRenderer,
});

// Game save backups.
const savesHandlers = registerSavesIpc({ ipcMain, config, log, sendToRenderer, version: app.getVersion(), isGameActive: () => launchSequenceActive });
savesHandlers.scheduleStartupBackup();

// System: power off/reboot/suspend, sleep timer, quit.
registerSystemPowerIpc({ ipcMain, systemPower, sendToRenderer, quit: () => app.quit() });
registerClipboardIpc({ ipcMain, clipboard, log });

// Diagnostics + Log.
registerDiagnosticsIpc({
    ipcMain, log, safeList, logFile, startupTimeline,
    extraLogs: [
        path.join(dataHome(), 'launchers-launcher-watcher.log'),
        path.join(dataHome(), 'launchers-launcher-bt-trigger.log'),
    ],
    exportHeader: `Launchers Launcher ${app.getVersion()} · Electron ${process.versions.electron} · ${os.hostname()}`,
    appInfo: () => electronAppInfo({ app, gpuReason: gpu.reason, ozone: ozone.platform, desktop: desktopEnv() }),
    onHostInstall: (active) => {
        hostInstallActive = active;
        if (!active) foregroundGuard.schedule(); // bring the launcher back from behind the (closed) password dialog
    },
});

// Update + settings restore + "What's new".
registerUpdateIpc({ ipcMain, log, sendToRenderer, safeList, config, repoRoot: __dirname, relaunch, version: app.getVersion() });

// ═══ 6. Lifecycle ════════════════════════════════════════════════════════════════════════════

app.whenReady().then(async () => {
    startupTimeline.mark('appReady');
    // Align the sidecar files with the stored config (for a hand-edited config / fresh clone).
    resyncSidecars({ prefs, mainController, tvModeEnter, autostart, xdgAutostart, repoRoot: __dirname, log });
    if (!safeMode.safe) startupOutputs.maybePowerOnTv(log); // as early as possible: the TV may wake up during boot
    // Outputs FIRST, window ONLY AFTER: a window that loses its output WHILE OPENING never shows up
    // ("no picture, it only turned off a monitor", Electron 44). Timeout: a stuck kscreen-doctor/pactl
    // must not hold it back.
    if (!safeMode.safe) {
        await withTimeout(startupOutputs.applyStartupOutputs(log), STARTUP_OUTPUTS_MAX_WAIT_MS, 'startup-outputs')
            .catch((err) => log(`Startup outputs error: ${err && err.message ? err.message : err}`));
        startupTimeline.mark('outputsApplied');
    }
    createWindow();
    startupTimeline.mark('windowCreated');
    // Native ↔ flatpak self-repair; `launchers-changed` on change.
    launcherVariants.repairLauncherVariants().catch(() => {});
    startLauncherWatchers();
    // We got this far → clear a self-update rollback marker (bootstrap.js).
    if (config.get('pendingUpdateRollback', null)) config.set('pendingUpdateRollback', null);
    // Command self-test: only missing commands are logged.
    selftest.checkCommands().then((results) => {
        const missing = results.filter((r) => !r.ok).map((r) => r.cmd);
        if (missing.length) log(`[selftest] missing command(s): ${missing.join(', ')}`);
    }).catch((err) => log(`[selftest] error: ${err.message}`));
    // Refresh the Lutris quick-launch bar at startup too, not only after the first game closes.
    recentGamesMerge.refreshLutrisRecentMirror();
    // One-time startup steps of the emulator descriptors (e.g. the melonDS flatpak sandbox sync).
    for (const [id, src] of Object.entries(emulatorSources)) {
        if (!src.onStartup) continue;
        Promise.resolve().then(() => src.onStartup({ log }))
            .catch((err) => log(`${src.label || id} startup step error: ${err && err.message ? err.message : err}`));
    }
});

// Shared shutdown cleanup. `app.exit()` SKIPS `will-quit` — so the relaunch paths and the global
// error handler of `bootstrap.js` call it EXPLICITLY (otherwise e.g. the do-not-disturb `kde-inhibit`
// child process could stay behind).
function forceQuitCleanup() {
    coverMisses.flush();
    outputHandlers.abandonPendingMonitor();
    systemPower.clearSleepTimer();
    doNotDisturb.stop();
    scanPool.terminate();
    evdevPads.stop();
}

// Relaunch (successful update / config restore / repeated renderer crash). `exit(0)` is the
// `bin/launchers-launcher-watcher.sh` convention: do NOT restart it again.
/** @param {string} reason @param {(msg: string) => void} [logFn] */
function relaunch(reason, logFn = log) {
    logFn(reason);
    forceQuitCleanup();
    app.relaunch();
    app.exit(0);
}

app.on('will-quit', () => {
    safeModeLib.markHealthy(); // normal exit = not a crash
    forceQuitCleanup();
});
app.on('window-all-closed', () => app.quit());

module.exports = { forceQuitCleanup };
