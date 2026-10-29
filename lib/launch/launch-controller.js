// @ts-check
'use strict';

// The window state machine of launching a launcher/game: spawn + spawn watchdog, hiding the launcher window (on `blur`, with an
// early-blur guard) and bringing it back (`bringToFront`), watching an external (not spawned by us) process. Gotchas: early blur,
// the `steam` wrapper's `exit 0`, `setOpacity` is a no-op under Wayland. Does not know Electron/IPC: the caller passes `sendToRenderer`,
// a `getWindow()` getter and callbacks; `spawn`, the window and the timers are injectable (`test/launch/launch-controller.test.js`).
// Background: docs/dev/launching.md#the-launch-state-machine

const { spawn: realSpawn } = require('child_process');
const { sessionEnv } = require('../exec.js');
const { isSteamLauncher } = require('../launchers/steam-library.js');
const launchErrors = require('./launch-errors.js');
const { flatpakRunAppId } = require('../flatpak.js');
const { LAUNCH_TIMINGS } = require('../timings.js');

// The state machine's timers (spawn watchdog, blur guard, hide fallback, bring back, quick exit, external-PID watch) — values +
// meaning in `LAUNCH_TIMINGS` of lib/timings.js; `createLaunchController({ timings })` may override them (tests).
const DEFAULT_TIMINGS = LAUNCH_TIMINGS;

// The launched child's env: the launcher starts under the systemd/udev-triggered watcher, where the Wayland/D-Bus session variables
// may be missing — `sessionEnv({ full })` of `lib/exec.js` fills them in (the base Wayland trio + the D-Bus/desktop/XAUTHORITY extras
// needed to spawn a game).
function childEnv() {
    return sessionEnv({ full: true });
}

function createLaunchController(deps) {
    const {
        getWindow,              // () => BrowserWindow | null (the window may be recreated)
        log,                    // (msg) => void
        sendToRenderer,         // (channel, payload) => void (guarded)
        recordUsage,            // (appId) => void
        recordUsageDuration = () => null, // (appId, ms) => total ms | null  (in bringToFront(), the session length)
        todayPlaytimeMs = () => null,     // () => today's total playtime in ms (the measure of the playtime reminder)
        recordRecentGame,       // (meta) => boolean  (did it write — if true the caller pushes)
        invalidateRecent,       // (appId|null) => void (clears the derived "recently played" cache — the closed session's appId, so only the affected source is invalidated)
        launchersPayload,       // () => a running-changed / app payload
        onLauncherShown,        // () => void (e.g. start the "● RUNNING" poller)
        onLauncherHidden,       // () => void (e.g. stop the poller)
        onLaunchSequenceStart = () => {}, // () => void (a launch started — the main window hands over the screen)
        onLaunchSequenceEnd = () => {},   // () => void (the launcher is back — the foreground guard is armed again)
        activateWindow,         // (query) => Promise<boolean> (KWin WindowsRunner)
        raiseSteamBigPicture,   // () => Promise<void>
        killFlatpakApp = async () => false, // (flatpakId) => Promise<boolean> — for `killActiveGame()`
        isFlatpakInstalled = async () => null, // (appId) => Promise<boolean|null> — to find the reason of a quick exit
        debugChild = false,     // log the child's stdout/stderr
        spawn = realSpawn,      // injectable for tests
        timings,                // overrides of DEFAULT_TIMINGS (tests: short values)
        // MONOTONIC clock for every elapsed-time measurement: the wall clock (`Date.now()`) would count suspend time as playtime,
        // and a clock adjustment (NTP) could cause a false timeout.
        now = () => performance.now(),
    } = deps;
    const T = { ...DEFAULT_TIMINGS, ...(timings || {}) };

    // --- Hiding the window on launch ---
    let hideFallbackTimer = null;
    let earlyBlurTimer = null;
    let blurHideHandler = null;
    let launchStartedAt = 0;

    function hideLauncherNow() {
        cancelLauncherHide();
        onLauncherHidden();
        const win = getWindow();
        if (win && !win.isDestroyed()) win.hide();
    }

    function scheduleLauncherHide() {
        cancelLauncherHide();
        const win = getWindow();
        if (!win) return;
        launchStartedAt = now();
        blurHideHandler = () => {
            const elapsed = now() - launchStartedAt;
            if (elapsed >= T.hideMinMs) {
                hideLauncherNow();
                return;
            }
            // Early blur: wait until the minimum, and only hide if we have still lost the focus by then (so the app
            // really took it, not a passing OSD).
            if (!earlyBlurTimer) {
                earlyBlurTimer = setTimeout(() => {
                    earlyBlurTimer = null;
                    const w = getWindow();
                    if (w && !w.isDestroyed() && !w.isFocused()) hideLauncherNow();
                }, T.hideMinMs - elapsed + 50);
            }
        };
        win.on('blur', blurHideHandler); // not `once`: keep listening after an early blur
        hideFallbackTimer = setTimeout(hideLauncherNow, T.hideFallbackMs);
    }

    function cancelLauncherHide() {
        if (hideFallbackTimer) { clearTimeout(hideFallbackTimer); hideFallbackTimer = null; }
        if (earlyBlurTimer) { clearTimeout(earlyBlurTimer); earlyBlurTimer = null; }
        const win = getWindow();
        if (blurHideHandler && win && !win.isDestroyed()) win.removeListener('blur', blurHideHandler);
        blurHideHandler = null;
    }

    // --- Playtime measurement ---
    // One launch sequence is active at a time (the launcher hides, one game runs), so a module-level pair is enough. ONLY the actual
    // `spawn` / a successful `switchToRunning` sets it — not the spawn watchdog / immediate error branch (where 'spawn' never fired), so
    // there is no false measurement. `bringToFront()` runs on every exit path → the measurement is always closed.
    let sessionAppId = null;
    let sessionStartedAt = 0;

    function beginPlaytimeSession(appId) {
        sessionAppId = appId;
        sessionStartedAt = now();
    }

    // Returns the summary of the closed session (`{ appId, sessionMs, totalMs }`, the `app-closed` payload — the renderer's session
    // summary toast), or `null` if there was no session.
    function endPlaytimeSession() {
        if (!sessionAppId || !sessionStartedAt) { sessionAppId = null; return null; }
        const appId = sessionAppId;
        const sessionMs = now() - sessionStartedAt;
        let totalMs = null;
        try { totalMs = recordUsageDuration(appId, sessionMs); } catch (err) { /* best effort */ }
        sessionAppId = null;
        sessionStartedAt = 0;
        let todayMs = null;
        try { todayMs = todayPlaytimeMs(); } catch (err) { /* best effort */ }
        return { appId, sessionMs, totalMs: typeof totalMs === 'number' ? totalMs : null, todayMs: typeof todayMs === 'number' ? todayMs : null };
    }

    // --- Running game ("▶ Back to the game") ---
    // A game/app launched from the launcher and still running: after sleep / Alt-Tab the launcher may come to the front while the game is
    // alive — the home screen's Continue bar then shows a "BACK" item. The session opens on `spawn` and closes in `bringToFront()`; changes
    // go out as an `active-session` push.
    /** @type {{ appId: string, name: string, cover: string|null, queries: string[] } | null} */
    let activeSession = null;

    // Queries tried for activating the window: the game name, the flatpak app id, the command name.
    function windowQueries(cmd, args, meta) {
        const q = [];
        if (meta && meta.wmMatch) q.push(String(meta.wmMatch));
        if (meta && meta.name) q.push(String(meta.name));
        const fp = cmd === 'flatpak' ? flatpakRunAppId(args) : null;
        if (fp) q.push(fp);
        else if (cmd) q.push(String(cmd).split('/').pop() || '');
        return [...new Set(q.filter(Boolean))];
    }

    function setActiveSession(appId, cmd, args, meta) {
        activeSession = {
            appId, name: (meta && meta.name) ? String(meta.name) : appId, cover: (meta && meta.cover) || null,
            queries: windowQueries(cmd, args, meta),
        };
        sendToRenderer('active-session', publicSession());
    }

    function publicSession() {
        return activeSession ? { appId: activeSession.appId, name: activeSession.name, cover: activeSession.cover } : null;
    }

    function clearActiveSession() {
        if (!activeSession) return;
        activeSession = null;
        sendToRenderer('active-session', null);
    }

    // ✕ on the home screen's "BACK" item: activates the running game's window (KDE: KWin; no window activation on GNOME), then hides the
    // launcher so the game is visible. `{ ok, activated }`; no session → ok: false.
    async function resumeActiveSession() {
        const s = activeSession;
        if (!s) return { ok: false, activated: false };
        let activated = false;
        for (const q of s.queries) {
            try {
                if (await activateWindow(q)) { activated = true; break; }
            } catch (err) {
                log(`Switching back to the game error (${q}): ${err.message}`);
            }
        }
        log(`Switching back to the game: ${s.appId} (${activated ? 'window activated' : 'no window to activate — the launcher is hidden'})`);
        hideLauncherNow();
        return { ok: true, activated };
    }

    // --- Bringing the launcher back ---
    // A stored, overridable timer: the `child` 'close' AND 'error' branches (or a wrapper quickly `exit 0`-ing + the real exit) must not
    // schedule two separate `bringToFront`s.
    let bringToFrontTimer = null;

    // We fully hid the launcher window on `blur` while the game was running. As soon as the game exits, the window is put BACK immediately
    // (fullscreen, BUT without focus) — so the user does not see the desktop until the delayed `bringToFront()`, but the renderer's
    // `loadingOverlay` still being shown (branded loading screen). Taking the focus + `app-closed` (carousel back) STAYS delayed: the `steam`
    // wrapper may `exit 0` while Steam/the game is still loading — we do not want to jump in front of it. `showInactive()` (not `show()`),
    // so we do not steal the focus from a window still in front.
    function coverDesktopWithLauncher() {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        // If it is already visible (e.g. an immediate spawn error, or the `steam` wrapper's early `exit 0` where we did not even hide it), do
        // not touch the focus — only bring a hidden window back.
        if (typeof win.isVisible === 'function' && win.isVisible()) return;
        if (typeof win.showInactive === 'function') win.showInactive();
        else win.show();
        win.setFullScreen(true);
    }

    function scheduleBringToFront(delay = T.bringToFrontMs) {
        coverDesktopWithLauncher();
        if (bringToFrontTimer) clearTimeout(bringToFrontTimer);
        bringToFrontTimer = setTimeout(() => {
            bringToFrontTimer = null;
            bringToFront();
        }, delay);
    }

    function bringToFront() {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        if (bringToFrontTimer) { clearTimeout(bringToFrontTimer); bringToFrontTimer = null; }
        cancelLauncherHide();
        clearExternalWatch();
        activeKillTarget = null;
        // `endPlaytimeSession()` below resets `sessionAppId` — save it first so we can tell `invalidateRecent()` WHICH launcher closed (null on a
        // spawn error/watchdog timeout, since no session ever started — correctly: then there is nothing to invalidate, the derived playtime
        // files cannot have changed).
        const closedAppId = sessionAppId;
        const summary = endPlaytimeSession(); // the session's length into `usage[appId].totalMs`
        clearActiveSession();
        onLaunchSequenceEnd(); // the launch sequence is over — the foreground guard is armed again
        win.show();
        win.setFullScreen(true);
        win.focus();
        sendToRenderer('app-closed', summary || undefined);
        // Fresh payload: the quick-launch bar (steam/retroarch derived) should refresh after a game even if the "● RUNNING" set did not change
        // meanwhile. By passing `closedAppId` the caller (usage.invalidateDerivedRecent) ONLY clears the actually affected source, not all 6.
        invalidateRecent(closedAppId);
        sendToRenderer('running-changed', launchersPayload());
        onLauncherShown();
    }

    // --- Controller force close ("kill-watch") ---
    // `meta.killable` (+ `meta.flatpakId`) tells `spawnGame()` that the launch is eligible for the PS/Home force close, and that the launcher
    // window must NOT be hidden IN THIS SESSION. While `activeKillTarget` is non-null, the renderer (on the `app-launched` `{ killable: true }`
    // push) treats PS as "close the game".
    // ⚠️ The renderer loop of a `hide()`-n (unmapped) Electron window stops (`setBackgroundThrottling(false)` did not help on the machine) —
    // so for a killable session `scheduleLauncherHide()` is NOT called; with a visible window gamepad polling runs even without focus.
    // Background: docs/dev/launching.md#kill-watch-sessions-melonds
    let activeKillTarget = null;

    // Force-closes the focused killable game (from the renderer's `kill-active-game` IPC, on PS/Home). `flatpak kill` — NOT `child.kill()` of
    // the spawned process — because killing the `flatpak run` wrapper does not necessarily stop the actual app inside the sandbox. The
    // actual return runs on the usual `child.on('close')` → `bringToFront()` path, not duplicated here. With the native variant
    // (`flatpakId: null`) there is no wrapper — the spawned process is the emulator itself and gets `SIGTERM`.
    async function killActiveGame() {
        if (!activeKillTarget) return false;
        if (!activeKillTarget.flatpakId) {
            const child = activeKillTarget.child;
            if (!child || child.exitCode != null) return false; // already exited
            killRequested = true;
            log(`Controller force-close (native): pid ${child.pid}`);
            try { return child.kill('SIGTERM'); } catch (err) { log(`Force-close error: ${err.message}`); return false; }
        }
        killRequested = true; // the 137 exit must not count as a "failed launch"
        log(`Controller force-close: ${activeKillTarget.flatpakId}`);
        try {
            return await killFlatpakApp(activeKillTarget.flatpakId);
        } catch (err) {
            log(`Force-close error: ${err.message}`);
            return false;
        }
    }

    // --- Spawn lifecycle ---
    // `runningChild` is only tracked (for the spawn watchdog's identity check) — it is NOT killed when the launcher quits (lost game
    // progress is worse than an orphan process).
    let runningChild = null;
    let spawnWatchdog = null;
    let killRequested = false;
    let activeLaunch = null; // { cmd, args } — the latest spawnGame (for cancelLaunch's flatpak ID)

    function clearSpawnWatchdog() {
        if (spawnWatchdog) { clearTimeout(spawnWatchdog); spawnWatchdog = null; }
    }

    // Every `launch-*` handler (lib/ipc/launch-ipc.js) calls this — for all of them the spawned process is the running app/emulator/client
    // itself, `close` = an actual exit (the Steam wrapper's early `exit 0` is the known exception).
    function spawnGame(appId, cmd, args, meta, extra) {
        log(`Spawning: ${cmd} ${args.join(' ')}`);
        activeLaunch = { cmd, args };

        // The launcher does NOT leave fullscreen — it keeps covering the desktop/taskbar while loading; the launched app's window comes on top
        // because of KWin stacking, then on `blur` (or the fallback timer) we hide fully.
        onLaunchSequenceStart(); // from now on a main-window blur means "game is starting", not "something pushed in"
        const killable = !!(meta && meta.killable);
        sendToRenderer('app-launched', killable ? { killable: true } : undefined);
        if (killable) {
            // scheduleLauncherHide() is NOT called: the window stays "shown" for the whole session so the renderer's gamepad polling (for the PS
            // force close) is guaranteed to run — see "Controller force close" above. The "● RUNNING" poller is stopped as usual for a hidden
            // window (`bringToFront()` restarts it at the end of the session anyway).
            activeKillTarget = { flatpakId: meta.flatpakId || null, child: null };
            onLauncherHidden();
        } else {
            scheduleLauncherHide();
        }

        const child = spawn(cmd, args, {
            stdio: ['ignore', debugChild ? 'pipe' : 'ignore', debugChild ? 'pipe' : 'ignore'],
            env: extra && extra.env ? { ...childEnv(), ...extra.env } : childEnv(),
        });

        runningChild = child;
        if (activeKillTarget && killable) activeKillTarget.child = child;
        killRequested = false;
        const spawnedAt = now();
        clearSpawnWatchdog();
        spawnWatchdog = setTimeout(() => {
            spawnWatchdog = null;
            if (runningChild !== child) return; // closed meanwhile / new launch
            log(`Spawn watchdog: ${cmd} did not start within ${T.spawnWatchdogMs} ms`);
            cancelLauncherHide();
            scheduleBringToFront(0);
            sendToRenderer('app-error', { appId, ...launchErrors.spawnTimeoutInfo(cmd, args) });
        }, T.spawnWatchdogMs);

        if (debugChild && child.stdout && child.stderr) {
            child.stdout.on('data', (d) => log(`[stdout] ${String(d).trimEnd()}`));
            child.stderr.on('data', (d) => log(`[stderr] ${String(d).trimEnd()}`));
        }

        child.on('spawn', () => {
            clearSpawnWatchdog();
            log(`Spawned OK, PID: ${child.pid}`);
            recordUsage(appId);
            beginPlaytimeSession(appId);
            setActiveSession(appId, cmd, args, meta);
            if (meta && recordRecentGame(meta)) {
                sendToRenderer('running-changed', launchersPayload()); // refresh the quick-launch bar
            }
        });

        child.on('error', (err) => {
            clearSpawnWatchdog();
            // If a NEW spawnGame() overwrote `runningChild` meanwhile (e.g. a slowly closing earlier wrapper process still sends 'error' after it),
            // this is NO LONGER the current session — bringToFront/cancelLauncherHide would wrongly close the OTHER, actually running game.
            if (runningChild !== child) { log(`Spawn error (elavult session): ${err.message}`); return; }
            runningChild = null;
            log(`Spawn error: ${err.message}`);
            cancelLauncherHide();
            scheduleBringToFront();
            sendToRenderer('app-error', { appId, ...launchErrors.spawnErrorInfo(err, cmd) });
        });

        child.on('close', (code, signal) => {
            clearSpawnWatchdog();
            // Same guard as in the 'error' branch — the close of a stale (overwritten) session must not bring back/close the launcher from under
            // ANOTHER, still running game.
            if (runningChild !== child) { log(`Closed (elavult session), code: ${code}, signal: ${signal}`); return; }
            runningChild = null;
            log(`Closed, code: ${code}, signal: ${signal}`);
            cancelLauncherHide();
            scheduleBringToFront();
            const elapsedMs = now() - spawnedAt;
            if (launchErrors.isQuickFailure({ code, signal, elapsedMs, quickExitMs: T.quickExitMs, killRequested })) {
                reportQuickExit(appId, cmd, args, code, elapsedMs);
            }
        });

        return child;
    }

    // Cancel a launch on the loading screen (the renderer's hold ○): if OUR spawned child is still alive, stop it (flatpak: `flatpak kill`,
    // otherwise SIGTERM — like the kill-watch), and the launcher comes back immediately. If the process has already detached (the `steam`
    // wrapper `exit 0`-ed, we switched to a running launcher), only the launcher comes back — we cannot stop a game that is already starting;
    // the caller reports that (`killed: false`) to the user. Because `runningChild` is reset, the child's later 'close' does not schedule
    // another bring-back as a "stale session". `{ killed }`.
    async function cancelLaunch() {
        const child = runningChild;
        const launch = activeLaunch;
        let killed = false;
        clearSpawnWatchdog();
        if (child && child.exitCode == null && child.signalCode == null) {
            killRequested = true; // the 137/SIGTERM exit must not count as a "failed launch"
            runningChild = null;
            try {
                const flatpakId = launch && launch.cmd === 'flatpak' ? flatpakRunAppId(launch.args) : null;
                killed = flatpakId ? await killFlatpakApp(flatpakId) : child.kill('SIGTERM');
            } catch (err) {
                log(`Cancel launch error: ${err.message}`);
            }
        }
        log(`Launch cancelled (${killed ? 'the process was stopped' : 'no process to stop'})`);
        cancelLauncherHide();
        bringToFront();
        return { killed: !!killed };
    }

    // Quick exit with an error code → find the likely reason (is the flatpak installed) + `app-error`.
    // Async (flatpak info), best effort — bringing the launcher back does not depend on it.
    async function reportQuickExit(appId, cmd, args, code, elapsedMs) {
        let flatpakInstalled = null;
        const appIdFlatpak = cmd === 'flatpak' ? flatpakRunAppId(args) : null;
        if (appIdFlatpak) {
            try { flatpakInstalled = await isFlatpakInstalled(appIdFlatpak); } catch (err) { flatpakInstalled = null; }
        }
        const info = launchErrors.quickExitInfo({ cmd, args, code, flatpakInstalled });
        log(`Launch failed (${appId}): ${info.error} — after ${elapsedMs} ms`);
        sendToRenderer('app-error', { appId, ...info });
    }

    // --- Watching an external (not spawned by us) process ---
    let externalWatchTimer = null;

    function clearExternalWatch() {
        if (externalWatchTimer) { clearInterval(externalWatchTimer); externalWatchTimer = null; }
    }

    // Watching an already running process: when the PID disappears, bring the launcher back — the same end state as `child.on('close')`.
    function watchExternalProcess(pid, appId) {
        clearExternalWatch();
        if (!pid) {
            log(`External process (${appId}): no PID, fallback bring-back in ${T.hideFallbackMs} ms`);
            scheduleBringToFront(T.hideFallbackMs);
            return;
        }
        const startedAt = now();
        externalWatchTimer = setInterval(() => {
            let alive = false;
            try { process.kill(pid, 0); alive = true; } catch (err) { alive = false; }
            if (alive && now() - startedAt < T.externalWatchMaxMs) return;
            clearExternalWatch();
            log(`External process (${appId}, pid ${pid}) ended — launcher back`);
            scheduleBringToFront();
        }, T.externalWatchMs);
    }

    // For an ALREADY RUNNING launcher no new instance is started, we only switch to its window. There is no `spawn`, so no
    // `child.on('close')` — the external-PID watcher brings the launcher back. Steam exception: the switch also turns on Big Picture.
    async function switchToRunning(launcher, pid) {
        const appId = launcher.id;
        const isSteam = isSteamLauncher(launcher);
        log(`Already running: ${appId} (pid ${pid || '?'}) — switching${isSteam ? ' + Big Picture' : ''}`);
        onLaunchSequenceStart();
        sendToRenderer('app-launched');
        scheduleLauncherHide();

        let raised = false;
        try {
            if (isSteam) {
                await raiseSteamBigPicture();
                raised = true;
            } else {
                raised = await activateWindow(launcher.wmMatch || launcher.name);
            }
        } catch (err) {
            log(`Switch error (${appId}): ${err.message}`);
        }

        if (!raised && !isSteam) {
            log(`No window to activate (${appId}) — falling back to a normal launch`);
            spawnGame(appId, launcher.cmd, launcher.args);
            return;
        }

        recordUsage(appId);
        beginPlaytimeSession(appId);
        setActiveSession(appId, launcher.cmd, launcher.args, { name: launcher.name, wmMatch: launcher.wmMatch });
        watchExternalProcess(pid, appId);
    }

    return {
        spawnGame, switchToRunning, bringToFront, hideLauncherNow, cancelLauncherHide, killActiveGame, cancelLaunch,
        getActiveSession: publicSession, resumeActiveSession,
    };
}

module.exports = { createLaunchController, DEFAULT_TIMINGS, childEnv };
