# Launching games and apps

Code: `lib/launch/*` (state machine, window handling, running detection),
`lib/ipc/launch-ipc.js` (the `launch-*` handlers), `lib/ipc/launcher-manage-ipc.js`,
`lib/ipc/launcher-variant-ipc.js`, `lib/ipc/finish-setup.js`.

## Contents

- [Design: who knows what](#design-who-knows-what)
- [The launch state machine](#the-launch-state-machine)
- [Foreground guard and Do not disturb](#foreground-guard-and-do-not-disturb)
- [Switching to an already-running launcher](#switching-to-an-already-running-launcher)
- [Running detection and the ● RUNNING badge](#running-detection-and-the--running-badge)
- [Kill-watch sessions (melonDS)](#kill-watch-sessions-melonds)
- [Cancel, resume, session summary](#cancel-resume-session-summary)
- [Launch handlers and argument builders](#launch-handlers-and-argument-builders)
- [Per-game launch options](#per-game-launch-options)
- [Failed launches](#failed-launches)
- [Window activation and moving (KDE)](#window-activation-and-moving-kde)

## Design: who knows what

`createLaunchController(deps)` knows neither Electron nor IPC: it gets a `getWindow()` getter
(the window can be recreated), the guarded `sendToRenderer`, callbacks (`recordUsage`,
`recordRecentGame`, `invalidateRecent`, `launchersPayload`, `onLauncherShown/Hidden`,
`onLaunchSequenceStart/End`, `activateWindow`, `raiseSteamBigPicture`) and optionally `spawn` /
`timings` / `now` overrides for tests. The handler bodies in `launch-ipc.js` get `spawnGame` /
`switchToRunning` injected the same way, plus pre-bound machine-specific thunks. `main.js` only wires
`ipcMain.on(CH.x, (e, p) => launchHandlers.x(p))` — in practice via the `register*Ipc` functions.

**Elapsed time uses a monotonic clock** (`deps.now`, default `performance.now()`, CLOCK_MONOTONIC):
blur-hide minimum, quick-exit detection, external-PID watching and **playtime**. `Date.now()` used to
count a suspend during a game as playtime. Timestamps written into the config remain `Date`.

## The launch state machine

The machine lives in `lib/launch/launch-controller.js`: `spawnGame` + the spawn watchdog, hiding the window on blur (with the
early-blur guard), `bringToFront`, `coverDesktopWithLauncher` and `watchExternalProcess`. It knows neither Electron nor IPC (the
caller passes `sendToRenderer`, a `getWindow()` getter and callbacks; `spawn`, the window and the timers are injectable). The
launched `child` is **not** killed when the launcher quits (game progress would be lost).

`spawnGame(appId, cmd, args, meta?)` is shared by `launch-app`, `launch-steam-game`,
`launch-heroic-game`, `launch-retroarch-game` and all emulator launches. `meta`
(`{ launcherId, key, name, cover, kind, params, killable?, flatpakId? }`) is given only for sources
whose "recently played" is **recorded at launch time**; derived sources (Steam, RetroArch, PCSX2,
RPCS3, PPSSPP, DuckStation) have none.

1. The window **stays fullscreen throughout** (never `setFullScreen(false)`), so during the loading
   gap the opaque UI and the loading overlay hide the desktop/taskbar. The launched app's window lands
   above the launcher in KWin's stacking.
2. When the app has taken focus, `scheduleLauncherHide()` fully hides the launcher
   (`hide()` — unmap, not `minimize()`), on the window's **`blur`** or at the latest at the fallback
   timer (`hideFallbackMs`), so a windowed target (Heroic, RetroArch windowed) is never covered.
3. **Early-blur guard:** within `hideMinMs` after `spawn` a blur does not hide immediately (a
   notification or a KWin OSD during loading would otherwise hide the launcher together with the
   overlay → desktop flash). An `earlyBlurTimer` hides after the minimum only if the window is not
   focused. The blur listener is therefore `on`, not `once`.
4. `cancelLauncherHide()` removes the listener and both timers; it is called at the start of
   `bringToFront()` and in the `error` / `close` branches (the `steam` wrapper may exit 0 quickly
   while Steam keeps running).
5. **Spawn watchdog** (`spawnWatchdogMs`): no `spawn`/`error` event → `app-error` +
   `scheduleBringToFront(0)`. `runningChild` identifies the child so a stale session cannot act.
6. **Return:** `scheduleBringToFront()` (from `close` / `error`, overridable timer — don't let both
   branches schedule one each) first calls **`coverDesktopWithLauncher()`**: `showInactive()` (not
   `show()`: no focus, so a still-loading Steam/game isn't disturbed) + `setFullScreen(true)`, so
   between the game closing and `bringToFront()` (~1.5 s) the user sees the renderer's opaque
   `loadingOverlay`, never the desktop. It is skipped if the window was never hidden. Then
   `bringToFront()` = `show()` + `setFullScreen(true)` + `focus()`.
7. The launched child is **not killed when the launcher quits** (lost game progress).
8. `BrowserWindow.setOpacity()` is a **no-op on Linux/Wayland** (verified) — don't build on it.
   While the window is hidden the renderer's `requestAnimationFrame` (gamepad polling) pauses; that
   is fine because the game owns the controller, except in kill-watch sessions below. After `show()`
   the window `focus` handler and `onAppClosed` poke `navigator.getGamepads()`.
9. **Renderer watchdog** (`LAUNCH_WATCHDOG_MS` 45 s in `renderer/gamepad.js`): if `isLaunching` is
   still true while the window is **visible** and neither `app-closed` nor `app-error` arrived, it
   releases the stuck state with a toast; on a hidden window it re-arms. Keep it longer than the main
   side timers.
10. Known, accepted: after an early `steam` wrapper exit the launcher, no longer hiding, may jump in
    front of a still-loading Steam 1.5 s later.

`app-closed` carries the session summary `{ appId, sessionMs, totalMs }`; the renderer shows
"▶ NAME — 1h 12m · TOTAL 14h 3m" (under a minute: the plain "back to the launcher" text). The loading
screen also shows the game cover (`showLoading(name, action, launcherId, cover)`).

## Foreground guard and Do not disturb

- **Foreground guard** (`lib/launch/foreground-guard.js`, `createForegroundGuard`): on `blur`,
  `schedule()` (500 ms debounce); `guard()` retakes the foreground only if `alwaysOnTop` is on, **no
  launch sequence is active**, the window is visible and unfocused: `moveTop()` + `focus()` + a
  fire-and-forget `windowActivate.activateWindow('Launchers Launcher')` (KWin focus-stealing prevention
  on Wayland). The launch-sequence flag is set by the controller's `onLaunchSequenceStart` (at
  `app-launched`, synchronously) / `onLaunchSequenceEnd` (in `bringToFront`) — this separates "a game
  is starting, hand over the screen" from "an autostarted Spotify barged in after login". Kiosk
  principle: without a game, the screen always belongs to the launcher. **Why closing apps in `tvMode` is not enough:** `tv-mode-enter.sh` closes
  the listed apps at the trigger moment, but e.g. Spotify starts *later* (a login autostart), after the trigger has run; the guard reacts at the moment of the
  focus theft whoever took it. **It does not affect:** Settings / Games panel / screensaver (same renderer window, no `blur`); a game launch or run
  (`launchSequenceActive` / `!isVisible()` → a no-op); the TV-exit `app.quit()` (the 500 ms-delayed `blur` finds the window destroyed). The guard is also paused
  during the in-app package install so it doesn't steal focus from the polkit dialog.
- **Do not disturb** (`lib/launch/do-not-disturb.js`, `createDoNotDisturb`) uses the same two
  callbacks. **KDE:** `which kde-inhibit` (once, cached) →
  `spawn('kde-inhibit', ['--notifications', 'sleep', '86400'], { detached: true })`; `stop()` kills the
  process group (`process.kill(-pid, 'SIGTERM')`, falling back to the pid on ESRCH); an internal
  `wanted` flag guards the async `which` race. **GNOME:** the `show-banners` gsetting —
  `start()` sets it `false` only if it was `true` (the user's own DND is never switched back on);
  `stop()` runs a detached `gsettings set … true` (so it works even before `app.exit()`). Because that
  setting is persistent, a marker file (`~/.local/share/launchers-launcher/gnome-dnd-active`) records that
  *we* turned it off and `recover()` restores it at startup after a crash. `systemd-inhibit` is
  not an alternative (it blocks sleep/idle, not notifications). The `doNotDisturb` pref gates `start()`;
  `stop()` always runs. A `will-quit` cleanup stops a detached inhibit.

## Switching to an already-running launcher

`launch-app` is async: `running.isLauncherRunning(launcher)` — if it already runs, `switchToRunning`
instead of `spawnGame`:

- Same experience (`app-launched` + loading overlay + hide; the text says "SWITCH").
- Raise the window: Steam → `steam steam://open/bigpicture` (the running client switches to Big
  Picture and comes forward); anything else → `activateWindow(launcher.wmMatch || launcher.name)`. If
  a non-Steam launcher has no activatable window → **fall back to `spawnGame`** (new instance). On
  GNOME there is no public API to activate a foreign window, so it falls back / hides.
- `usage.recordUsage()` as if it had been launched.
- **Return on exit:** no `close` event (we did not spawn it), so `watchExternalProcess(pid)` polls
  `process.kill(pid, 0)` every 1.5 s (max 12 h) and schedules the bring-to-front when the pid is gone;
  without a pid a fallback timer is used. Known limit: Steam's "Exit Big Picture" (to desktop mode)
  does not kill `steam.pid`, so the launcher returns only when Steam is closed completely (accepted on
  a kiosk).

## Running detection and the ● RUNNING badge

`lib/launch/running.js` `isLauncherRunning(launcher, homeDir)` → `{ running, pid }`:

- **Native Steam:** `steamClientPid` from `~/.steam/steam.pid`.
- **Any flatpak launcher, Steam included:** `flatpak ps --columns=application,pid`
  (`parseFlatpakPs`, tab-separated, language-independent). **The flatpak Steam's `steam.pid` is a PID in
  the sandbox's namespace and meaningless on the host** — a running flatpak Steam used to look
  stopped.
- **Native binary:** `ps -eo pid=,comm=` with an exact match on the kernel's 15-character `comm`.
- A `createProbe()` memoises the external commands so one `detectRunningLaunchers` round runs
  `flatpak ps` and `ps` once, not once per launcher. Every error means "not running".

`lib/launch/running-poll.js` `createRunningPoll` keeps the `Set` of running ids; `start()` when the
window is shown, `stop()` when hidden (default every 4 s). `refresh()` pushes
**`running-changed`** only when the set actually changed (`sig()` compare), deliberately a channel
separate from `launchers-changed` (which would show the renderer's "ORDER SAVED" toast). The renderer
handles it with the targeted `refreshRunningState()` (toggle `.card-running` on existing DOM +
`renderRecentBar()`), not a full `renderCards()` — unless the launcher list changed too
(`cards.length !== launchers.length + 1`). The payload is `launchersWithUsage()`.

## Kill-watch sessions (melonDS)

Some emulators have no controller exit of their own; for those the descriptor's
`launch.killable` makes the recent-meta carry `killable: true` + `flatpakId`, and PS/Home during the
session force-closes the app. Currently **only melonDS** (a native melonDS gets `flatpakId: null`, so
`killActiveGame()` sends `SIGTERM` to the spawned process instead of `flatpak kill`). An emulator
without a `meta` cannot join without extending it.

The hard-won lessons:

- A hidden Electron window's renderer render loop **stops in practice**. The first attempt (hide +
  `webContents.setBackgroundThrottling(false)`, which in theory keeps Page Visibility `visible`)
  did **not** work on the machine with a controller: PS never reached the renderer.
- **The working solution: do not hide the window at all during a killable session**
  (`spawnGame` skips `scheduleLauncherHide` for `meta.killable`). The emulator's own fullscreen still
  stacks above it, exactly like every launcher in the instant before blur. A visible window's
  rAF/gamepad polling runs regardless of focus. The ● RUNNING poller is stopped manually
  (`onLauncherHidden()`); `bringToFront()` at the end restores it.
- The renderer sets `killWatchActive` from `app-launched { killable: true }`; while
  `isLaunching && killWatchActive`, `pollGamepad()` runs `handleKillWatchInput(gp)` on its **own** edge
  object (`killWatchButtonStates`, synced to the current PS state at `onAppLaunched`) and calls
  `kill-active-game` on PS.
- The 45 s renderer watchdog must treat `killWatchActive` as "the app took over" (`document.hidden`
  stays false) or it would raise a false failed-launch toast.
- The kill itself is **`flatpak kill <appId>`** (`killFlatpakApp`), **not** `child.kill()` — killing the
  `flatpak run` wrapper does not necessarily stop the app inside the sandbox. `killActiveGame()` sets
  `killRequested` and nothing else; return runs through the normal `close` → `bringToFront()` path (no
  duplicated cleanup), and `killRequested` keeps the resulting 137 from being reported as a failed
  launch.

## Cancel, resume, session summary

- **Cancel** (hold ○ for 1 s on the loading screen, `LAUNCH_CANCEL_HOLD_MS`; progress bar in
  `#loadingCancel`): `cancel-launch` → `cancelLaunch()` stops **only our own still-live spawned child**
  (flatpak: `killFlatpakApp`; otherwise `SIGTERM`), nulls `runningChild` so its later `close` is a stale
  session, then `bringToFront()`. If the process already detached (the `steam` wrapper exited 0 /
  we switched to a running launcher) only the launcher returns and the reply is `killed: false` — the
  toast says the game may be starting in the background. Not available in killable sessions (PS is the
  kill there) nor once the game has taken the screen.
- **Resume** ("▶ BACK" in the Continue bar): the controller tracks the live launcher-started game
  (`activeSession`, opened on `spawn` and `switchToRunning`, closed in `bringToFront`), pushed as
  `active-session` `{ appId, name, cover }|null` (plus `get-active-session` at startup). The Continue
  bar then shows a highlighted "▶ BACK" first (even if the bar is switched off); ✕ →
  `resume-active-session`: window activation is tried with `meta.wmMatch`, the game name, the flatpak
  app-id / command name, then `hideLauncherNow()` — **on GNOME or with no activatable window the
  launcher still hides** (the game's fullscreen shows below) and the toast says `activated: false`.
  The 45 s watchdog then relies on the "BACK" item instead of reporting a failed launch. "□ = quit the
  game" is not included (kill-watch for other emulators is deferred).

## Launch handlers and argument builders

`lib/ipc/launch-ipc.js` `createLaunchHandlers(deps)`. Payloads are validated **before**
`spawnGame()`; a missing mandatory field goes through `rejectLaunch(appId, reason, errorKey)` =
`log` + `sendToRenderer('app-error', …)` — otherwise the launcher would hide and the spawn watchdog
would bring it back 6–8 s later with no explanation.

Pure argument builders (exported for tests): `steamGameArgs` (`-gamepadui -tenfoot
steam://rungameid/<id>`), `steamExecSpec(launcher, extraArgs)` (the single native-vs-flatpak Steam
decision; `raiseSteamBigPicture` uses it too), `findSteamLauncher` (built on the single Steam
definition `isSteamLauncher`: id `steam`, native `cmd: steam`, or flatpak `com.valvesoftware.Steam`),
`heroicGameArgs` (`flatpak run … --no-gui heroic://launch?…`), `retroarchGameArgs(core, rom)`,
`lutrisGameArgs` (`lutris:rungameid/<id>` — launch syntax verified live),
`rpcs3GameArgs` (`"%RPCS3_GAMEID%:<titleId>"` — and **deliberately no `--no-gui`**, for RPCS3's Big
Picture Mode).

**The seven path-based emulators** (Ryujinx, PCSX2, Cemu, PPSSPP, Dolphin, melonDS, DuckStation) are
launched through the descriptor in `lib/launchers/emulator-sources.js`: its **`launch`** field
(`gameId(p)`, `args(p)`, `missingReason`, `killable?`; i18n key `err.<id>MissingPath`) plus the
`<x>GameArgs` builder that lives in the emulator's own library module. The shared
`launchEmulatorGame(kind, payload)` checks `path`, derives the id (serial/title id/game id, or a
path-hash fallback), and calls `spawnGame('<kind>-game-<id>', 'flatpak', …)`. The "recently played"
meta is the single generic `emulatorRecentMeta(entry, launch, id, p, flatpakArgs)` — only for
non-`derivedRecent` rows. **A new path-based emulator does not touch `launch-ipc.js`.** Emulator
flag notes live in [launchers/](launchers/README.md) (e.g. DuckStation `-batch`, melonDS
`--fullscreen`, Dolphin `-b -e … -C Dolphin.Display.Fullscreen=True`).

**Native variant:** `variantExecSpec(launcher, flatpakArgs)` — if the added launcher's `cmd` is not
`flatpak`, the `['run', <appid>, …]` prefix is dropped and the native binary is used; Heroic,
RetroArch and the emulators all go through it (the builders stay flatpak-shaped).

`finish-setup` (the wizard) records: the launcher step (catalog ids copied into `customLaunchers`,
unknown/already-added skipped), the startup monitor **written only** (applied at the next start), the
sink **applied immediately**, the main controller (pref + sidecar), theme/language, then
`setSetupDone(true)`.

`launcher-manage-ipc.js` covers order and accent validation, add/remove (catalog id **or** full
object, with `matchCatalogEntry` enriching a hand-added flatpak), the installed-apps list for the add
wizard, and the in-app flatpak install (`flatpakInstallInFlight` allows one at a time). A removed
launcher goes to a one-element main-side trash for `LAUNCHER_REMOVE_UNDO_MS` (30 s) so △ in the toast
can undo; when it expires the imported icon is deleted. Native/flatpak variant and manual path logic
is in `launcher-variant-ipc.js` (including the startup `repairLauncherVariants()`).

## Per-game launch options

`lib/launch/launch-options.js`; the `gameLaunchOptions` config key; edited in the game details view
("Launch options" row, on-screen keyboard). Text such as `MANGOHUD=1 --fullscreen`: `NAME=value`
environment variables + extra arguments. **Only path-based launches** (Steam/Heroic/Lutris URL
launches take no extra arguments; RPCS3 is title-id based): the registry emulators (key
`<id>-game-<gameId>`), RetroArch (key `retroarch-rom:<ROM path>` — the playlist label is unknown at
launch time), custom ROM sources (`custom-game-<id>`). The renderer's `gameOptionsKey` and the main
`withLaunchOptions` use the **same key formula — change both together.**

Security (the renderer must not be able to add an arbitrary command): no shell — the text is split
into tokens (`splitWords`: quotes, no evaluation) and goes into the `spawn` argument array; the
command is the already-chosen emulator. Env names match `^[A-Z][A-Z0-9_]{1,63}$` and a deny list
(`LD_*`, `BASH*`, `PATH`, `NODE_*`, `ELECTRON*`, `XDG_*`, `HOME` …); ≤ 300 characters, ≤ 24
arguments, ≤ 8 env entries, no control characters. `set-game-launch-option` rejects unparsable text;
a hand-broken stored text is skipped at launch with a log line (the game launches without options).
`applyLaunchOptions`: natively the extra arguments go **before** the ROM path (and a preceding `--`),
env via `spawnGame`'s 5th parameter (`extra.env`); for **flatpak** env becomes `--env=KEY=VAL`
(the sandbox does not get the host env) before the app-id, extra arguments after the app-id (never
as flatpak options).

## Failed launches

`lib/launch/launch-errors.js`: `child.on('error')` → `spawnErrorInfo` (`ENOENT` → `err.cmdNotFound`,
`EACCES` → `err.cmdNoPermission`, other → `err.spawnFailed`); the spawn watchdog →
`err.spawnTimeout`; a **quick exit with a non-zero code** (`quickExitMs` 8 s, `isQuickFailure`: no signal,
not a requested kill — so the `steam` wrapper's `exit 0` and melonDS's 137 are not failures) →
`reportQuickExit`: for flatpak `isFlatpakInstalled(appId)` decides `err.flatpakNotInstalled` vs
`err.quickExit { name, code }`. Before launching, the path-based emulators and RetroArch check that the
ROM file exists (`rejectIfMissing`, injectable `fileExists`) → `err.fileMissing { file }` (only the
file name in the toast, the full path in the log). Payload `app-error { appId, errorKey, params,
error }`; the toast shows `⧉ LOG`, and Select within `LOG_JUMP_MS` (10 s) opens the Log sub-view
directly (`openSettingsView('log')`, which can open any sub-view). **There is deliberately no stderr
capture:** a pipe would give the still-running game / Steam client a SIGPIPE when the launcher quits,
and a file would grow with Steam/Proton's verbose output; `LAUNCHER_DEBUG_CHILD=1` logs it when
debugging.

## Window activation and moving (KDE)

- **Activate** (`lib/launch/window-activate.js`): no `kdotool`/`xdotool`/`wmctrl` on the machine (and
  they would not work on Wayland), but KWin offers a KRunner window-switcher on D-Bus:
  `gdbus call --session --dest org.kde.KWin --object-path /WindowsRunner --method
  org.kde.krunner1.Match "<query>"` (fuzzy against caption and resource class), then `…Run "<matchId>"
  ""`. The reply is Python-repr-like tuples whose `icon-data` can be hundreds of KB, so only the prefix
  is regexed (`parseWindowsRunnerMatches`); `pickMatch` prefers a caption match. `gdbus` (glib) is
  always present; `qdbus` fails on the complex return type. On GNOME it returns `false` without a
  call.
- **Move the launcher to an output** (`lib/launch/window-to-output.js`): on Wayland a client cannot
  position its window (Electron `setBounds` x/y is a no-op) but a KWin script can:
  `moveWindowToOutput(pid, output, log)` writes a script (`workspace.windowList()` by `pid` — the
  Electron browser process is the main `process.pid` → `workspace.sendClientToScreen`) and loads it with
  `gdbus … /Scripting loadScript` → `run` → `unloadScript`; it never throws. Needed **only with
  `keepOtherMonitors`** (the old output stays on and KWin won't move the window); without it KWin moves
  the window off a disabled output itself. Verified on KWin 6.7.5: the fullscreen window moves
  correctly and takes the target's full size **without toggling `fullScreen` off/on** (toggling
  raced — don't reintroduce it); the script moves only on a mismatch and only turns fullscreen back
  *on*. It is called **twice at startup** (`did-finish-load` and `STARTUP_WINDOW_MOVE_RETRY_MS` 1.5 s)
  because KWin overwrote an early move of a window still entering fullscreen, and only with **more than
  one active output** (`shouldMoveToStartupMonitor`). A missing KWin (`isKwinMissingError`:
  `ServiceUnknown`, non-KDE session) is logged once and then silently skipped. **To debug a KWin
  script use `console.warn(...)` — `print()` does not reach the journal** (`journalctl --user | grep …`).
  `createLauncherMover` moves the *launcher* window: KDE via KWin, GNOME+X11 via Electron `setBounds`,
  GNOME+Wayland skipped.
