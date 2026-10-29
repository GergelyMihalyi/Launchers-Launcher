# Shared infrastructure (`lib/` root)

Cross-cutting modules that every other domain builds on. Domain-specific code lives in its own
folder (see [architecture.md](architecture.md) for the folder map). Rule of thumb for every module
below: **`lib/` never requires `electron`** (`test/contracts/require-smoke.test.js` requires every
`lib/**/*.js` in a sandbox), so it can be unit-tested with plain Node.

## Contents

- [Process execution and logging](#process-execution-and-logging)
- [Timeouts](#timeouts)
- [Config store](#config-store)
- [Preferences](#preferences)
- [Paths, files and downloads](#paths-files-and-downloads)
- [Flatpak helpers](#flatpak-helpers)
- [Environment detection](#environment-detection)
- [Validation of renderer input](#validation-of-renderer-input)
- [Sidecar files for shell scripts](#sidecar-files-for-shell-scripts)
- [Worker-thread scans](#worker-thread-scans)
- [Stability: safe mode, fatal errors, GPU fallback](#stability-safe-mode-fatal-errors-gpu-fallback)
- [Diagnostics: log, startup timeline, format drift](#diagnostics-log-startup-timeline-format-drift)
- [Host dependencies](#host-dependencies)

## Process execution and logging

`lib/exec.js`:

- `execFileAsync` — always `execFile`/`spawn`, never string-interpolated `exec`, whenever any
  argument is not fully controlled. **Every external call needs a timeout** (`EXEC_TIMEOUT_MS`,
  8 s) — a hung helper otherwise leaves an `ipcMain.handle` pending forever and the UI stuck on
  "loading".
- `withTimeout(promise, ms, label)` clears the losing timer when the race settles.
- `createLogger(logFile, maxBytes)` — async `fs.appendFile`, ISO timestamp prefix, rotates to `.1`
  at 2 MB. The file is `~/.local/share/launchers-launcher.log` (built from `os.homedir()`, never a
  hard-coded path). `log.warn` / `log.error` add an explicit `WARN` / `ERROR` marker; use them for
  new failure paths. `logError(log, context, err)` and `toLogger(log)` (accepts a function, a
  logger or nothing and always returns something callable) keep best-effort `catch` blocks uniform.
- `sessionEnv({ full, platform })` builds the Wayland/D-Bus/KDE session environment for helper
  processes and game spawns. It **only fills in what is missing** from `process.env` — it never
  overrides a real value (a blind `wayland`/`KDE` default used to break GNOME/X11). On X11 it does
  not inject `WAYLAND_DISPLAY` (that would lure SDL3 onto Wayland). `full: true` adds what a game
  spawn needs (used by `launch-controller`).
- The spawned app's stdout/stderr is **not piped** (`stdio: 'ignore'`); `LAUNCHER_DEBUG_CHILD=1`
  turns on piping + logging.

Log lines are classified by `lib/log-lines.js` (`classifyLogLine`: explicit `WARN`/`ERROR` marker
first, otherwise a keyword heuristic so old `log()` calls did not have to be rewritten). The Log
sub-view reads only the last 256 KB of the file (`readLogTail`), shows at most 500 lines, filters
with L2/R2, and `export-log` (□) writes `~/launchers-launcher-log-<date>.txt` containing the rotated
`.1`, the current log and the watcher / BT-trigger logs.

## Timeouts

**Every timeout and background delay of the main process lives in `lib/timings.js`** (ms). A number
written inline into a `timeout:` option or `withTimeout(…, <number>)` in `lib/` fails
`test/contracts/timings.test.js`. This also applies to internal async chains: a Promise that
"always resolves" but waits on external I/O (worker scan, warm-up step) gets a `withTimeout`.

Principles worth remembering:

- Every `ipcMain.handle` has an overall ceiling, `IPC_HANDLE_TIMEOUT_MS` (2 min, `lib/ipc/ipc-guard.js`);
  the inner limits (exec, worker scan, warm-up step) are shorter. A legitimately longer channel gets
  one line in `IPC_HANDLE_TIMEOUT_OVERRIDES` (host-package install, manual games refresh).
- The renderer's launch watchdog (`LAUNCH_WATCHDOG_MS`, 45 s) must exceed the main-side
  launch timers (spawn watchdog, hide fallback, quick-exit window + bring-to-front delay).
- `BT_CONNECT_TIMEOUT_MS` (12 s) is longer than BlueZ's own ~5 s page timeout; Wi-Fi connect is
  40 s (slow DHCP); `flatpak install` and `npm install` get 5 minutes; saves archive 10 minutes;
  the in-app package install 15 minutes (it waits for a polkit password).
- Cache lifetimes (`GAMES_CACHE_TTL_MS`, the 30 s derived-recent cache, the 7-day negative cover
  cache), poller intervals and renderer UI constants (hold times, repeat rates) deliberately do
  **not** live in `timings.js`.

A new timeout = a constant in `lib/timings.js`; the test also checks the constants against the
sources, so read the values there rather than here.

## Config store

`lib/config.js` — one file, `~/.config/launchers-launcher/config.json` (`$XDG_CONFIG_HOME` honoured).
API: `get(key, fallback)` (returns a **deep copy**; stat-signature cached, so a hand edit is picked
up immediately), `set(key, value)`, `patch(key, partial)`. Writes are atomic.

Boot chain (`lib/config-boot.js` `bootConfig`, one call, each step logs in place):
`recoverCorruptConfig` (an unparsable file is moved to `config.json.corrupt-<ts>`) →
`migrateFromLegacy` (the four old root JSON files are merged once; they are not deleted) →
`normalizeConfig` → `backupDaily` → `runMigrations`.

- **`KEY_TYPES`** is the top-level schema table. `normalizeConfig` drops a *known* key of the wrong
  type (so readers fall back to their defaults) and rewrites the file; unknown keys are untouched.
  `set`/`patch` reject a wrong-typed known key with a `TypeError`. **A new config key must be
  added to `KEY_TYPES`.** Value-level validation (theme whitelist, language, sink exists) belongs to
  the readers; their defensive guards intentionally stay as a second layer.
- **Migrations** (`lib/config-migrations.js`): numbered `{ to, name, run }` entries driven by the
  `configVersion` key. A new migration is one line at the END; `run` must be idempotent and throw
  on failure (the version then does not advance). **Downgrade guard:** a config whose
  `configVersion` is newer than the code (after a rollback) skips migrations and is not pruned.
  **Never change the type of an existing key — a new shape gets a new key name.**
- **Daily backup:** `backupDaily({ keep: 5 })` writes at most one `config.json.bak-<date>` per day
  (byte-identical content is skipped). `listBackups` / `restoreBackup(name)` accept only listed
  names (no path traversal), require valid JSON and first save the current state as
  `config.json.pre-restore` (one-step undo). UI: Settings → System → Config backups; a restore
  relaunches the app.
- **Transfer between machines** (`lib/config-transfer.js`): export/import of a **`PORTABLE_KEYS`
  allow-list** only. Machine-specific or command-carrying keys (`display`, `customLaunchers`,
  `launcherPaths`, `mainController`, `tvMode`, `gameLaunchOptions`, `flatpakGrants`, `saveBackup`,
  `usage`, `recentGames`, markers) are never exported — the setup wizard re-creates them on the new
  machine. A new portable key must be added to the list; one that carries a command or a path must
  not. Import goes through `config.set`'s type check, and the file list offers only direct children
  of `$HOME` matching a strict name pattern.

The full key reference is [config-keys.md](config-keys.md).

## Preferences

`lib/prefs.js` holds validated getters/setters on top of the config. Most are built from three
factories: `boolPref(key, def)`, `enumPref(key, values, def)`, `boolFlagsPref(key, defaults)` —
**a new simple switch is one line**. Also here: theme (whitelist derived from `themes/themes.json`,
unknown → `neon`), feedback flags, main controller (`{ mac, name, type }`, MAC validated), TV-mode
lists, UI scale, per-theme background map (`getBackground(themeId)`; `none` entries are removed),
and the built-in/custom background lists. The main process only **stores**; the effect
(`data-theme`, `data-ui-scale`, the `#bgCustom` layer, sound, rumble) happens elsewhere.

## Paths, files and downloads

- `lib/xdg.js` — a flatpak app's config is **not** `~/.config/<app>`: `flatpakConfigRoot`,
  `flatpakDataRoot`, `flatpakCacheRoot` map to `~/.var/app/<appId>/{config,data,cache}/<appName>`
  (`appName` is not always the last appId segment, e.g. `org.libretro.RetroArch` → `retroarch`).
  `translateFlatpakDocPath` converts the in-sandbox document-portal path
  (`/run/flatpak/doc/<token>/…`) to the host-side `/run/user/<uid>/doc/<token>/…`.
  **Native ↔ flatpak variant:** `setAppVariants`, `appVariant`, and
  `appConfigRoot` / `appDataRoot` / `appCacheRoot(appId, appName, { native? })` return the root of
  the *selected* variant (for an app that was not added: whichever exists, flatpak first). Every
  library module's root function goes through these — never call `flatpakConfigRoot` directly in a
  new module; worker scans receive the root as a parameter.
  `dataHome()` is `~/.local/share` and **deliberately ignores `$XDG_DATA_HOME`** (the shell scripts
  `cat` fixed paths and the tests isolate via `$HOME`).
- `lib/fs-atomic.js` `writeFileAtomic(file, data, { mode?, fsync? })` — temp file + rename; use it
  for every atomic write (`fsync: true` for small critical state: config, sidecars). The streaming
  downloader in `net.js` is the one exception.
- `lib/net.js` — the repo's **only network module**. `downloadFile` (boolean) /
  `downloadFileDetailed` (`{ ok, status }`, `0` = no HTTP response): atomic temp+rename, follows up
  to 3 redirects, 5 MB cap, 8 s timeout, **never throws**. The kiosk is offline-first; downloads are
  a best-effort extra and everything afterwards comes from the disk cache.
- `lib/dir-browse.js` — `listSubdirs`, `isInsideDir` (uses `path.relative`, avoiding the
  `startsWith` prefix trap: `/home/userX` is not inside `/home/user`), `filterExistingDirs`,
  `walkFilesByExtension` (the core of every ROM scanner). **For any new ROM walker use the shared
  helpers:** `entryKind`/`entryKindAsync` (resolves symlinks — a `Dirent` symlink is neither
  `isFile()` nor `isDirectory()`), `firstVisit`/`firstVisitAsync` (cycle guard by `realpath`),
  `isJunkEntry` (macOS `._*` — same extension as the ROM! —, `.DS_Store`, `Thumbs.db`,
  `$RECYCLE.BIN`, `System Volume Information`, `.Trash-*`, `lost+found`). The launcher process is
  **not sandboxed**, so any host path is readable directly.
- **Clocks:** every *elapsed-time* measurement (launch controller, warm-up steps, scan-pool cooldown) uses a monotonic clock (`performance.now()`);
  wall-clock `Date` deliberately stays in `ttl-cache` (a long sleep must expire the cache), the persisted `safe-mode` / self-update timestamps and the
  `usage`/`recentGames` timestamps.
- **Input hardening worth knowing:** `toggleFavoriteGame` accepts a non-empty ≤ 300-char string `key`, string/default `name`/`cover`/`kind` and `params` of
  primitive values only (≤ 16 keys, strings ≤ 4096); the RetroArch `.lpl` parser skips non-object / `path`-less items (one `null` once dropped a whole
  system); `bluetooth.js` looks a `kind` up with `Object.hasOwn` (`constructor`/`__proto__` are not kinds).
- `lib/ttl-cache.js` — `createTtlCache(fn, ttlMs)` (key = JSON of args, `.invalidate()`, **a throw
  is not cached**); `GAMES_CACHE_TTL_MS` = 10 min. TTL rather than `fs.watch`: installs are rare on a
  kiosk; freshness comes from the explicit invalidate + re-warm after returning from a game.
- `lib/parse.js` — pure parsers for `pactl`, `bluetoothctl`, `kscreen-doctor`, `upower`, plus
  `escapeRegExp`. The module that runs the command hands the output to a parser, which keeps the
  parsing unit-testable.

## Flatpak helpers

`lib/flatpak.js` is the single home of flatpak logic: `flatpakRunAppId(args)` (**use this to extract
an appid** — the element after `run`), `catalogAppId`, parsers for `ps` / `list` / `info`,
`parseFlatpakPermissions` (the `[Context] filesystems=` line), best-effort calls that never throw
(`readFlatpakFilesystems`, `listRunningFlatpakApps`, `flatpakAppInstalled`, `killFlatpakApp` — `flatpak
kill` is the only reliable way to stop a sandbox), and `runFlatpak(args, onLine, timeoutMs)`, a
streaming `spawn` (not `execFile`) because `install --user` prints progress while running
(`LC_ALL=C`; always resolves `{ code, out, timedOut? }`).

## Environment detection

- `lib/desktop-env.js` `desktopEnv()` → `kde` | `gnome` | `unknown` (from `XDG_CURRENT_DESKTOP`
  tokens, falling back to `DESKTOP_SESSION`; `LAUNCHERS_LAUNCHER_DESKTOP` overrides). It is the single
  chooser of every DE-dependent backend: monitor switching, window activation/move, "Do not
  disturb", and the command self-test. `unknown` takes the KDE path. **A new DE-dependent
  integration calls this — it does not inspect the environment itself.** Env-based detection is
  fine here (a wrong value just picks a wrong backend), unlike the ozone platform below.
- `lib/ozone-platform.js` `pickOzonePlatform()` → `wayland` | `x11`, decided by the **existence of
  the Wayland socket** (`$WAYLAND_DISPLAY`, else `$XDG_RUNTIME_DIR/wayland-0`), then
  `DISPLAY` / `/tmp/.X11-unix/X*` → `x11`; nothing found → `wayland`. `LAUNCHERS_LAUNCHER_OZONE`
  overrides. **Never decide from `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY` env, and never hard-code
  `--ozone-platform` in `package.json`** (a watcher's systemd environment can be empty; on X11 a
  wrong choice is an immediate SIGTRAP). Chromium picks the platform *before* any JS runs, so an
  `appendSwitch('ozone-platform')` in `main.js` is too late; `npm start` therefore runs
  `node bin/start.js`, which passes the decision as a CLI switch.

## Validation of renderer input

`lib/validate.js` — every field arriving from the renderer, especially anything that lands in the
config or in a command argument, goes through these: `str(v, max)`, `oneOf`, `plainObject`,
`primitiveMap`, `macAddress` (strict, a `bluetoothctl` argument), `flatpakAppId` (cannot start
with `-`; used for sidecars and `flatpak kill`), `arrayOf(v, itemValidator, max)`, `PATH_MAX`.
They are pure and never throw; invalid input is dropped and logged.

The IPC layer adds three conventions (`lib/ipc/`): `guardIpcMain` wraps `ipcMain` **once** — a
throwing `on` listener is logged and swallowed (it would otherwise be a fatal `uncaughtException`),
a failing `handle` is logged and rejects the renderer's `invoke`; `requireDeps(deps, names, label)`
at the top of every `register*Ipc`/`create*Handlers` constructor makes a missing dependency throw
at **startup** (where the self-update rollback still protects) instead of on the first IPC call;
`ipc-groups` registers related domains in one call to respect the `main.js` size ceiling.

## Sidecar files for shell scripts

The `bin/*.sh` scripts run early with a minimal PATH and no guarantee that `node` or `jq` exists,
so the launcher mirrors the relevant config into plain files under `~/.local/share/`:

| Sidecar | Written from | Read by |
|---|---|---|
| `launchers-launcher-main-controller` | `mainController` (empty = any controller) | BT trigger |
| `launchers-launcher-autostart` (`autostart.js`) | `controllerAutostart` (`disabled` = off) | BT trigger |
| `launchers-launcher-tvmode` (`0600`) | `tvMode` → lines `flatpak <id>` / `native <proc>` / `cmd <shell>` | `bin/tv-mode-enter.sh` |
| `~/.config/autostart/launchers-launcher.desktop` (`xdg-autostart.js`) | `startWithSystem` | the desktop session |

- Writes are atomic (`fsync` where critical). `lib/sidecars/sidecar-sync.js` `resyncSidecars()`
  realigns them with the config at startup; **a new sidecar is one step in its `steps` list.**
- `controllerAutostart` deliberately does not touch the systemd user units (they always run when
  installed); it only decides whether a recognised controller connect starts the launcher.
  `startWithSystem` is independent: it opens the window at login.
- `tv-mode-enter.sh` runs `cmd` lines (`bash -lc`) only if the sidecar is owned by the user and not
  group/other-writable (`test/contracts/tv-mode-enter-trust.test.js`). There is **no `pkill -f`**
  anywhere; native processes are matched exactly (`pkill -x`). Entries containing a newline are
  skipped.
- The XDG autostart entry `Exec=` is `bin/launchers-launcher-show.sh` — the same script as the menu
  icon — so an already-running launcher is only brought to the front.

## Worker-thread scans

Heavy library scans (synchronous file I/O) would freeze the whole window — on Linux the browser
process presents the frames — so they run in a worker (`lib/scan/`): `SCAN_SOURCES` lists the raw
scans (melonDS, PPSSPP, DuckStation, RetroArch-all), `scan-pool.js` `createScanPool().scan(source, args)` (running `scan-worker.js`) spawns a
lazy `unref()`-ed worker, respawns it on failure, and enforces a per-request limit
(`SCAN_JOB_TIMEOUT_MS`, the hung worker is dropped). After `MAX_RESPAWNS` consecutive failures the
requests fail immediately for a cooldown. **There is deliberately no synchronous main-process
fallback** (in-process mode only when a `Worker` cannot be created at all). The TTL cache stays in
the main process (`workerScans.<x>` wraps `scanPool.scan`). Cold numbers that motivated this:
melonDS on NFS 2–13 s, PPSSPP 4 s.

Why a worker and not cooperative async scanning: the CPU part (inflate, `.cso`, icon decoding) would still run on the main thread, only sliced, and every
module would have to become async; an Electron `utilityProcess` would cost the Electron-independence of `lib/`. Cold scans measured before the worker (T410):
melonDS (139 zips, NFS) 2.4–13.5 s, PPSSPP (52 ROMs, `.cso`) 4.0 s, DuckStation 0.5 s, RetroArch ALL 0.11 s, the rest < 0.12 s; with the worker the main loop's
worst delay was 22 ms during a 2.3 s PPSSPP + melonDS scan, and with the persisted per-file cache a second run took 0.12 s instead of 2.4 s. A blocking
"loading until everything is ready" screen was deliberately **not** added: the cards are usable at once, only the Games panel needs the caches, and while main
blocks even the loading animation freezes — the startup skeleton and the warm-up spinner are enough.

A new heavy source = one line in `SCAN_SOURCES`, one `workerScans` line, and a `workerLoader(...)`
in `GAME_LOADERS` (`test/scan/scan-sources.test.js` fails if `main.js` calls a source that is not
listed). Only Electron-free scans returning plain (structured-clonable) data qualify.

`scan-meta-cache` is a per-file (mtime + size) metadata cache with optional disk persistence,
**off by default** — only `enablePersistence(dir)` turns it on, and only the scan worker (and the
pool's in-process fallback) call it. **Never enable it at module load**: test processes that scan
an empty temp root would wipe the real cache files.

## Stability: safe mode, fatal errors, GPU fallback

- **Safe mode** (`lib/safe-mode.js`): `beginStartup()` increments `startup-attempts.json`; if the
  previous 3 starts (within 10 minutes) never reached the healthy point (`did-finish-load` + 20 s,
  or `will-quit`), or `LAUNCHERS_LAUNCHER_SAFE=1`, the run is safe: no TV power-on, no startup output
  switch, no games warm-up, no evdev reader, **no GPU**; a banner explains why. Counting lives in
  the launcher, not the watcher (no `/usr/local/bin` re-copy, works without a watcher). A renderer
  that crashes repeatedly (3 within 2 minutes — `render-process-gone`, `clean-exit` excluded) forces
  safe mode and relaunches; the plain counter cannot see a crash after the 10-minute mark, hence
  `forceNext('renderer')`. Already in safe mode → `app.exit(1)` without relaunch, leaving it to the
  watcher's burst limiter.
- **Fatal policy** (`lib/fatal-policy.js`): `uncaughtException` is always fatal;
  `unhandledRejection` only in the startup window (first renderer load + 30 s), afterwards it is
  logged and counted (Diagnostics → Version).
- **GPU:** hardware acceleration is on (software rendering cost ~38 % of a core on an idle home
  screen vs ~7 %). There is intentionally no `--disable-software-rasterizer`, so a GPU failure falls
  back to software instead of a black screen. `LAUNCHERS_LAUNCHER_DISABLE_GPU=1` and safe mode call
  `app.disableHardwareAcceleration()` before `whenReady`. **Automatic fallback**
  (`lib/gpu-fallback.js`): if the GPU did not initialise at a start, the `gpuFallback` key records
  `{ signature, status, at }` and the next start disables it; a new signature (Electron version or
  Mesa DRI mtime) retries once; `LAUNCHERS_LAUNCHER_DISABLE_GPU=0` forces it on. The September
  SIGSEGV was caused by the missing `ozone-platform=wayland`, not by the GPU.
- Detail worth knowing: the `app.relaunch()` after a crash cannot pass a new environment, which is
  why safe mode is persisted via a counter/marker rather than an env variable.

## Diagnostics: log, startup timeline, format drift

- **Startup timeline** (`lib/startup-timeline.js`): milestones `appReady` → `outputsApplied` →
  `windowCreated` → `rendererLoaded` → `launchersRendered` (renderer `startup-mark`) →
  `warmupDone`, in ms from process start, each recorded once; written as `[startup] …` log lines and
  shown under Diagnostics → Last start. **Use it to measure any startup optimisation.**
- **Format drift** (`lib/host-deps/format-drift.js`): `checkParsed(probe, stdout, count)` at every
  parser call site. If a command succeeded with output but the parser found 0 items, a one-time
  `[format]` WARN is logged and Diagnostics → System commands shows "FORMAT CHANGED?". Current
  probes: `pactl-sinks`, `kscreen-doctor`, `mutter-state`, `nmcli-wifi`, `bluetoothctl-paired`,
  `flatpak-list`, `flatpak-permissions`. **A new external-command parser needs both the
  `checkParsed` call and a probe in `tools/capture-host-output.js` `PROBES`** (a test enforces both).
  `node tools/capture-host-output.js` records anonymised real output (MAC, SSID, BT name, serials
  masked) into `test/fixtures/host-output/<probe>/<distro-DE>.txt`; re-run and commit it after a
  distro/DE update. The `kscreen-doctor` sample must be captured on a KDE machine (`fedora-44-kde` and `nobara-44-kde` [two outputs, one of them disabled], 2026-10-28; GNOME: `debian-13-gnome`). A machine without a Bluetooth adapter has no useful `bluetoothctl-paired` sample (the output is just "No default controller available").
- **Dependency health** (`lib/update/dep-health.js`): `npm outdated --json` and `npm audit --json`
  exit non-zero when they find something, so the stdout JSON is what counts, not the exit code.
  Report-only. `install.sh` enforces the `engines.node` minimum (Debian 13's packaged Node is 20.x).

## Host dependencies

- **Self-test** (`lib/host-deps/selftest.js`): required commands `pactl`, `kscreen-doctor` (not on
  GNOME — `requiredCommands(desktop)`), `bluetoothctl`, `flatpak`, `git`. `cec-ctl` is deliberately
  excluded (`cecAvailable()` handles it; most GPUs have no CEC). Only the missing ones are logged at
  startup; Diagnostics shows the full list; `invalidate()` drops the cache after an install.
- **In-app install of the missing ones** (`lib/host-deps/host-packages.js`): `PACKAGE_MAP`
  (fedora/arch/debian) is a **mirror of `install.sh` `pkg_for()`** (except node/npm/curl/xz —
  `test/contracts/host-packages-mirror.test.js`). Installs with `pkcon -y install` (PackageKit,
  distro-independent), falling back to `pkexec apt-get|dnf|pacman`. Success is judged by a fresh
  self-test, not the exit code; one run at a time; while it runs the foreground guard is paused so it
  does not steal focus from the polkit password dialog. The password dialog asks for keyboard input,
  which a controller cannot provide — the first install path remains `install.sh`.
- `lib/system-power.js`: poweroff / reboot / suspend whitelist via **`systemctl --no-ask-password`**
  (not `loginctl`), plus the session-only sleep timer. The timer lives in the factory closure, not in
  the config, on purpose: a timer that arms itself at startup would be wrong on a kiosk.
- `lib/gpu-fallback.js`, `lib/safe-mode.js`: see above. `lib/evdev-pads.js`, `lib/bluetooth/`,
  `lib/network/`: see [devices.md](devices.md).
