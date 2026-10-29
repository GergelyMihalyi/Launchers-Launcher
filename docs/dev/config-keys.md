# Config keys (`~/.config/launchers-launcher/config.json`)

Schema, defaults, behaviour and gotchas of every key. How the store itself works (atomic writes,
`KEY_TYPES`, migrations, backups, transfer) is in [infrastructure.md](infrastructure.md#config-store).

**Rules for a new key:** add it to `KEY_TYPES` in `lib/config.js`; never change an existing key's
type (a new shape = a new name); if it is a trivial get/set pair, register it with one
`registerPrefChannel(...)` line in `lib/ipc/prefs-ipc.js` (the three channel names stay literal
strings at the call site — `test/contracts/ipc-channels.test.js` extracts them with a regex); add it
to `PORTABLE_KEYS` only if it is machine-independent and carries no command or path. The main
process **only stores** preference values — the effect (theme, scale, sound…) is applied in the
renderer or the relevant service.

## Look and language

| Key | Type | Notes |
|---|---|---|
| `theme` | object | Active theme id (whitelist from `themes/themes.json`, unknown → `neon`). `get-boot-state` is a **synchronous** `sendSync` returning `{ theme, background, launcherIcons, safeMode }`; the preload exposes it as `window.launcher.initialTheme` etc., and the boot scripts in `<head>` apply it before first paint (no flash of the default theme). Use `sendSync` only for rare startup cases — it blocks the UI. |
| `language` | string | `hu` (default) / `en`. Every user-visible string goes through `tr()` and must exist in **both** tables. Applies live (no restart). The setup wizard persists it too. |
| `uiScale` | string | `small` / `normal` (default) / `large` → `--ui-scale` 0.88 / 1 / 1.15 multiplying the root `rem`; the carousel's `vh`-clamped card size is unaffected. |
| `background` | object | **Per-theme** map `{ <themeId>: { type: none|builtin|custom, id?, path? } }`. `builtin` = `assets/backgrounds/<id>.svg` (whitelist `data/backgrounds.json`), `custom` = a file under `~/Pictures/launchers-launcher/`. Renderer: the `#bgCustom` layer above `.bg-glow` plus a mandatory dark scrim; `applyBackground` is the only place that sets it, `applyBackgroundForTheme` is called on init, on push and on theme change. Known limit: the fixed scrim is tuned for dark themes, so contrast outside the cards is weaker on the light `win31` theme. A background hides the `xp` Bliss image and every theme's `--ambient`. |
| `feedback` | object | `sound`, `rumble`, `motion` (default on, `!== false`), `contrast`, `slowRepeat`, `screenReader` (default off, `=== true`). New switch = one line in `FEEDBACK_DEFAULTS` + one in the renderer's `FEEDBACK_ROWS`; the renderer normalises with `normalizeFeedback(raw)` — do not destructure the push payload by field. `screenReader` also enables `force-renderer-accessibility` from the next start. |
| `recentGamesUi` | object | `{ continueBar, gamesPanelRecent, launcherRecent }`, all default on. Each strip decides its own visibility from its source function (and gamepad navigation reads the same), so switching one off also removes its navigation zone with no extra guard. |
| `screenDim` / `nightMode` | number | Software dim 0/20/40/60 % and warm filter 0/1/2 as overlay layers over the launcher UI only (no DDC; the game and the monitor brightness are unaffected). |
| `idleTimeout`, `volumeStep`, `volumeMax`, `tvExitHold`, `autoSuspend`, `idleDisconnect` | number | Whitelisted selector values (`enumPref`; unknown → the default, which equals the previously hard-coded value). `idleTimeout` 0/3/5/10/30 min (0 = screensaver off); `volumeStep` 2/5/10 %; `volumeMax` 100/85/70/50 % — enforced **in the main process** by `stepVolume` (never pulls an already-higher volume down; TV/CEC volume unaffected); `tvExitHold` 3/5/8/10 s — **deliberately no "off"** (○ hold is the only controller exit from TV mode; PS+○ closes the launcher); `autoSuspend` 0/30/60/120 min and `idleDisconnect` 0/10/20/30 min are measured by `renderer/home/idle-power.js` only while the launcher is focused. New numeric selector = `createPrefSelectSubview(...)` + `enumPref` + `registerPrefChannel(..., 'value')` + `KEY_TYPES: 'number'` + one `onPrefSelectChanged(...)` line in `renderer/ipc.js`. |

## Launchers

| Key | Type | Notes |
|---|---|---|
| `customLaunchers` | array | **The active launchers** (all `custom: true`, all removable — there is no built-in launcher since model v2). Added by `add-launcher`; a full-object payload first passes `checkLauncherPayload` (see below). `remove-launcher` also removes the id from `launcherOrder`, and deletes the launcher's custom ROM source and imported icon. |
| `launcherOrder` | array | Display order (ids). Unknown ids dropped; launchers not listed go last in native order. After a reorder the carousel rebuilds and focus returns by id. |
| `launcherAccents` | object | `{ id: '#rrggbb' }` override of a launcher's accent; invalid hex ignored. |
| `launcherPaths` | object | `{ <catalog-id>: <absolute executable> }` — a manually located native launcher (AppImage/tarball outside `PATH`). It is the **first candidate** of `nativeCmdsOf`, so detection, variant detection and the payload gate all handle it. Only absolute paths; the file must exist, be a plain executable and not an interpreter. `find-launcher-executables` suggests candidates (name / AppImage id, one level deep). |
| `customGameSources` | array | `[{ launcherId, dirs, exts, argsTemplate }]` — a ROM folder for an added launcher that has no library module (see [launchers/README.md](launchers/README.md#custom-rom-folders)). |
| `_launcherModelV2`, `setupDone`, `configVersion` | boolean/boolean/number | Migration marker, "setup wizard finished", schema version. A migration on an install with `setupDone: true` and no marker copies the old three built-ins (steam/heroic/retroarch) into `customLaunchers`; a fresh install only writes the marker and the wizard adds launchers. |

**Catalog** (`data/launcher-catalog.json`): the versioned list of launchers a user can add. Fields:
`id`, `name`, `hint`, `icon`, `cmd`, `args`, `accent`, optional `flathubId` (for in-app
`flatpak install`) and `common: true` (steam/heroic/retroarch — first in lists, pre-ticked in the
wizard). **Every entry has `nativeCmd`** (a string or a candidate list for distro-specific binary
names, e.g. `["pcsx2-qt","pcsx2"]`; first one on `PATH` wins; optional `nativeArgs`), or
`"flatpakOnly": "<reason>"` when no native release exists (`test/contracts/data.test.js`). A
catalog entry is not launchable by itself — `add-launcher` copies a full object into
`customLaunchers`. `list-launcher-catalog` runs a best-effort install detection per entry
(`flatpak info`, otherwise `which`; 5 s) and reports `installed: true|false|null`, or
`'native'|'flatpak'|'both'|false` for dual entries. Icons are local (`assets/icons/<id>.(png|svg)`,
relative paths) — a kiosk must work offline; a missing file falls back to an inline SVG.

`lib/launcher-list.js` owns the launcher-list config handling: `customLaunchers`, `launcherOrder`, accent overrides, the v2
migration and `isLauncherInstalled`.

**`checkLauncherPayload`** (in `lib/launcher-list.js`) is the security gate of `add-launcher` (the renderer must not be able to
register an arbitrary command): `flatpak run <appid>` (no flatpak option between `run` and the id),
a catalog `nativeCmd` without arguments, or a custom command that is a plain name / absolute path,
**not** a shell, interpreter or wrapper (`bash`, `python3`, `env`, `sudo` …) and that `which` can
find. `id` matches `[A-Za-z0-9._-]{1,64}`; `icon` must be `assets/icons/*` or a `file://` URL into the
launcher's own icon folder (`~/.local/share/launchers-launcher/icons/`, filled by the main process
from an icon-theme/pixmaps root only, ≤ 2 MB). Extend this function for any new add-launcher
shape; never bypass it. A hand-edited `config.json` is deliberately not filtered.

**Variants:** the installed native/flatpak variant is derived from `cmd`. One variant present →
used (the startup `repairLauncherVariants()` rewrites a stale one); both → flatpak is recommended,
switchable with □ (`set-launcher-variant`). The variant determines the data root and the game launch
(`variantExecSpec`); saves look at both roots.

## Startup, TV and output

| Key | Type | Notes |
|---|---|---|
| `mainController` | object\|null | `{ mac, name, type }`; `null` = any controller. Mirrored to a sidecar; **the filtering itself happens in the trigger script's guard**. |
| `controllerAutostart` | boolean | Default true. `false` makes the trigger script skip launching on a controller connect (guard step 0, before debounce); the icon still starts the launcher. Never touches the systemd units. |
| `alwaysOnTop` | boolean | Default true: the foreground guard retakes focus on blur except during a launch sequence; `false` makes `guard()` a no-op. In-process only, no sidecar (no shell consumer). |
| `startWithSystem` | boolean | **Default false** (opt-in, unlike the two above): XDG autostart entry so the window opens at login. Independent of `controllerAutostart`. No sudo, no systemd/install change. Reconciled at startup (a manually deleted file is restored/removed to match). |
| `tvMode` | object | `{ closeFlatpak, closeNative, preCommands }` run on TV-mode entry by `bin/tv-mode-enter.sh`: `flatpak kill` (only if `flatpak ps` shows it running), `pkill -TERM -x <name>` (**exact** match), `bash -lc '<cmd>'`. **There is deliberately no `pkill -f`** — a pattern like `vscode` once killed a system-wide VS Code. Machine-specific, empty by default. UI covers `closeFlatpak` only (running apps as checkboxes, flatpak-only); `closeNative`/`preCommands` stay hand-edited because native GUI process discovery on Wayland is non-trivial. |
| `display` | object | See below. |
| `doNotDisturb` | boolean | Default true: notifications are muted during a launch sequence (`lib/launch/do-not-disturb.js`); `false` also stops a live inhibit. |
| `gpuFallback` | object\|null | See [infrastructure.md](infrastructure.md#stability-safe-mode-fatal-errors-gpu-fallback). |
| `pendingUpdateRollback`, `pendingChangelog` | object\|null, string | Self-update markers ([install-update.md](install-update.md)). |

### `display`

Two independent profiles plus flags.

- **Startup / TV profile** `{ monitor, sink }` (Settings → Picture and sound → Startup display and
  sound). Applied at `app.whenReady` → `applyStartupOutputs()` **before the window is created**
  (capped by `STARTUP_OUTPUTS_MAX_WAIT_MS`, 7 s): if the window loses its output *while* opening it
  never appears (seen on Electron 44 — one monitor turned off and no picture; a startup race, while a
  runtime switch is fine because KWin moves the window). The chosen monitor becomes the only enabled
  output (others disabled unless `keepOtherMonitors`), the chosen sink the default device. **Both
  are guarded**: a monitor that is not connected or a sink that is not in `pactl list sinks`
  (hand-edited config) is a logged no-op, not a crash. `set-startup-monitor` / `set-startup-sink`
  apply immediately; `set-startup-monitor` also calls `maybePowerOnTv()` (fire-and-forget) so picking
  the TV wakes it exactly like at boot.
- **Behaviour flags** (Monitors and TV (CEC) sub-view, `set-output-behavior`): `keepOtherMonitors`
  (true = do not disable the rest), `cecPowerOn` (default true, only `false` stored → skip CEC
  power-on). `normalizeDisplayConfig` keeps flags only at non-default values and `writeDisplayConfig`
  re-normalises on write.
- **Desktop profile** `desktop: { monitors[], sink, disableOthers, pinned }` — used on TV-mode
  *exit*; see [output-tv.md](output-tv.md). No UI: it is rewritten at every start by
  `captureDesktopSnapshot()`. `pinned: true` (hand-edited) stops the rewrite.
- **Hand-edited TV flags:** `tvIsStartupMonitor` (force CEC power-on, e.g. AVR passthrough),
  `cecTarget` (1..15, default 0 = TV, 5 = audio system), `standbyOnExit`. All are silent no-ops on
  a machine without CEC.

## Games

| Key | Type | Notes |
|---|---|---|
| `usage` | object | `{ <id>: { count, lastLaunchedAt, totalMs?, lastSessionMs? } }` for launcher apps and game cards. The id is the `spawnGame` `appId`: a static launcher id for `launch-app`; `steam-game-<appid>` / `heroic-game-<appName>` for games; **one shared `retroarch-game` literal for every RetroArch launch** (not per ROM). Recorded only on a successful spawn / switch (not on a spawn error). Shown as a passive badge — **no automatic re-ordering** (a predictable card position matters on a kiosk): `★ FAVORITE` needs `count ≥ 2` and an unambiguous maximum. `lastLaunchedAt` also decides the carousel's initial focus (`mostRecentLauncherIndex`, only on first render, never a jump afterwards). Decorated into `get-launchers` / `launchers-changed` (no separate usage IPC). |
| `recentGames` | object | Launch-time recent lists for **Heroic, Ryujinx, Lutris (mirror), Cemu, Dolphin, melonDS**: `{ <launcherId>: [{ key, name, cover, kind, params, lastLaunchedAt }] }`. Sources in `DERIVED_RECENT_LAUNCHER_IDS` (steam, retroarch, pcsx2, rpcs3, ppsspp, duckstation) are **not** stored here: their recent list is derived at read time from the launcher's own data (30 s TTL cache in `usage.js`). Lutris is the exception to both: its list comes from `lutris`'s own `lastplayed`, but because that is an async CLI it is mirrored into `recentGames.lutris` (startup + after every game) so the synchronous `decorateLaunchers()` sees it. Local-decoded covers (Cemu, melonDS) arrive ready; network-cover sources (Ryujinx, Dolphin) are fetched fire-and-forget after the write and the cover is written back. **Every `findRecentlyPlayed()` must return `lastLaunchedAt` as an ISO string** — a raw ms number becomes `NaN` in `Date.parse` inside `mergeRecentGameLists`, so the entry sinks to the end of the merged "Continue" list and is dropped when the list is full (seen on DuckStation; guarded by `Number.isNaN(Date.parse(...))` assertions in the four `*-library` tests). |
| `favoriteGames` | array | Pinned games `[{ key, name, cover, kind, params }]`, max 24, newest first. Same `key` scheme as `recentGames`. RetroArch ROM favorites are pinned with `cover: null` and their cover is resolved live from disk on every read (`withResolvedAllCovers`), never written back — a cheap `existsSync` list that self-heals. |
| `hiddenGames` | array | Hidden games' favorite-keys (≤ 5000, deduplicated). Hide from the details view; reveal with the filter popup ("Show hidden games", per run). Filtering is renderer-side (MIND, single source, RetroArch drill-down) and does not affect ★ FAVORITE. **A memoised view keys on the Set identity — always create a new Set when changing it.** |
| `gamesHiddenSources` | array | Sources excluded from the aggregated ALL view **only**; the source's own chip and the card quick-menu still reach it. |
| `gamesViewMode` | object | `{ <source|all>: grid|list }`, only deviations stored; default `all` → list, others → grid. The RetroArch root system summary is not switchable; `retro` controls the full ROM list inside a system. |
| `gamesSortMode` | object | `{ <source|all>: name|recent|playtime|added }`, R3 cycles it. Data comes from `usage` (games launched **through the launcher only**); sortable games first, the rest and the RetroArch ROM set by name. Favorites and RetroArch are not sortable. |
| `gamesFirstSeen`, `gamesFirstSeenBase` | object, number | "First seen" bookkeeping for the NEW badge and "recently added" sort (`lib/recent/games-first-seen.js`, ≤ 5000 keys). |
| `gameLaunchOptions` | object | `{ <game-key>: "NAME=value --arg" }`; see [launching.md](launching.md#per-game-launch-options). |
| `playtimeReminder`, `playtimeToday` | number, object | Reminder threshold in hours (0 = off) and today's total `{ date, ms }`; it notifies on return, never blocks. |
| `coverDownload` | boolean | Default true. `false` makes the network-cover `ensure*` wrappers return immediately — no attempt at all (not a "download failed" log line). Does not affect Cemu/RPCS3/PPSSPP/melonDS (decoded locally). Already downloaded covers are untouched because `ensure*` only ever fetches missing ones. |
| `melondsRomDirs` | array | Manual melonDS ROM folders (+ flatpak override). |
| `flatpakGrants` | array | `[{ appId, path, at }]` filesystem grants made by the launcher; revocable. |
| `saveBackup` | object | `{ dir, auto }`; `dir` an existing absolute folder (default `~/launchers-launcher-saves`), `auto` = `off` (default) / `afterGame` / `daily`. |
| `seenTips` | array | First-use tips already shown. |
