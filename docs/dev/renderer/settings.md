# Settings panel, setup wizard, shared pickers

Code: `renderer/settings/*` (`settings.js` = the frame, `settings-<id>.js` = one sub-view each),
`renderer/setup-wizard.js`.

## Contents

- [Panel structure](#panel-structure)
- [Adding a sub-view](#adding-a-sub-view)
- [Navigation and edge gotchas](#navigation-and-edge-gotchas)
- [Panel size](#panel-size)
- [Search and descriptions](#search-and-descriptions)
- [Notable sub-views](#notable-sub-views)
- [Setup wizard](#setup-wizard)
- [Directory browser and manual launcher path](#directory-browser-and-manual-launcher-path)

## Panel structure

Three zones: the left column (`#settingsMenuList`) always lists **only the categories**; the right column
(`#settingsContent`) alternates between the focused category's **item list** and the actual **sub-view**. The state
`settingsZone` ∈ `'categories'` | `'items'` | `'content'` (+ `'search'`) decides which dispatcher
`handleSettingsInput()` calls (not `settingsView`, which is a sub-view id in `'content'` and `null` otherwise).
`settingsGroupIndex` is the previewed category; the left list and the right item list always mirror it regardless
of the zone — only the `.focused` frame goes to the zone's side (`.settings-item.active` marks the previewed
category even after focus moved right).

- **Eight categories** (`SETTINGS_GROUPS`; ordered by expected frequency): `output` Picture and sound · `games`
  Games · `apps` Launchers · `devices` Controllers · `startup` Startup · `look` Look · `energy` Energy and network
  (Wi-Fi, Power management, Sleep timer, Auto sleep) · `system` System. Place a new item **by its role**; no
  category should grow past 7–8 items (`look` has 8, `games` 7 — split at the next addition).
- Menu labels are `tr('group.'+id)` / `tr('menu.'+id)`; the `label` fields in the tables are only an HU fallback;
  sub-view bodies use the `sv.*` prefix; the common `▲▼ nav / <verb> / back` hint is `subviewHint(confirmKey)`.
- **Navigation:** categories ▲▼ = switch category (the right side previews the item list live, without entering —
  the user's wording: "when I land on a main item, all its settings appear on the right"); ✕ = items zone (+
  `settingsItemsButtonStates = { cross: true }`, because the entering ✕ is still down and would otherwise enter the
  sub-view too — fixed 2026-09-14); ○/PS = `closeSettings()`. Items ▲▼ = focus, ✕ = `enterSettingsItem()`, ○/PS =
  `backToCategories()` (not closing). Content: the view's own handler, ○/PS = `backToSettingsMenu()` (back to the item
  list, not closing). **Only from the category list does ○/PS close the panel.** There is no live preview at
  sub-view level (only category level).
- Every sub-view has its own `renderXxx()` (writing into the shared `#settingsContent`/`#settingsPanelTitle`/
  `#settingsPanelHint`) and its own `handleXxxInput(gp)` with its own `*ButtonStates` (never share), the latter calling
  `navList(gp, states, { count, move, onSelect, onBack })`.
- **Opening a sub-view = `setSubviewFrame({ title, hint?, skeleton? })`** (title + `subviewHint` + loading indicator in
  one call; the `skeletonList(n)`'s `n` is dead). A hint that differs from the list's is written by the view itself.
- `openXxxView()` async functions: after each `await`, (a) `if (settingsView !== '…') return` (a stale-render
  guard), (b) `if (!res.ok) { renderSubviewError('…'); return; }` — `list-*` handlers return `{ ok, items }`. Before the
  `await`: `skeletonList()`. At 0 items: `emptyState(title, hint)`.
- **Long lists scroll:** `.settings-panel { max-height … }` and `.settings-list { flex: 1; min-height: 0; overflow-y: auto
  }` (without `min-height: 0` a flex column would not shrink below its content); every `renderXxx()` ends with
  `scrollSettingsFocusIntoView()` (`requestAnimationFrame` + `scrollIntoView({ block: 'nearest' })` on
  `.settings-item.focused`) — **a new sub-view's render must call it**.
- **HTML escape:** `renderXxx()` builds `innerHTML` from strings — any non-code text (device name, sink description,
  launcher name) is escaped (prefer `safeHtml`; icon/SVG markup stays raw).
- **Related views share code:** `bt-headset` and `bt-controller` use one generic `openBtDeviceView(kind)` /
  `renderBtDeviceList(kind)` / `toggleBtDevice(kind)` / `handleBtDeviceInput(gp, kind)` quartet with per-kind state in
  `btState = { headset: {…}, controller: {…} }` (so edge states don't collide) — follow this when two views are 90 % the
  same. Pairing from the UI: `btNavRows(kind)` = paired devices → "🔍 Find new device" → found devices; `startBtScan`
  (`bt-scan`, resolved by the `bt-scan-result` push, input locked while `scanning`) / `pairBtFound` (`bt-pair`,
  `busyMac`).
- **Place memory:** Settings keeps its category + item focus within a run (`onOpen` does not reset); it never
  re-enters a sub-view by itself.

## Adding a sub-view

Two places: (1) a `SETTINGS_MENU` row `{ id, label, group }` in `settings.js` (`group` an existing category; also the
i18n keys `menu.<id>` **and** `menu.<id>.desc`), (2) `renderer/settings/settings-<id>.js` + its `<script src>` (after
`settings.js`, before `ipc.js`) that registers `SETTINGS_VIEWS['<id>'] = { open: openXxxView, handle: handleXxxInput }`
(the registry is declared empty first in `settings.js`; the registering line stays a **literal**, which
`test/contracts/settings-views.test.js` matches at source level). `enterSettingsItem()` / `handleSettingsInput()` work
from the registry — there are no id branches. The test fails if a menu id has no registration (or vice versa) or a
`group` does not exist.

## Navigation and edge gotchas

- **Back is three levels** (view → items → categories → close). The target zone's key watcher
  (`settingsCategoryButtonStates` / `settingsItemsButtonStates`) did not run while focus was elsewhere, so the held back
  button/✕ is aligned with `syncEdge(…, ['cancel','cross'])`; **every sub-view's back branch must pass `gp`** to
  `backToSettingsMenu(gp)`, and `handleItemsInput`/`handleCategoriesInput` pass it on too. Selecting an item inside a
  view (e.g. ✕ on an audio device) closes the whole panel.
- **Forward needs it too:** every `open*View()` sets its own `xxxButtonStates = { cross: true }` on entry (as
  `startupOutputButtonStates` / `launchersViewButtonStates` / `themeButtonStates` do). Four views (`audio-sink`,
  `diagnostics`, `stats`, `log`) once forgot it, so the entering ✕ immediately triggered a second "select/refresh".
  A sub-zone **inside** `#settingsContent` that keeps reading *its own* edge object (e.g. `variantPick`/`customFlow` on
  `launchersViewButtonStates`, the games panel root↔retro-system on `gamesPanelButtonStates`) needs no reset — only
  switching to a *new/different* edge object does (like `flatpakBrowse.buttonStates`); on **leaving** such a
  separate-object sub-zone, `syncEdge` the object you return to (`closeFlatpakBrowse(gp)` does).

## Panel size

`#settingsOverlay .settings-panel` has a **fixed** `width`/`height` (`min(92vw, clamp(760px, 70.4vh, 1180px))` ×
`clamp(560px, 76vh, 960px)`) so switching views doesn't make the box jump with content length (lists scroll
inside), and `.settings-body` is **always a row** (menu left `flex: 0 0 32%`, content right `flex: 1`) — no `@container`
threshold, no single-column fallback, no user switch (the old `feedback.wideSettings` is gone; `data-pane` now only
mirrors input dispatch). **The `.settings-panel` base rule (`max-height: 82vh`, content-driven) is unchanged** because
8+ other popups reuse that class; the fixed size is scoped to `#settingsOverlay` and `#gamesOverlay` (the latter
**fullscreen**: `100vw × 100vh`, `max-height: none`, no border/radius/shadow — no darkened margin like the home screen).
**Scope any new popup's CSS by its own id.**

## Search and descriptions

- Every `SETTINGS_MENU` row has `menu.<id>.desc` (both tables, tested): a faint one-line description under the focused
  row (`.settings-item-desc`), `aria-description` for screen readers.
- **Search** (`renderer/settings/settings-search.js`): a "🔍 Search" row at the end of the category list (✕; Select still
  opens the regular settings) opens a docked live on-screen keyboard (`#settingsOverlay.kb-docked`, the games-search
  pattern); matches over menu titles + descriptions + the category name (`settingsSearchMatches`: accent- and
  case-insensitive, every word must match, title hits first); ✕ opens the sub-view (`settingsZone === 'search'`, ○ = back
  to the opening zone). Its edge state `settingsSearchButtonStates` opens as `{ search: true, cross: true }` (the still-held
  Select/✕ must not reopen it).

## Notable sub-views

- **Startup output** (`startup-output`): one virtual combined list — monitors on top (`listMonitors()`), sinks below
  (`listAudioSinks()`), `settings-subhead` headers; the row `type` decides `setStartupMonitor` vs `setStartupSink`. Does
  not close the panel on selection. Monitors are identified by connector + resolution (`"DP-3 — 2560×1080"`) because
  `kscreen-doctor -j` gives no friendly names (`model`/`manufacturer` null).
  **"Keep this display?"**: if the chosen monitor was **not active** before the switch (the picture may go dark — a
  turned-off TV), `setStartupMonitor` puts `confirmMs` (15 s) into the `monitor-config-changed` payload and starts a
  **main-side** timer (the renderer may be on a dark screen, so the decision cannot depend on it); the renderer
  (`startMonitorConfirm`) shows a countdown bar and while it is open **only** ✕ (`confirm-startup-monitor`) /
  ○·PS (`revert-startup-monitor`) work. Expiry/○ → the previous `display.monitor` is written back (null → delete)
  + **`startupOutputs.maybePowerOnTv()`** (the previous one may be the CEC TV, which could have been turned off
  during the countdown — it stayed dark live, 2026-09-24) + `displays.restoreActiveMonitors(prevActive)` (pure core
  `activeLayoutArgs`); if the previous output is not connected, `revertRetryMs` (4 s) later one more try, then the
  visible monitor stays (also in the config; `monitor-config-reverted { kept: true }`). During a pending switch a
  newer choice keeps the **first** (proven visible) state as the restore target; `forceQuitCleanup` →
  `abandonPendingMonitor()` restores only the config, synchronously. **Serialised switching** (a live bug, 2026-09-24:
  repeated ✕ during a slow switch started 7 parallel `kscreen-doctor` chains within 1.5 s → several monitors stayed active):
  `setStartupMonitor` runs one switch at a time (`switchRun`), only the latest queued request runs after (`queuedMonitor`),
  an already reached state makes no kscreen/CEC call, and `verifyLayout()` reads the active monitors back and re-applies
  once (logged) on a mismatch; the renderer shows "SWITCHING…" and sends nothing until the reply.
- **Launchers**: one combined list — active launchers on top (`(ADDED)` badge, all removable), the catalog's not-yet-active
  entries below (`common` first; `(INSTALLED)` / `NOT INSTALLED` from detection). ✕: an active one → `removeLauncher(id)`; a
  catalog row: not installed + `flathubId` → `#launcherInstallOverlay` (in-app `flatpak install`, a progress bar, success
  → auto-add; the IPC first runs `flatpak remote-add --user --if-not-exists flathub …` — on Fedora flathub is often only a
  system remote and a `--user install` would fail otherwise; `LC_ALL=C` + `flatpakErrorLine`; `flatpak-install-progress` /
  `-done` pushes; **on entry every edge key of `liButtonStates` is `true`**); otherwise `addLauncher(id)`. Detection
  (`listLauncherCatalog()`) runs once on entry; `launchers-changed` rebuilds the rows from the **cached** catalog (focus
  restored by id; "LAUNCHERS UPDATED" toast, else "ORDER SAVED"). **"＋ Add other program…"** =
  `createLauncherAddFlow({ isActive, scroll, onClose })` (`settings-launcher-add.js`, lazily, own `buttonStates`): `source`
  (installed app / type a command / pick a program from a folder) → `apps` (`list-installed-apps`: flatpak + native
  `.desktop`, icon thumbnails, `FLATPAK`/`SYSTEM` + `(ADDED)` badges; **△ = filter** with the docked live keyboard, ○
  clears the filter first) **or** 3 `openKeyboard` steps (name → command → arguments) **or** `createDirBrowser` →
  `find-launcher-executables { dir }` (no id: every executable in the folder) → pick → name (guessed from the file
  name) → `preview`: a card preview (icon + name + command line, `--preview-accent` frame) + rows Add / Name / Icon (the
  program's own icon / none / `assets/icons/*`) / Colour (◀▶ or ✕ over `CARD_ACCENT_PALETTE`). ○ steps back one
  step. Payload `launcherAddPayload(draft, launchers)` (pure) → `add-launcher` — a flatpak gets id `flatpak-<appid-slug>`,
  otherwise `customLauncherId(name)`; the own icon travels as `iconFile` and the main process imports it. A new
  add-source = a new step in this flow, not a new menu item. **□ on a row** opens the per-row menu (`launcherRowMenu`, on every
  `nativeCmd` catalog/added row): "Switch variant" (only if both are present) · "Set folder manually…" · "Clear manual
  folder"; the catalog row shows the manual path. Both-installed → `openVariantPick(entry)` (Flatpak (RECOMMENDED) / Native,
  `VARIANT_PICK_ORDER`) on the same `launchersViewButtonStates`.
- **Launcher order** (`launcher-order`): grab-and-drop. A grabbed element is moved by ▲▼ in the `orderList` array (no
  wrapping); ✕ grabs/drops; ○/PS drops a held item, with empty hands `commitOrder()` (IPC only on a real change) +
  `backToSettingsMenu(gp)` — the order is written when you go back, not on every move. A hand-rolled `edge()`, not `navList`.
- **Theme** (`theme`): ▲▼ focus (wraps), ✕ = `applyTheme(id)` (live switch of `<html data-theme>` + `data-motion`) +
  `setTheme(id)`; does not close the panel (compare themes). `onThemeChanged`: success → toast, failure → revert to the
  saved theme; `injectThemeLinks(manifest)` inserts the non-`neon` `<link>`s; each row has a `.theme-swatch` strip from the
  manifest's `swatch` hexes.
- **Background** (`background`, `look`): the theme view's pattern, but for the **active theme** (`bgViewTheme = currentTheme`); a
  combined list (`None` + "Built-in" from `data/backgrounds.json` with swatches + "Custom" images from
  `~/Pictures/launchers-launcher/`, empty → a read-only note). ▲▼ = focus + live `applyBackground` preview (visual only), ✕ =
  `setBackground({ theme, cfg })` (persists), ○/PS = back (reverting to `bgViewSaved` if ✕ did not persist). "(current)"
  marks the theme's *saved* background, not the preview.
- **Language** (`language`): ✕ = `setActiveLanguage(lang)` + `setLanguage(lang)` + a toast + `applyLanguageEverywhere()`.
- **Feedback** is two views: "Sound and rumble" (`settings-feedback.js`: `sound`/`rumble`) and "Accessibility"
  (`settings-accessibility.js`: `motion`/`contrast`/`slowRepeat`/`screenReader`) — one `feedbackState`, `onFeedbackChanged`
  redraws both. Rows are `{ key, labelKey }` with `sv.fb*` keys.
- **Statistics** (`stats`, `system`): read-only; `get-usage-stats` → resolved `usage` rows `{ key, kind, name, count, totalMs,
  lastSessionMs, lastLaunchedAt }` (`buildUsageStats()` names the `steam-game-*`/`heroic-game-*` ids from the cached library
  lists, falling back to the raw key); sections "Launchers" + "Games" (top 15 by `totalMs`); `formatDuration()`; ✕ = refresh;
  **no reset** (the key can only be emptied by hand-editing). RetroArch is one aggregate row (the shared appId); Steam's time
  is the whole Big Picture client session (a note says so).
- **Diagnostics** (`diagnostics`): read-only, 7 sections (Version / System commands / Displays / Audio devices / BT headset / BT
  controllers / Launcher catalog) — plus "Last start", "Graphical platform", "Desktop environment", "ROM folder access". Version
  = `get-app-info` (`{ version, electron, node, chrome, gpu, ozone, desktop, formatDrift, backgroundErrors, … }`);
  System commands = `get-selftest`, a missing row is a red `tag-warn` badge and the section ends with a **"＋ Install the
  missing ones"** row (✕ → `runHostPackageInstall()`; the wizard's "Done" step does the same with □ — `wizInstallMissing()`);
  the rest re-call the existing `list*` IPCs. Sections are `{ ok, items }` ("QUERY FAILED" on `ok:false`). A new query = a new
  `diagSections` object. Version history is the root `CHANGELOG.md`.
- **Log** (`log`): see [../infrastructure.md](../infrastructure.md#process-execution-and-logging); on entry the **newest** line
  is focused, ✕ = refresh; on a terminal-less kiosk it is the only way to see why something did not start.
- **Update** (`update`, `system`): on entry `check-update` (`git fetch` + `status`/`rev-list HEAD..@{u}`/`diff --name-only`,
  `GIT_FETCH_TIMEOUT_MS` 25 s) → `deriveUpdateStatus`; UI "UP TO DATE" / "N NEW COMMITS" (+ an `npm install` notice if
  `package*.json` is touched) / "LOCAL CHANGES — update disabled" / "NO INTERNET"; ✕ (only `available`) → `apply-update`
  ([../install-update.md](../install-update.md)). Does **not** run at startup, only when the view is entered. After a pull,
  `pendingChangelog` shows a one-off "What's new" panel from the top of `CHANGELOG.md`
  (`renderer/changelog.js` `maybeShowChangelog()`, `get-changelog`, `dismiss-changelog`; only on a set-up install, after the wizard).
- **Power** (`power`, `settings-system.js`) — Power off / Reboot / Sleep with the two-step ✕ (`powerArmTimer` 3 s,
  `.settings-item.armed` red `--accent2`; ▲▼ or ○/PS disarm; a hand-rolled `edge()` through `createArmedActionList`); the main
  `system-action` handler calls `dispatchSystemAction`. **⚠️ `systemctl`, not `loginctl`** (`loginctl` has no
  `poweroff`/`reboot`/`suspend` subcommands, not even in systemd 259; both hit the same logind polkit action). The user's
  active local seat session + `wheel` lets polkit allow `org.freedesktop.login1.{power-off,reboot,suspend}` without a
  password **even to the launcher process** (`pkcheck --action-id … --process <launcher pid>` → `rc=0`, verified
  2026-09-10 although the launcher is started by the `systemd --user` watcher, not directly from the seat session — Fedora's
  logind policy authorises by any active local session of the user). On a machine without that, `systemctl` fails and the
  error toast says so. No success feedback (the machine is about to go down).
- **Sleep timer** (`sleep-timer`): Off/30/60/90 min through `navList`; **deliberately not in `config.json`** — it is a
  session-only state in the `createSystemPower()` closure (an auto-arming sleep timer at startup would be wrong on a kiosk;
  cleared on relaunch/crash-restart — accepted). A warning push (`sleep-timer-warning`) in the last minute; the reply
  `sleep-timer-changed { minutes, endsAt }`. A persisted timer would be a separate decision.
- **Setup re-run** (`setup-rerun`): not a real view — its `open()` closes Settings and opens the wizard.
- **Wi-Fi** (`settings-wifi.js`): [../devices.md](../devices.md#wi-fi-nmcli); **Save backup** (`settings-save-backup.js`): see
  [../launchers/README.md](../launchers/README.md#save-backup); **ROM-folder permissions** (`settings-rom-access.js`); **Games
  cache** (`settings-games-cache.js`, two-step confirm via `createArmedActionList`, whose `rows` may be a function and
  whose row `label` overrides `labelKey`); **Config backups**, **Settings transfer** (`settings-transfer.js`, import with a
  two-step confirm); **Games view** (`settings-games-view.js`: fixed rows — not narrowed to the detected launchers, so a
  not-yet-installed launcher's view can be set ahead — ▲▼ row, ✕ instant switch + persist, no close); **Recent bars**
  (`settings-recent-games.js`).

## Setup wizard

On first start (`get-setup-state` → `{ done: false }`, asked by `main.js` `initLaunchers()` afterwards) a standalone fullscreen
wizard (`#setupOverlay`, reusing `.settings-*` CSS) runs: **welcome → language → launchers → startup monitor → audio device →
main controller → theme → controls → done** (`WIZ_SEQ`). `wizStepInfo(i)` (pure, `module.exports` guard) returns `{ id,
counter }` — only the "k / 6" counter, **without `tr()`**, so the module is requirable without i18n (the label is resolved by
`wizStepLabel(id) => tr(WIZ_LABEL_KEY[id])`); the six "real" steps are `WIZ_REAL`. The `controls` step shows only the
`controlsHelpGridHtml()` grid (no focus; the panel is wider there via `:has(.controls-help)`, the e2e checks it fits without
scrolling). The **"Done" step checks**: `wizCheckSummary(wizChoices, wizData)` → ⚠ rows for chosen-but-not-installed launchers
and the self-test's missing commands (`WIZ_CMD_PURPOSE` says what each is for); □ installs the missing ones.
- **Launchers step:** the `list-launcher-catalog` rows with ☑/☐ (common first, then installed); **✕ toggles** (does not advance),
  a "▸ Next" row advances. **Default ☑:** the installed `common` ones + the already active launchers. `wizData.addLaunchers`
  (catalog ids) → `finish-setup` → copied into `customLaunchers` (the renderer silences the `launchers-changed` toast with
  `suppressLaunchersToast`).
- **Language step:** ✕ = `setActiveLanguage` + `setLanguage` + `wizNext()` (live switch); the `finish-setup` `language`
  field persists; a cancelled re-run reverts to `wizLangAtOpen`.
- Every step is skippable; ▲▼ navigate, **✕ = choose + next**, ○/PS = previous step (re-run: ○ on welcome exits). On entry the
  focus jumps to the current setting (`wizInitialFocus`), at the controller step to the **connected** one (connected-first list,
  `● connected`, a MAC tail on name clashes, a type icon — like `settings-main-controller.js`). The theme gives a live preview
  while scrolling; other choices only **record**. `finish-setup` writes the monitor **without applying** (an erroneous choice
  must not black out the first start), applies the sink at once, and sets the main controller, theme, language and finally
  `setupDone`.
- Queries are **per-promise `.catch`ed** (one failing `list-*` must not blank everything); an empty/failed monitor/sink/
  controller list → `wizListNote()` (pure) gives an explaining line distinguishing "empty" from "query failed —
  kscreen-doctor/pactl/bluetoothctl?", and every step has a "Skip" / "Any" row, so the wizard cannot get stuck on a
  headless/non-KDE start. `pollGamepad` branches on `setupWizardOpen` before settings/games; closing runs
  `syncEdge(buttonStates, gp, ['cross','ps','triangle'])`. Keyboard fallback `wizKey()` (Esc = back, not `quit()`).

## Directory browser and manual launcher path

- **`createDirBrowser({ viewId, isPicked, pickedTagKey, onPick, onClose })`** (`settings-dir-browse.js`) →
  `{ open(path), render(), handle(gp), close(gp), reset(), isOpen() }`: "✓ choose this folder" / ".. up" / subfolders /
  "⌨ Manual entry…" over the `browse-dir` IPC. It draws into the caller's `#settingsContent` with its own edge state; the
  caller branches on `if (browser.isOpen()) { browser.handle(gp); return; }` and syncs its own state in `onClose(gp)`. Users:
  melonDS ROM folders (the browser stays open so several folders can be added), the saves target folder (`onPick` then
  `close(null)` — closing without `gp` sets the still-held ✕ to `true` in the caller), the launcher-add flow and the manual
  launcher path. Optional `ui: { content, title, hint }` (DOM ids), `isActive()`, `scroll()` — the default is the Settings
  panel; the wizard supplies its own `#setup*` elements. **Do not write a new browser.**
- **`createLauncherPathFlow({ viewId, ui, isActive, scroll, apply, onDone, onClose })`** (`settings-launcher-path.js`) →
  `{ open(entry), handle(gp), clear(entry, onCleared), isOpen(), reset() }`: `createDirBrowser` → in the chosen folder the main
  process looks for the program (`find-launcher-executables`) → one (name) match is taken at once, several / a `guess` → a
  chooser list → `set-launcher-path`. **Created lazily** in both users (a Node test loads `setup-wizard.js`, where the
  factory does not exist): the Launchers sub-view (`apply: true` — the added launcher switches at once / a not-yet-added one is
  added natively; then `reloadLaunchersCatalog()` re-detects) and the wizard's launcher step (`apply: false` — only stores, the
  `finish-setup` adds it; then `wizReloadCatalog(id)` + tick). In the wizard □ = variant switch if both exist, else the
  folder flow (`altKey` for the hint).
