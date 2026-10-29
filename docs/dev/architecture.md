# Architecture

Launchers Launcher is an **Electron kiosk app for a single machine** (the author's PC, KDE Plasma + Wayland; GNOME on X11 too
since 2026-09-26): a fullscreen, frameless launcher you navigate with a controller, used to start Steam / Heroic / RetroArch
and emulators. It is wired to a **"TV mode"**: host-level shell scripts under `bin/` (triggered by `systemd --user`) close
programs around the launcher; **the launcher itself** switches monitor and audio when entering TV mode (the `display` config
key's startup profile) and **powers the TV on over CEC** — but only when the startup monitor is the CEC adapter's connector
(the TV).

## Contents

- [Process and file map](#process-and-file-map)
- [`main.js`: the composition root](#mainjs-the-composition-root)
- [IPC conventions](#ipc-conventions)
- [Preload and the sandbox](#preload-and-the-sandbox)
- [Shared main/renderer files](#shared-mainrenderer-files)
- [Folder organisation rules](#folder-organisation-rules)
- [`lib/` folder map](#lib-folder-map)
- [Typing without a build step](#typing-without-a-build-step)
- [Data and assets](#data-and-assets)
- [Where to read next](#where-to-read-next)

## Process and file map

| Entry / file | Role |
|---|---|
| `bin/start.js` (`npm start`) | picks the ozone platform and starts Electron |
| `bootstrap.js` | the real entry (`package.json` `main`): single-instance lock, `try { require('./main.js') }`, global error safety net, self-update rollback — [install-update.md](install-update.md) |
| `main.js` | the composition root — below |
| `preload.js` | `contextBridge` exposing `window.launcher.*` |
| `index.html` + `renderer/**` + `styles/NN-*.css` | the UI; classic scripts, no build step — [renderer/overview.md](renderer/overview.md) |
| `controller-id.js`, `launcher-registry.js` | files shared by main and renderer |
| `lib/**` | Electron-free services (unit-testable) |
| `bin/*.sh`, `systemd/`, `share/` | host integration — [install-update.md](install-update.md) |
| `data/`, `assets/`, `themes/` | versioned data and artwork |
| `tools/` | developer tools (`new-emulator`, `capture-host-output`, `ref-toc`, `user-guide` screenshots) |
| `docs/user-guide/`, `docs/dev/` | end-user guide and this developer documentation |

## `main.js`: the composition root

`main.js` constructs the `lib/` services, calls the `lib/ipc/*` `register*Ipc({ ipcMain, … })` functions, and drives the
life cycle (`whenReady`, `forceQuitCleanup`, `relaunch`). **It contains no business logic and no `ipcMain.on/handle` call**:
a channel's name sits next to its handler in `lib/ipc/<domain>-ipc.js` (the size ceiling is `test/contracts/main-size.test.js`).
It has six numbered sections (`// ═══ N. … ═══`):

1. early steps before ready (logger **first**, `bootConfig`, safe mode, GPU, ozone) · 2. launcher-list state
(`launchers`/`launchersRaw`, `loadLaunchers()`) · 3. Electron-free services · 4. the window (`createMainWindow`,
foreground guard, `createLauncherMover`) · 5. IPC per domain + the launch state machine · 6. the life cycle.

A section depends only on the ones above it; callbacks handed over at construction run only after `whenReady`. The only true
cycles are the emulator descriptor ↔ `recentCovers`/`recentGamesMerge` (a lazy getter) and the construction-time callbacks
(`launchersPayload`, `onDerivedChanged`, …). A `register*Ipc` returns its handlers when main needs them
(`gamesHandlers.scheduleGamesWarmup`, `outputHandlers.abandonPendingMonitor`). The startup chain is one explicit dependency
chain (logger → config → launchers → services → `gamesHandlers`/`tvModeHandlers`/`outputHandlers` →
`foregroundGuard`/`createWindow`/`doNotDisturb`/launch controller → `app.whenReady`).

**Relaunch = `relaunch(reason)`** (`forceQuitCleanup()` + `app.relaunch()` + `app.exit(0)`) — the watcher's exit-code
convention in one place; `update-ipc` and the renderer-crash guard use it. `forceQuitCleanup` also stops a detached
inhibit, flushes the cover-miss cache and abandons a pending monitor switch.

## IPC conventions

Renderer → `window.launcher.X()` (preload) → `ipcMain.on/handle('event-name', …)`. Fire-and-forget actions use
`ipcRenderer.send` + `ipcMain.on`; queries returning data use `invoke` + `handle`. **Main → renderer feedback goes through
`sendToRenderer('event', data)`** — the guarded helper (`mainWindow && !mainWindow.isDestroyed()`); never call
`mainWindow.webContents.send` directly, because an async command finishing later may find the window `null`.

- **A new channel:** add it to the `CH` map of `preload.js` (grouped by direction), write the preload method with
  `CH.<key>`, and register it in its **domain's** `lib/ipc/<domain>-ipc.js` `register*Ipc` with a **literal string**
  (`ipcMain.on/handle('channel', …)`) — never in `main.js`. A new domain = a new `lib/ipc/<domain>-ipc.js` + one call in
  `main.js` section 5. `test/contracts/ipc-channels.test.js` fails if the two sides do not cover each other (its main-side scan
  takes every `lib/**/*.js` that calls `sendToRenderer(`).
- **`ipcMain` is wrapped once** (`guardIpcMain`, [infrastructure.md](infrastructure.md#validation-of-renderer-input)); fields
  from the renderer are taken over with `lib/validate.js`; every constructor calls `requireDeps` (`test/ipc/require-deps.test.js`
  enforces it).
- **A new `lib/ipc/*` constructor** (`register*Ipc` / `create*Handlers`) has the shape
  `function x(deps) { const { … } = deps; requireDeps(deps, [<fields without a default>], 'x'); … }`
  (`lib/ipc/require-deps.js`). A missing field then throws at **startup** — where the self-update rollback in `bootstrap.js` still
  protects — instead of on the first IPC call hours later. Only `undefined` counts as missing; `null` is an intentional "none".
- **Related domains in one call** (`lib/ipc/ipc-groups.js`, because of the `main.js` line cap): `registerLauncherListIpc` =
  launcher-manage + launcher-variant (the variant module receives manage's `saveLauncherEntry`); `registerGamesDomainIpc` =
  games + recent (`loadGames`) + game-sources (`invalidateGameSource`). The channels stay in the member modules, whose
  constructors check their own deps.
- **Domain files worth knowing** (all `register*Ipc({ ipcMain, … })`):
  `diagnostics-ipc.js` — the Log sub-view (`readLogTail` reads only the END of the file), export, renderer errors, the startup
  timeline, `get-app-info`, the self-test, missing-package install;
  `update-ipc.js` — self-update, config restore, "What's new" (the relaunch is injected);
  `bluetooth-ipc.js` — Bluetooth devices and the PS-combo pad;
  `wifi-ipc.js` — the Wi-Fi picker;
  `system-power-ipc.js` — power actions and `quit-launcher`;
  `clipboard-ipc.js` — `read-clipboard-text`, the Ctrl+V of the on-screen keyboard (the main-side `clipboard`).
- **List handlers** (`list-audio-sinks`, `list-monitors`, `list-bt-devices`, `read-log`, …) return **`{ ok, items }`** through
  `safeList(label, fn)`, not a bare array. `ok: false` = the command failed (timeout …); the renderer then shows
  `renderSubviewError(...)` instead of a silently empty list. **Follow this for every new list handler**, and on the renderer
  side `if (!res.ok) { renderSubviewError(...); return; }`. (`handleBtAction`'s `bt-device-changed` payload is a bare `devices`
  array — that is a push, not a handler reply.) **`safeList` is defined at the top of `main.js`, right after `sendToRenderer`**,
  because the games/TV/output handlers need it at their own construction.
- **Trivial get/set pairs** are one `registerPrefChannel(getChan, setChan, changedEvent, { get, set, sideEffect, label },
  valueKey)` call in `lib/ipc/prefs-ipc.js` (the three names stay literals).
- **`log-client-error`** (renderer → main) writes renderer errors to the log as `[renderer] <context>: <message>`
  (fields stringified, capped at 4000 chars; the line shape is `lib/client-error-log.js`) so the Log sub-view shows a renderer
  crash too — on a kiosk without devtools this is the only trace of one.
- **Push channels worth knowing:** `running-changed` (the ● RUNNING badge; deliberately separate from `launchers-changed`,
  which makes the renderer show an "ORDER SAVED"/"LAUNCHERS UPDATED" toast), `app-launched`, `app-closed`, `app-error`,
  `games-warmup-state`, `active-session`, `launchers-changed`, and the `*-changed` push of every preference.
- **Launcher-removal undo trash, install in flight, monitor switch queue:** one-element main-side state in the relevant
  `register*Ipc` closure.

## Preload and the sandbox

Electron ≥ 20 (including the project's `^44`) runs the preload with `sandbox: true`; `mainWindowOptions()`
(`lib/launch/main-window.js`) writes it out explicitly, with `spellcheck: false`, and `guardNavigation()` forbids
`will-navigate` / `window.open` so the kiosk window never leaves `index.html` (`test/contracts/window-hardening.test.js`).
`spellcheck: false` because the UI has no text field (the on-screen keyboard is its own DOM) and on Linux Chromium would fetch Hunspell dictionaries from a
Google CDN. The navigation lock exists because a stray `<a href>` (in a theme/changelog) or a drag-and-drop would otherwise navigate the whole kiosk window
away with no way back; the fatal overlay's `location.reload()` is not a `will-navigate`, and both guards log a `log.warn`.
In a sandboxed preload **`require()` works only for a few built-ins** (`electron`, `events`, `timers`, `url`): requiring a
local file (e.g. `require('./data/launcher-catalog.json')`) fails silently/with an error at the top of the script, so
`contextBridge.exposeInMainWorld(...)` never runs and **`window.launcher` is missing entirely** (an early `TypeError`
stops every `renderer/*.js`: no cards, no gamepad). Anything the preload needs from a file or config must be loaded in
**the main process** and passed through `ipcMain.handle` + `ipcRenderer.invoke` (as `get-launchers` and `list-audio-sinks`
do).
**The one exception, for synchronous data before first paint:** `get-boot-state` (`ipcRenderer.sendSync` in the preload,
`ipcMain.on` + `event.returnValue` in main) returns the theme, background map, launcher icons and safe-mode flag
**blockingly** so the `<head>` boot script can set the theme without a flash. Use `sendSync` only for such rare start-up
cases.

The preload's `CH` map holds **all IPC channel names** (main is the other side; the preload is sandboxed and cannot share a
file by `require`). `module.exports = { api }` (guarded) exists only for the type export.

## Shared main/renderer files

- **`controller-id.js`** — controller-type detection shared by main and renderer (`classifyController(text)` → `dualsense` /
  `dualshock` / `xbox` / `generic`); works as `require` and as a `<script src>` (an IIFE + a guarded `module.exports`; the CSP
  `script-src 'self'` allows it). Main calls it with the `bluetoothctl` Modalias+Name blob, the renderer with the Gamepad
  API's `pad.id`. **Never rewrite the vendor/product logic elsewhere.** It also holds `CONTROLLER_SYMBOLS` and
  `controllerSymbols(type)` ([devices.md](devices.md#controller-identification-and-battery)).
- **`launcher-registry.js`** — the shared data registry of the Games panel's emulator sources
  ([launchers/README.md](launchers/README.md#module-layout)); loaded by `<script src>` after `controller-id.js` and before the
  renderer. Test: `test/launcher-registry.test.js`; `test/contracts/launcher-tables.test.js` fails when a table row is missed.

## Folder organisation rules

**Mandatory for every new file in the whole project** (user decision, 2026-09-24: files go into the logically fitting folder
**from the start** — later "packing" is expensive, and a thematic structure reads better to a human):

1. **Group by role/domain, not by technical type** (`lib/ipc/`, `lib/launchers/`, `renderer/settings/`, `docs/dev/<topic>`).
2. **If a fitting folder exists, the file goes there**, even if the root is "handy": a new `*-ipc.js` into `lib/ipc/`, a new
   emulator module into `lib/launchers/`, a new sub-view into `renderer/settings/`.
3. **No folder yet but the new file is the 2nd member of a family** (same role/domain): create the folder **now** and move the
   first member in the same change — do not wait for five. A single lonely file needs no folder of its own.
4. **Roots** (repo root, `lib/`, `renderer/`) hold only entry points and truly lonely, widely used infra
   (`lib/config.js`, `lib/exec.js`, `renderer/util.js`).
5. **The file name stays unique project-wide, with its role suffix** (`lib/ipc/games-ipc.js`, `lib/launchers/steam-library.js`,
   `renderer/settings/settings-audio.js`) — grep, stack traces and the log stay unambiguous; the folder name does not replace
   the suffix.
6. **Tests mirror the source subfolders**: `lib/ipc/x.js` → `test/ipc/x.test.js` (the glob finds them recursively; a test in a
   folder requires `../../lib/...`, the repo root is `path.join(__dirname, '..', '..')`). Exceptions: repo-level contract tests in
   `test/contracts/`, shared helpers in `test/helpers/`.
7. **When moving / making a folder, update:** relative `require`/`import('./types.js')` paths (one level up: `../exec.js`), the
   `main.js` requires, the `index.html` `<script src>` lines (**renderer load order matters**), tests that read source
   (`test/contracts/ipc-channels.test.js`, `renderer-smoke.test.js`, `dom-ids.test.js`), `jsconfig.json` `include`, and docs
   references. Use `git mv`. A test that reads a source as `path.join(root, 'lib', '<file>')` is not caught by a require rewrite —
   update it by hand (the `test/contracts/` tests walk `lib/`/`renderer/` recursively and need no change).

## `lib/` folder map

| Folder | Contents |
|---|---|
| `lib/` (root) | shared infra: `config`, `config-migrations`, `config-boot`, `config-transfer`, `exec`, `timings`, `ozone-platform`, `desktop-env`, `parse`, `prefs`, `xdg`, `net`, `fs-atomic`, `flatpak`, `ttl-cache`, `types`, `dir-browse`, `client-error-log`, `evdev-pads`, `safe-mode`, `gpu-fallback`, `log-lines`, `startup-timeline`, `system-power`, `fatal-policy`, `validate`, `launcher-list` (launcher **list** config handling — `customLaunchers`/`launcherOrder`/accent/v2 migration; not to be confused with the `launchers/` folder) |
| `lib/ipc/` | IPC per domain (`*-ipc.js`, `finish-setup.js`): handler body + channel registration (`register*Ipc({ ipcMain, … })`); `require-deps`, `ipc-guard`, `ipc-groups` |
| `lib/host-deps/` | the machine's system dependencies: `selftest`, `host-packages`, `format-drift` |
| `lib/launchers/` (+ `shared/`) | per-launcher/emulator discoverers (`<x>-library.js`), `emulator-sources.js`, `rom-access.js`, `flatpak-grants.js`, `custom-roms-library.js`; `shared/` = the common format parsers/helpers |
| `lib/launch/` | launch / window state / running detection (`launch-controller`, `launch-errors`, `launch-options`, `running`, `running-poll`, `window-activate`, `window-to-output`, `main-window`, `foreground-guard`, `do-not-disturb`) |
| `lib/output/` | display / audio / TV (`displays` + `displays-kde`/`displays-gnome`, `audio`, `cec`, `tv-mode`, `startup-outputs`) |
| `lib/recent/` | usage + "recently played" + cover fill-in (`usage`, `recent-games`, `recent-games-merge`, `recent-covers`, `session-refresh`, `games-first-seen`) |
| `lib/games/` | the Games panel list merge + warm-up + cache clearing + details (`games-list`, `games-warmup`, `games-cache`, `game-details`, `game-metadata`) |
| `lib/scan/` | worker-thread library scan (`scan-pool`, `scan-worker`, `scan-sources`, `scan-meta-cache`) |
| `lib/sidecars/` | state files for shell scripts / the DE (`main-controller`, `autostart`, `tv-mode-enter`, `xdg-autostart`) + the start-up resync (`sidecar-sync`) |
| `lib/bluetooth/` | BT device management + the BT-trigger signal parser |
| `lib/apps/` | installed applications for the "＋ Add launcher" wizard (`desktop-entries`, `installed-apps`, `app-icons`) |
| `lib/network/` | the Wi-Fi picker's `nmcli` (`wifi`) — ≠ `lib/net.js` (the downloader) |
| `lib/update/` | self-update + "What's new" + dependency report |
| `lib/saves/` | game save discovery + backup (`save-sources`, `save-backup`; handlers in `lib/ipc/saves-ipc.js`) |

The renderer's folder map is in [renderer/overview.md](renderer/overview.md#file-layout-and-script-order).

## Typing without a build step

Every `lib/*.js` starts with `// @ts-check`; `jsconfig.json` has `checkJs`, `strict: false`, `types: ["node"]` (no DOM for `lib/`),
`resolveJsonModule`. `lib/types.js` carries **only JSDoc `@typedef`s** (`Launcher`, `DisplayConfig`, `DesktopProfile`,
`FeedbackPrefs`, `MainController`, `TvModePrefs`, `UsageEntry`, `RecentGameEntry`, `Monitor`, `AudioSink`, `Logger`) and exports `{}` at
run time. Reference with `/** @param {import('./types.js').Launcher[]} x */`. **`npm run typecheck`** = `tsc -p jsconfig.json &&
tsc -p jsconfig.renderer.json` (no transpile; `npm start` is untouched; `test/contracts/typecheck.test.js` runs it inside
`npm test`, `t.skip()` if `typescript` is not installed — a fresh clone before `npm install`). `preload.js`, `main.js` and
`bootstrap.js` are included (Electron 44 ships its own `electron.d.ts`); `controller-id.js` too (`// @ts-check` + `/// <reference
lib="dom" />`). The preload's `window.launcher` API is an `api` constant. **The renderer is a separate project:**
`jsconfig.renderer.json` (`lib: dom`, `module: preserve` — `node16` would treat the CommonJS package's `.js` as modules) +
`renderer/globals.d.ts` (`window.launcher` = `LauncherApi`, copied from the preload's `api` with a **mapped type** — an
object literal defined in JS has an "open" type [JSLiteral] on which a mistyped method would not be an error). **Both projects have
`noUnusedLocals: true`**; `.editorconfig`: 4 spaces, LF. A new error gets a real fix (a JSDoc type / `/** @type {HTMLElement} */
(…)` cast) — **never `@ts-ignore`**.

## Data and assets

- `data/launcher-catalog.json` (the launchable catalog — see [config-keys.md](config-keys.md#launchers)), `data/backgrounds.json`
  (built-in backgrounds), both `require`d by main; `themes/themes.json` deliberately stays in `themes/`.
- `assets/icons/<id>.(png|svg)` — launcher icons **local and versioned** (no remote URLs: the kiosk works offline); a
  `data/launcher-catalog.json` / `customLaunchers` `icon` is a relative path; `assets/backgrounds/<id>.svg`.
- `styles/NN-*.css` — the whole renderer CSS (the `neon` base theme) in 7 numbered files: `01-base` tokens/modes · `02-home` ·
  `03-status` toast/loader · `04-panels` Settings + common panel elements · `05-keyboard` · `06-games-panel` ·
  `07-screen-overlays` TV exit/volume/screensaver/error; plain `<link>`s in `index.html` **in numeric order** (the number is the
  cascade position; `test/contracts/css-links.test.js` guards it; a new file = the right number + one `<link>`); a relative
  `url()` from `styles/` is `../assets/...`. Separate files rather than an inline `<style>` — a static file load, not a bundler.
- `share/launchers-launcher.desktop` — the desktop-entry template (`@REPO@` token).

## Where to read next

[README.md](README.md) is the index. The per-domain pages: [infrastructure.md](infrastructure.md),
[config-keys.md](config-keys.md), [launching.md](launching.md), [games-panel.md](games-panel.md), [launchers/](launchers/README.md),
[output-tv.md](output-tv.md), [devices.md](devices.md), [platforms.md](platforms.md), [install-update.md](install-update.md),
[renderer/](renderer/overview.md), [themes.md](themes.md), [testing.md](testing.md).
