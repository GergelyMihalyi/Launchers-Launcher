# History: what was removed or replaced, and why it matters

Only things that could come back as a question, or whose "why not that way" saves a dead end. The full record is in git.

## Removed or replaced

- **The root udev trigger chain (removed 2026-09-10).** A rule in `/etc/udev/rules.d/99-dualsense-tv-mode.rules` watched BT
  gamepad connects and ran `/usr/local/bin/dualsense-tv-mode.sh` **as root**, which dropped back to the user with
  `sudo -u` / `su -l`; the TV-mode exit was a hard-wired `/usr/local/bin/tv-mode-exit.sh`. Replaced by the root-free
  `systemd --user` chain (BT trigger watching BlueZ over D-Bus + `sweep_connected` at start-up + `tv-mode-enter.sh` from the
  sidecar); the exit moved into the main process. Removal criteria that were verified before deleting: reconnect churn
  clean and `gdbus monitor` survives `systemctl restart bluetooth`; days of stability; no SDDM-autologin on the machine, so
  "fires as root before login" gave nothing (the watcher socket and the user's apps only exist after the session starts);
  the "already connected when the watcher starts" gap closed by `sweep_connected`; a cold start with the controller left on
  confirmed (the launcher entered TV mode by itself after login). The old files and the `sudo rm` were done on the machine
  and in the repo.
- **`bin/dualsense-connect.sh`** and the four old root JSON files (`launcher-order.json`, `launchers-custom.json`,
  `display-config.json`, `theme-config.json`) — the latter are merged once by `config.migrateFromLegacy()` (not deleted; a
  `_migratedFrom` marker is written; `.gitignore` covers them on the development machine).
- **Built-in launchers (launcher model v2).** Steam/Heroic/RetroArch used to be fixed built-ins; now they are catalog entries
  (`common: true`) and every active launcher lives in `customLaunchers` and is removable. A one-off migration copied the three
  into `customLaunchers` for installs that had finished setup. The old, always-empty `data/launchers.json` was deleted
  2026-09-24.
- **Per-emulator IPC channels** (8 emulators × 3 channels) → the three shared `{ source }` channels (2026-09-26).
- **TV volume/mute on the main menu (Square + L2/R2, 2026-09-11):** the buttons were freed for other roles; the CEC handlers
  remain unbound.
- **△ as the Settings button** → Select/View; △ now opens the Games panel. PS alone used to quit the launcher; it is now a
  deliberate no-op and PS+○ quits (2026-09-22).
- **The `feedback.wideSettings` switch** (a 4K-only conditional two-column Settings layout with an `@container` query): the
  panel is now always a fixed-size two-column box (2026-09-13).
- **The overlapping "solitaire" cover cascade** in the Games grid (≈ 68 % row overlap): replaced by an even gap on request
  (2026-09-17).
- **A per-launcher "ensure all missing covers at once" download** → the windowed lazy fetch shared by all network-cover
  sources (2026-09-22).
- **`--disable-gpu --disable-software-rasterizer` in `npm start`** → hardware GPU by default (software rendering cost ~38 %
  of a core idle vs ~7 %); there is deliberately no `--disable-software-rasterizer`.
- **The Games panel's old "12-step paging" D-pad** (RetroArch ROM list) → a real cover grid with letter jump (2026-09-18).
- **The Heroic/RetroArch-only "recently played" panel strip** → one cross-source strip from `globalRecentGames`.
- **The old fake 2 s `.loading-bar`** and the grey skeleton rows → the shared launcher-icon loader.
- **Per-theme `--glow` hack** → the `--focus-shadow` full-value token.

## Deliberately rejected (do not re-add)

- **`pkill -f <pattern>` in TV mode** — it killed the system-wide VS Code (the pattern `vscode` also matched
  `/usr/share/code/...`). `tv-mode-enter.sh` uses only `flatpak kill` by id and `pkill -TERM -x` with the **exact** name.
- **Automatic launcher reordering by usage** — a predictable card position is the point on a kiosk; the manual pin (and the
  passive `★ FAVORITE` badge) cover the need.
- **A separate `systemd/launchers-launcher.service`** (the "B" variant) — dual life-cycle responsibility next to the watcher; the
  crash-restart lives in `bin/launchers-launcher-watcher.sh`.
- **Replacing `cec-toolbox` wholesale with raw `cec-ctl`** — `powerOnTv()` stays fallback-only (`cec-toolbox on` first).
- **A `display.cec` `"auto"/"always"/"never"` enum** and an HDMI-hotplug poll — the `tvIsStartupMonitor` bool + connector match
  is enough. (The targeted `display.cecPowerOn: false` kill-switch is a separate, allowed opt-out bool.)
- **A comment diet in hot-path files** — the user rejected it (2026-09-08): the generous Hungarian comments are intentional.
- **A bundler/build step for the renderer, mandatory ESLint/Prettier, multiple user profiles** — against the project's pillars.
- **An immediate stderr capture of launched apps** — SIGPIPE risk when the launcher quits, and Steam/Proton output would grow a
  file for hours.
- **Auto-granting flatpak filesystem access to every emulator** (extending the melonDS model silently) — it widens a sandbox
  without asking; the shipped design is "show, then grant on confirmation, keep a revocable record".
- **A synchronous main-process fallback when the scan worker fails** — it would reintroduce the freeze; failures degrade to
  errors and a cooldown instead.
- **Lazy loading of emulator library modules at start-up** — measured: loading all of them is ~36 ms cold, not worth the
  complexity.
- **A "what should I play?" random picker** (user: "no random") and **a per-user profile by controller** (a "multiple user profiles" idea, rejected as against
  the project's pillars; only a deliberate reversal could bring it back) — and a `strict: true` TypeScript setup.
- **A daily playtime limit / parental control** (a PIN-protected per-day cap that would end a game with a warning 10 minutes before): the user declined it
  (it also clashes with the "no multiple profiles" pillar); the shipped, non-blocking variant is the playtime *reminder* shown on return from a game.
- **Sending CEC standby when switching *away* from the TV** to a desktop monitor — only power-on is implemented; standby on switching back could disturb an AVR-passthrough
  setup (a `standbyOnExit` hand flag covers leaving TV mode instead).
- **Ball-to-ball collisions in the screensaver:** measured as negligible in CPU/GPU (n ≈ 4–12 icons → tens of pair checks; no tunnelling at ≤ 7.5 px/frame), so purely
  an aesthetic and complexity decision: it needs a `resolveCollisions(icons)` over the whole array (worse testability than the pure per-axis `stepAxis`) and a
  non-overlapping spawn; left out.
- **Considered and dropped in the Electron 44 review:** replacing `get-boot-state`'s `sendSync` by `webPreferences.additionalArguments` (~1 ms gain, a second data path to
  maintain); moving `lib/net.js` to Node 24's global `fetch` (the redirect/`maxBytes`/timeout logic must stay and `lib/` is tested on Node ≥ 22.12); `@types/node`
  ^22 → ^24 (it would admit APIs the supported Node 22.12 lacks — only together with an `engines` bump); a blanket rewrite to modern CSS
  (`@starting-style`, `:has()`, container queries) — adopt it when a file is touched anyway; scan workers → Electron `utilityProcess` (Electron-independence of `lib/` matters more).
- **Persisting the sleep timer** — a self-arming timer is wrong on a kiosk; it is session-only.

## Decisions whose reason is easy to forget

- Config keys never change type; a new shape gets a new name (a downgrade guard protects a rollback).
- The scan metadata cache persists only when a worker explicitly enables it, so tests cannot wipe the real cache.
- `bootstrap.js` is the entry so a parse error in `main.js` is catchable and the self-update rollback can act; the
  single-instance lock lives there too.
- `main.js` is a pure composition root with a line ceiling (`test/contracts/main-size.test.js`); every channel name lives next
  to its handler in `lib/ipc/<domain>-ipc.js`.
