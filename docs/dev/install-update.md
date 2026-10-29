# Install, start-up chain, self-update

Files: `install.sh`, `get-launchers-launcher.sh`, `bootstrap.js`, `bin/*.sh`, `systemd/*.service`, `share/`,
`lib/update/*`, `lib/host-deps/*`, `renderer/settings/settings-update.js`.

## Contents

- [The start-up chain](#the-start-up-chain)
- [`bin/` scripts and where they run from](#bin-scripts-and-where-they-run-from)
- [systemd user units](#systemd-user-units)
- [Privileges](#privileges)
- [`install.sh`](#installsh)
- [Self-update and rollback](#self-update-and-rollback)
- [The desktop entry](#the-desktop-entry)
- [Electron major upgrade checklist](#electron-major-upgrade-checklist)

## The start-up chain

```
BT controller connects ─► launchers-launcher-bt-trigger.service (user unit, runs from the repo)
                          └─ guards ─► bin/tv-mode-enter.sh ─► socket ─► launchers-launcher-watcher.sh (/usr/local/bin)
                                                                         └─ npm start → node bin/start.js → electron . → bootstrap.js → main.js
.desktop icon / XDG autostart ─► bin/launchers-launcher-show.sh ─► (running? front it : socket "launch", fallback npm start)
```

- **`bootstrap.js` is the real Electron entry** (`package.json` `main`), not `main.js`. The single-instance lock lives
  here, **before** `require('./main.js')` (if there is no lock → `app.quit()` and `main.js` is never loaded, so no config
  operation runs; a second start only brings the existing window forward — `main.js`'s `second-instance` handler). It does
  `try { require('./main.js') } catch` because a syntax error **inside** `main.js` throws at `require()` (parse) time,
  which a try/catch *inside* `main.js` could never catch. It also installs global `uncaughtException` / `unhandledRejection`
  handlers for asynchronous start-up errors; **`unhandledRejection` is fatal only in the start-up window**
  (first renderer load + `STARTUP_FATAL_GRACE_MS`; `lib/fatal-policy.js`), afterwards it is `log.error` + a counter in
  Diagnostics; `uncaughtException` is always fatal. **Scope: only the Node main process** — a broken
  `renderer/*.js` syntax error does not throw in main, and this mechanism does not cover it.
- `__dirname`-relative code in `main.js` (assets, `CHANGELOG.md`, the `git`/`npm` `cwd`, the `preload.js` path) works from any
  requirer: a module's `__dirname` is its own file's. `electron .` / `npm start` load only `package.json`'s `main`; no
  `bin/*.sh` references `main.js`.
- `postinstall: install-electron` (idempotent, cached in `~/.cache/electron/`): since Electron 35 the binary is **not**
  downloaded by `npm install` but lazily at first launch — which would fail offline right after a self-update on a kiosk. Do
  not remove it. Electron-major upgrades: see [the checklist below](#electron-major-upgrade-checklist).

## `bin/` scripts and where they run from

| Script | Runs from | Edit takes effect |
|---|---|---|
| `bin/launchers-launcher-watcher.sh` | **`/usr/local/bin/`** (a manual copy) | only after the user re-copies it **and** restarts the unit — **always tell the user** |
| `bin/launchers-launcher-bt-trigger.sh` | the repo (`%h/launchers-launcher/bin/…`) | only after `systemctl --user restart launchers-launcher-bt-trigger.service` (a long-running `while true` — bash reads the whole block at start, so an edit does not reach the running process; this cost a live bug on 2026-09-12) |
| `bin/tv-mode-enter.sh` | the repo | at the **next trigger** (a fresh process each time) |
| `bin/launchers-launcher-show.sh` | the repo | at the next use |

All `bin/*.sh` and `install.sh` are **`shellcheck -S warning -x` clean** (`test/contracts/shell.test.js`: `bash -n`
always, shellcheck with `t.skip()` when not installed; `npm run lint:shell` runs it via the npx cache — deliberately not a
devDependency, it would pull in 124 packages).

- **The watcher** (`launchers-launcher-watcher.sh`): the socket watcher and launcher lifecycle. **Crash-restart lives in the
  script itself**, not in a systemd unit: `start_launcher()` records the `npm start` exit code (`LAUNCHER_RC`); in the
  `while true` loop `LAUNCHER_RC != 0` (a crash) → an immediate restart without waiting for a socket message, with a burst
  limit `CRASH_MAX` (5) / `CRASH_WINDOW` (60 s) (env-overridable), beyond which it `break`s back to waiting on the socket;
  a clean exit (0, e.g. PS+○ / TV-mode exit → `app.quit()`) goes straight back to the top. A separate
  `systemd/launchers-launcher.service` was **deliberately not made** (dual life-cycle responsibility). The exit-code convention
  matters: a successful self-update / rollback does `app.relaunch(); app.exit(0)` so the watcher does not start a second
  copy.
- **The BT trigger** and `tv-mode-enter.sh`: see [output-tv.md](output-tv.md#the-tv-mode-lifecycle). They read the sidecars
  ([infrastructure.md](infrastructure.md#sidecar-files-for-shell-scripts)).
- **`launchers-launcher-show.sh`**: the `.desktop` icon's `Exec=`. Running → a second `npm start` → the `second-instance` handler
  brings the window forward; not running → `printf 'launch' | ncat --send-only -U <watcher-socket>` (the `tv-mode-enter.sh`
  pattern), fallback a direct `npm start`. Both scripts put the installed user-local Node first on `PATH`.
- The repo **must** live at `~/launchers-launcher` (the user unit's `ExecStart` and the scripts rely on it).

## systemd user units

`systemd/*.service` are **versioned templates** — the unit that actually runs is the copy under `~/.config/systemd/user/`,
which the user enables (`systemctl --user enable --now`); see `systemd/README.md`.

- **`launchers-launcher-watcher.service`** supervises the watcher script (`Restart=always`, `RestartSec=3`). The template
  follows the **version that is proven on the machine**: `After=graphical-session.target`,
  `ExecStart=/usr/local/bin/launchers-launcher-watcher.sh`, `WantedBy=default.target`, **no `PartOf=`**. (An abstract example in
  an early plan, with `PartOf=` and a repo-absolute `ExecStart`, was deliberately not followed.)
- **`launchers-launcher-bt-trigger.service`**: the root-free BT trigger (`Restart=always`, `After=bluetooth.target`,
  `ExecStart=%h/launchers-launcher/bin/launchers-launcher-bt-trigger.sh` — from the repo, not `/usr/local/bin`). Enable with
  `cp systemd/launchers-launcher-bt-trigger.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl
  --user enable --now launchers-launcher-bt-trigger.service`; a cold start (before login) needs `loginctl enable-linger $USER`
  (not on a kiosk with autologin).

## Privileges

The launcher and all its functions run **without root**; the only root-needing element used to be the old
udev → root trigger chain (a rule in `/etc`, scripts in `/usr/local/bin`, a `sudo -u <user>` drop) — removed in September 2026
(history in [history.md](history.md)). What remains: `usermod -aG video` for CEC (one-off, only with a CEC device, `install.sh`
asks separately, default **no**), `loginctl enable-linger` only for cold starts. `install.sh --dry-run` prints every command that
would change system state. `sudo` is used only by `install.sh` for package installation, with one confirmation.

## `install.sh`

Prerequisite check → **install the missing distro packages with ONE confirmation** (default yes; `apt-get update && apt-get
install -y` / `dnf install -y` / `pacman -S --needed --noconfirm`, with sudo; the `pkg_for()` table is mirrored by
`lib/host-deps/host-packages.js` `PACKAGE_MAP` — `test/contracts/host-packages-mirror.test.js`) → if Node is missing or below
`engines.node` (**Debian 13's `nodejs` is 20.x**), download the official Node into `~/.local/share/launchers-launcher/node` (no sudo:
`nodejs.org/dist/latest-v<major>.x/` → `SHASUMS256.txt` → the `linux-x64`/`arm64` `.tar.xz` → `sha256sum -c` → extract into
`node.new`, swap on success; verified on a scratch HOME with v22.23.3; `curl` + `xz` then join the package list) → `npm install` →
`flatpak remote-add --user --if-not-exists flathub` → for a CEC device the `video` group question → the `.desktop` icon
(`setup_desktop_entry()`: `sed` of the `@REPO@` token in `share/launchers-launcher.desktop` into `~/.local/share/applications/`)
→ optionally (with confirmation) the watcher into `/usr/local/bin` + the two user units + `systemctl --user enable --now`.
**The watcher runs from `/usr/local/bin`: the auto-start step re-copies it.**

- Required: `git`, `kscreen-doctor` (not on GNOME), `pactl`, `bluetoothctl`, `gdbus` (+ `npm` if Node is the distro's); optional:
  `ncat`, `flatpak`, `zstd`, `cec-ctl` (only with `/dev/cec*`). Package names verified for Debian (`kscreen-doctor` →
  `libkscreen-bin`; `kscreen` is the KCM module); Fedora (`pactl` → `pulseaudio-utils`, since `pipewire-utils` has no `pactl`;
  `kscreen-doctor` → `libkscreen`) and Arch names are from documentation, **not verified on a machine**. `check_node_version`
  enforces `package.json` `engines.node` (`sort -V`) as a hard requirement (Electron's install script fails on older).
- Flags: `--yes` / `-y` (yes to every question, including auto-start), `--no-packages` (print the missing, the old behaviour),
  `--dry-run`, `--uninstall`. An unknown distro only prints. `LAUNCHERS_LAUNCHER_OS_RELEASE` for tests. `do_install` compares the
  resolved path (a `launchers-launcher` → repo symlink works).
- **`get-launchers-launcher.sh`** is the one-line bootstrap (`curl -fsSL …/get-launchers-launcher.sh | bash`, `| bash -s -- --yes`):
  installs git if missing (one question), clones into `~/launchers-launcher` (or `pull --ff-only`), then
  `exec install.sh "$@" </dev/tty` (the `curl | bash` stdin is the script itself). **⚠️ The GitHub repo is private
  (2026-09-25) — an anonymous HTTPS clone / raw URL does not work; until then
  `LAUNCHERS_LAUNCHER_REPO=git@github.com:<owner>/Launchers-Launcher.git ./get-launchers-launcher.sh`.**
- The launcher itself can install missing commands (Diagnostics / wizard; [infrastructure.md](infrastructure.md#host-dependencies)).
- Tests: `test/contracts/install-sh.test.js` (arg handling + `--dry-run` scenarios with a trimmed `PATH`, a fake os-release and a
  **temporary HOME** — including a `launchers-launcher` → repo symlink), `shell.test.js` (+ `get-launchers-launcher.sh`).

## Self-update and rollback

Settings → System → Update (`check-update` / `apply-update`). It **modifies the repo itself** (`git pull --ff-only` in
`main.js`'s `cwd: __dirname`, optionally `npm install`) and `app.relaunch()`: a "lives in the repo but changes the machine"
operation in reverse. **Still to verify on the machine:** that `git fetch/pull` works from the launcher process's environment
(SSH — `SSH_AUTH_SOCK` — not only from an interactive terminal) and that `relaunch` cooperates with the watcher.

- **Status** (`lib/update/self-update.js` `deriveUpdateStatus(raw)` from `fetchOk` / `git status --porcelain` /
  `rev-list --count HEAD..@{u}` / `diff --name-only`): `offline` (fetch failed) / `no-upstream` (the current branch has no
  tracking branch — checked first via `@{u}`, otherwise the `rev-list` failed as a "check-update error") / `dirty` (a dirty working
  tree — update **disabled**) / `up-to-date` / `available` (+ `ahead`, `needsNpmInstall`, `dirtyFiles`, `branch`).
  `parsePorcelainCount`, `touchesPackageManifest` are pure helpers; `checkForUpdate(repoRoot, log)` and `applyUpdate(repoRoot,
  { log, onProgress })` hold the handler bodies (lazy-requiring config/exec). `check-update` runs only when the Update sub-view
  is entered — no start-up network call.
- **`apply-update`:** `git pull --ff-only --quiet` (**only fast-forward** — a merge conflict would leave a half-done repo), then,
  if the pull touched `package.json`/`package-lock.json` (diff of HEAD before ↔ after), an `apply-update-progress`
  `{ phase: 'npm-install' }` push (the UI switches text) and an automatic **`npm install --no-save --no-audit --no-fund`**
  (not `npm ci`: only 3 dependencies, and `ci` would wipe and reinstall the ~280 MB `node_modules` for any manifest touch;
  `--no-save` so a different npm version never rewrites the lock, which would dirty the repo and silently make every later update
  stop at `dirty`). `NPM_INSTALL_TIMEOUT_MS` 5 min (an Electron version change may re-download the binary). Replacing
  `node_modules` under a **running** Electron is safe on Linux (an open/mapped inode stays alive; only the next start sees the new
  tree). On `npm install` failure: `git reset --hard <pre-pull HEAD>` + `update-failed`, **no relaunch** (the running instance is
  in memory). **Honest limit:** `node_modules/` is git-ignored, so the reset cannot repair it; an `npm install` interrupted midway
  (network) may leave it uncertain until a future start — rare and no worse than the old fully manual instruction.
- **Rollback marker:** after a successful pull (+ npm install) `pendingUpdateRollback = { fromSha, appliedAt }` is written with the
  pre-pull HEAD SHA, then `app.relaunch(); app.exit(0)`. It is **cleared** (a) on a healthy start — `main.js` `app.whenReady()`
  after `createWindow()`/`applyStartupOutputs()`/`startRunningPoll()`, with a guarded read+write (no needless disk write on a normal
  start), (b) in `performPendingRollback()` — only after a **successful** `git reset --hard` (a failed reset keeps the marker and the
  caller does *not* relaunch into a still-broken state, leaving it to the watcher's crash-restart). `isValidRollbackTarget(pending)`
  checks the marker is a hex SHA. If the next start's new code does not come up, `bootstrap.js` (both its `uncaughtException` and
  `unhandledRejection` paths) calls `performPendingRollback(repoRoot, log)`: `git reset --hard` and `app.relaunch();
  app.exit(0)` (**the same exit-code convention as a successful `apply-update`**); no valid marker → `app.exit(1)` **without**
  relaunch, left to the watcher's crash restart, as for any unhandled `uncaughtException` today. `GIT_RESET_TIMEOUT_MS` 15 s.
- **"What's new":** after the pull `pendingChangelog = <HEAD sha>`; the next start shows a one-off panel parsed from the top of
  `CHANGELOG.md` (`lib/update/changelog.js` `parseLatestSection(md)` → `{ heading, lines }`).
- **Dependency report** (Update view's "Dependencies" section): [infrastructure.md](infrastructure.md#diagnostics-log-startup-timeline-format-drift);
  report-only — packages update with the repo's commits.
- Tests: `test/update/self-update.test.js` uses real temp git repos (an `origin` + `work` clone pair with a real `@{u}`), temp
  `XDG_CONFIG_HOME`, `isValidRollbackTarget`, `performPendingRollback`.

## The desktop entry

`share/launchers-launcher.desktop` (the `@REPO@` token) is installed by `install.sh` `setup_desktop_entry()`; `Exec=` is
`bin/launchers-launcher-show.sh` (no `main.js`/renderer involvement); the `startWithSystem` autostart entry uses the same script.
Tests: `test/contracts/desktop-entry.test.js` + `shell.test.js`.

## Electron major upgrade checklist

Electron ships a major about every 8 weeks and only the **latest three** get security fixes, so a major is supported for roughly
half a year. When Settings → System → Update's "Dependencies" section shows `electron` two or more majors behind, it is time.
Step one or two majors at a time, never ten: the single native failure of the 28 → 44 jump (the missing `ozone-platform=wayland` →
SIGSEGV) only showed up on the machine and was hard to pin down.

1. **Preparation (agent/sandbox):** a branch `electron-<N>`; bump `package.json` `electron` and `npm install` (the `postinstall`
   downloads the binary); read the intermediate majors' breaking changes (`webPreferences` defaults, `sandbox`, `contextBridge`,
   `webContents` events such as `render-process-gone`/`will-navigate`, `app.getGPUFeatureStatus`, `BrowserWindow`
   fullscreen/`showInactive`); `npm run typecheck` (Electron's own `electron.d.ts` shows removed APIs as errors); `npm test` +
   `npm run test:e2e` at several resolutions (`E2E_WIDTH=3840 E2E_HEIGHT=2160`, `E2E_WIDTH=2560 E2E_HEIGHT=1080`); compare
   screenshots between the old and new version (`E2E_SHOTS=<folder>` on both branches, then a pixel diff — 28 ↔ 44 differed
   by ≤ 0.03 % (font anti-aliasing) and the search view 0.4–0.8 % (sub-pixel shift); look at anything bigger by eye); review the
   Chromium switches (`main.js` `app.commandLine.appendSwitch`) — a removed flag does not fail, it is silently ineffective.
2. **Machine test (the user, from a normal terminal — not from the Update sub-view):** a native crash (SIGSEGV) is not caught
   by `bootstrap.js`'s rollback, and `git reset` would leave the new binary in `node_modules`. So stop the watcher first:
   `systemctl --user stop launchers-launcher-watcher.service`, then `cd ~/launchers-launcher && git fetch && git checkout electron-<N> &&
   npm install && npm start`; the way back is `git checkout main && npm install` (the old zip is in `~/.cache/electron`), then
   start the watcher again. The manual list (all passed on 28 → 44): clean start with no black/flickering window and Diagnostics
   → Version showing GPU on and the right graphical platform; theme + background without a flash; the controller basics (◀▶,
   held-repeat, ✕ launch, △ Games, Select Settings, Start power menu); sound + rumble and no "unknown error" overlay; a Steam
   game (the launcher hides, no desktop flash on exit, it returns fullscreen); Heroic + RetroArch + a flatpak emulator launch and
   return; switching to a running launcher (● RUNNING) and returning when the PID disappears; melonDS PS closes the game (the
   kill-watch's un-hidden window); the PS combos (evdev); the foreground guard retaking focus; the screensaver after the set time
   and not starting on focus loss; the Games panel (cover grid, lazy covers, search with the docked keyboard); Settings (BT list,
   audio output, startup output + "Keep this display?" countdown); TV mode (start on the TV: monitor + audio + CEC; ○ held exits →
   desktop monitor/audio back); a second start (the `.desktop` icon) raises the existing window; the watcher's crash-restart
   (`kill -SEGV <electron pid>` restarts); the update query works; on GNOME too if available (X11 and Wayland, monitor switch).
3. **Wrap-up:** merge to `main` with `chore: electron <old> -> <N>`; adjust any "verified on Electron <N>" statement in
   these pages if behaviour changed; add any newly found gotcha to this list.
