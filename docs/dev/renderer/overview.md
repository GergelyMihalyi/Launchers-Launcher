# Renderer — shared rules

Code: `renderer/*.js` (classic scripts), `index.html`, `styles/*.css`, `themes/`. Companion pages:
[home.md](home.md), [input.md](input.md), [settings.md](settings.md), [../themes.md](../themes.md),
[../games-panel.md](../games-panel.md).

## Contents

- [File layout and script order](#file-layout-and-script-order)
- [Errors and fire-and-forget promises](#errors-and-fire-and-forget-promises)
- [HTML building and i18n](#html-building-and-i18n)
- [Sizing](#sizing)
- [Overlays: `createOverlay` and `OVERLAY_STACK`](#overlays-createoverlay-and-overlay_stack)
- [Boot scripts and first paint](#boot-scripts-and-first-paint)
- [Loading indicators and empty states](#loading-indicators-and-empty-states)
- [Navigation feedback](#navigation-feedback)
- [Accessibility](#accessibility)
- [First-use tips](#first-use-tips)
- [Settings-view factories](#settings-view-factories)

## File layout and script order

The renderer is a set of **classic `<script src>` files sharing one global lexical scope** (no `type="module"`,
no bundler, no build step). A top-level `let`/`const`/`function` is visible to files loaded later, so **the
`index.html` order matters** (helper first, user later) and **two files must not declare the same top-level name**
(`test/contracts/renderer-smoke.test.js` concatenates the bundle from `index.html`, compiles it with `vm.Script`,
and runs the main render functions on fake data against a DOM stub). Adding or moving a file means editing its
`<script src>` line; the order must not change.

Folders: the root holds entry points and shared infra (`main`, `ipc`, `util`, `state`, `errors`, `feedback`,
`gamepad` — the whole input dispatcher —, `overlays`, `a11y`, `keyboard`) plus three lonely overlays
(`setup-wizard`, `changelog`, `launcher-install`, deliberately not in an "overlays/" folder: "popup" is a
technical type, not a domain). `renderer/i18n/` = `i18n.js` (the `tr()` logic) + one data-only table per
language (`i18n-hu.js` = `I18N_HU`, `i18n-en.js` = `I18N_EN`; a new language = one new table file +
`LANGUAGES`/`LANG_LABELS` + a `<script>` before `i18n.js`); `renderer/home/` (carousel, card-menu, quick-power,
idle, warmup, idle-power, tips); `renderer/settings/` (`settings.js` frame + the sub-views);
`renderer/games-panel/` (10 files: `sources` tables · `covers` lazy covers · `search` · `render` HTML + main
dispatcher · `unified` ALL list + virtualization · `favorites` (+ `focusedGameEntry`) · `filter` popup ·
`details` · `data` load/refresh · `games-panel` the controller: state, overlay, drill-down, launch, input);
`renderer/controller/` (labels, icons, status badge, help); `renderer/boot/` (first-paint scripts).

Selected globals and helpers (all in `util.js` unless noted): `$(id)` (`getElementById`; its literals are checked
by `test/contracts/dom-ids.test.js`), `esc`, `safeHtml` / `rawHtml`, `edge`, `edgePressed`, `syncEdge`,
`edgeRepeat`, `edgeHold`, `stepIndex`, `navList`, `createArmedActionList`, `createOverlay`, `BTN`, `showStatus`
(+ toast FIFO), `formatClock`/`formatDate`, `launcherLoaderHtml`/`loadingBlock`/`skeletonList`, `emptyState`,
`fileUrl`, `FALLBACK_ICON`, `wireCoverFallback`, `currentTag` (`<span class="audio-current-tag">` "this is the
active one" — lives in `i18n.js` because it calls `esc`). `state.js` is the inventory of globals mutated from
several files (`launchers`, `recentBarFocus`, `isLaunching`, `buttonStates`, `feedbackState`,
`recentGamesUiState`, `THEMES`, …; the header comment says which file writes each).

**Testability rule:** the files that are tested from Node must not touch `window`/`document` at top level (DOM
listeners live in `main.js`). **The guard form is mandatory:**
`if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { … })`, loaded in tests with
`module.require('./x.js')`. A bare `module.exports = …` or `require(` would make the file a *module* in
TypeScript's eyes and the renderer type-check would fall apart (`test/contracts/typecheck.test.js` checks this at
source level).

## Errors and fire-and-forget promises

`renderer/errors.js` (loaded right after `util`, before everything else, so it catches load- and run-time errors
of later files): `window` `error`/`unhandledrejection` → `reportClientError(context, errLike)` → (1) the
`log-client-error` IPC writes `[renderer] <context>: <message>` to the main log (throttled: same message 2 s,
≤ 30 per session, against error loops; fields are capped to 4000 chars), (2) the `#fatalOverlay`
(✕ = `location.reload()`, ○/PS = `window.launcher.quit()`), driven by its **own** `requestAnimationFrame` loop that
reads `navigator.getGamepads()` directly — *not* `gamepad.js`'s `aggregatePad`, which could be the broken file. The
overlay markup uses **inline `style`** (a fail-safe if the stylesheets did not load).

**Gotcha, verified on the machine (2026-09-12): every unhandled promise rejection brings up `#fatalOverlay`.** A
`try/catch` catches only synchronous throws, so a promise-returning API (e.g. the Gamepad API's
`vibrationActuator.playEffect()` in `rumble()`) rejecting asynchronously made the launcher show an "unknown error"
on **every button press**. **Every fire-and-forget promise gets `.catch(ignoreError)`** (`util.js`; a named no-op).

## HTML building and i18n

- New HTML is built with the **`safeHtml` tagged template**: every `${…}` is escaped automatically; ready HTML is
  marked with `rawHtml(...)`. Existing `esc()` chains stay, but the heuristic in `test/contracts/html-escape.test.js`
  fails data-like variables (`name`, `label`, `path`, `mac`, `ssid`…) interpolated in an HTML template without
  `esc(`/`tr(`/`fileUrl(` (a deliberately raw case = a justified `ALLOWLIST` line). One missing `esc` would let a ROM
  name, an SSID or a BT name through as raw HTML.
- **Every user-visible string goes through `tr(key, params?)`**, into **both** tables (`i18n-hu.js`, `i18n-en.js`;
  `test/contracts/i18n-keys.test.js` checks that every `'<prefix>.<name>'` literal, `tr('…')` call and the
  `group.*`/`menu.*` keys exist). Fallback chain: active → hu → key; `{param}` interpolation. The `language` config
  key drives it (`get-language`/`set-language`, `language-changed` push); **`applyLanguageEverywhere()`** redraws the
  bottom bar, the open Settings view and the wizard — any new `tr()`-based surface must be refreshed by it. Main →
  renderer error messages travel as `app-error { errorKey, params }` → `err.*`. `<html lang>` follows the language.

## Sizing

- Font sizes are `rem`; padding/gap `em`; fixed pixel anchors (bar widths, icon boxes) `vh`-`clamp()`.
  `html { font-size: clamp(15px, 1.481vh, 34px) * var(--ui-scale) }`: 1.481vh = 16 px at 1080 and 32 px at 2160,
  so the whole `rem` UI scales with screen height (an 55" 4K TV vs a 1080p monitor). The carousel's own `vh`
  clamps do not double up (`vh` is the middle term). No `px` where readability or layout is affected.
- **`rem` is bound to the root.** An element that must scale with its parent's font size needs `em` (e.g. the
  bottom bar's `.btn-icon` gets `font-size: 1em` so the larger bar font actually enlarges the button circles).
- A `ResizeObserver` on `#bottomBar` sets `--bottom-bar-h` which the `.container` `padding-bottom` reads, so content
  above never slides under the fixed bar at some monitor heights — measured at runtime (like `measureCardWidth()`),
  not a second hard-coded constant.
- **Never** compute a zoom ratio as `scale(calc(var(--a) / var(--b)))` from two *length* values: `<length>/<length>`
  → `<number>` in `calc()` is silently invalid in some Chromium versions and the whole `transform` is dropped.
- Standard CSS replaced the `-webkit-background-clip: text` and `-webkit-mask` prefixes; what **stays** prefixed (no standard equivalent in Chromium) is
  `-webkit-text-fill-color` and the `display: -webkit-box` + `-webkit-line-clamp` + `-webkit-box-orient` trio. There is no `webkitAudioContext` fallback.
- New popup CSS is scoped by its own id (`#xyzOverlay …`) — the `.settings-panel` base rule is shared by many
  overlays. `#settingsOverlay` and `#gamesOverlay` get the fixed/fullscreen sizes ([settings.md](settings.md)).

## Overlays: `createOverlay` and `OVERLAY_STACK`

`createOverlay({ elementId, enterStates, syncOnClose, onOpen, onClose })` → `{ states, isOpen(), open(...args),
close(gp), reset() }`. The 10 controller-driven popups use it: `settingsPanel`, `gamesPanel`, `gamesFilter`,
`gamesDetails`, `cardMenu`, `quickPower`, `changelogPanel`, `launcherInstall`, `keyboardPanel`, `setupWizard`.
- `open()` → flag on + a **fresh** `states` (the opening button may still be held) → `onOpen(...args)` (render) →
  `.visible`. `close(gp)` → flag off → `.visible` off → `syncEdge` of the **parent's** state (only with `gp`) →
  `onClose(gp)`. Already open/closed = a no-op (`false`). `reset()` closes without callbacks (the games panel uses
  it for the filter popup).
- `enterStates` per overlay (e.g. `{ cross: true }` when ✕ opened it; `{ square: true }` for the filter; settings
  `{}`), `syncOnClose` maps to the parent's keys (the table is in the source).
- **A manual `*Open` flag / `classList.add('visible')` on an interactive overlay is forbidden**
  (`renderer-smoke` enforces it); only the non-interactive ones (`overlays.js` loading / TV-exit / volume,
  `home/idle.js` screensaver) set `.visible` by hand. The open check is `x.isOpen()`, the edge state `x.states`;
  the usual `openX()`/`closeX(gp)` stay as thin wrappers.
- `keyboard.js` / `setup-wizard.js` build their overlay at the top of the file, so for a Node test they obtain
  `createOverlay` via `module.require('./util.js')`.
- **`OVERLAY_STACK`** (`gamepad.js`): a table of `{ isOpen, handle }` closures — only the **topmost open** overlay
  gets input. The fields are **closures**, not the bare identifiers, because the table is built at the top of
  `gamepad.js`, long before `settings.js`/`setup-wizard.js`/`keyboard.js`/… (loaded after it) define the globals
  they reference; a direct reference would throw a `ReferenceError` at construction. `main.js`'s keydown fallback
  does not read this table (it keeps a narrower list of overlays that have keyboard handling).

## Boot scripts and first paint

`renderer/boot/` holds the scripts that run **before first paint**: `boot-theme.js` (a synchronous external
`<script>` in `<head>` + `<style id="__bootBg">`: from `window.launcher.initialTheme` / `initialBackground`
— the preload's `sendSync` `get-boot-state` — it sets `data-theme`, injects the theme `<link>` and the background)
`boot-splash.js` (after `#cards`; dismisses the startup logo animation — see [home.md](home.md#startup-splash)) and `boot-cards.js` (after `#cards`: puts the launchers' icons into the three skeleton circles — centre = the
first launcher, right = the second, left = the last; a broken icon is removed). They use `window.launcher` and the
DOM at top level, inside an IIFE, and are **not part of the renderer bundle** (`renderer-smoke` skips them).
**An inline `<script>` is forbidden** (the CSP has no `'unsafe-inline'` in `script-src`; `test/contracts/csp.test.js`
guards it — `'unsafe-inline'` remains only in `style-src` for leftover inline `style` attributes). A new boot step =
a new file there. `#cards` does not start empty: 3 static `.card-skeleton` placeholders, which `renderCards()`
overwrites unconditionally once the real list arrives (no removal logic).

The CSP also restricts external loads to the Google Fonts CDN (`fonts.googleapis.com`/`fonts.gstatic.com`),
`file:` and `data:`; `img-src 'self' file:` admits `assets/backgrounds/*.svg` **and** a `file://` custom image. A
new external resource needs the CSP extended.

## Loading indicators and empty states

**One shared loading indicator everywhere the launcher may load:** the active launchers' icons in a row, glowing
in a wave (`.launcher-loader`, `@keyframes launcher-loader-wave`, `--i` = icon index → staggered
`animation-delay`). **Use it for any new loading state — don't write a spinner/skeleton.**
`launcherLoaderHtml(list, { size, activeId, immediate })` is pure: `size` ∈ `sm`/`md`/`lg`, `LOADER_MAX_ICONS = 7`
(the `activeId` icon always stays in), an empty list → 3× `FALLBACK_ICON`, a missing `icon` → `FALLBACK_ICON`,
the path escaped. `loadingBlock(size, opts)` passes the `launchers` global; `skeletonList(n)` now returns it (the
`n` is a dead parameter, kept for ~20 callers).
- **Flash guard:** it fades in from `opacity:0` with a 150 ms delay (pure CSS), so a few-ms `await` doesn't flash.
  `immediate: true` (`.launcher-loader-now`) skips the delay — for long/fullscreen places. `data-motion="off"`'s
  global `animation: none !important` would leave it stuck at `opacity:0`, so a dedicated
  `:root[data-motion="off"] .launcher-loader { opacity: 1 }` forces it visible.
- Where it lives: `#loadingOverlay` (`showLoading(name, action, launcherId, cover)` — the launched launcher's icon is
  highlighted; **the old fake 2 s `.loading-bar` is gone**), the Update progress, the flatpak installer's `running`
  state (the % bar stays; the dense progress pushes only patch the bar/%, never redraw the block, or the wave would
  restart on every %), BT scanning, every `skeletonList()` caller, the startup skeleton.
- A broken icon: one delegated capture-phase `error` listener in `main.js` (`img.loader-icon` → `FALLBACK_ICON`,
  `data-fallback` against loops). The `pixel-rpg` card-icon pixelation is deliberately not applied to the loader.
- **Narrow container:** `.loader-icon { flex: 0 1 var(--loader-size); min-width: 0; aspect-ratio: 1 }` +
  `.launcher-loader { max-width: 100% }` (icons shrink in the Settings right column instead of causing a
  horizontal scrollbar); `.launcher-loader:only-child { margin: auto }`.
- Other states: `emptyState(title, hint)` for empty lists (don't hand-write `<div class="settings-empty">`);
  `renderSubviewError()` for a failed query (the `{ ok, items }` reply shape); toast = `showStatus(msg, isError,
  { ms })` (a longer one for undoable toasts; a misleading, still-visible toast can be closed with
  `dismissStatus(msg)`); a **dangerous list action** = an arming first ✕ (`.armed`, `sv.powerConfirm`) and, where
  possible, an undo (the launcher-removal pattern: a one-element main-side trash + △ during the toast).

## Navigation feedback

`feedback(kind)` (`'nav'` | `'launch'` | `'back'`) = `playSfx(kind)` + `rumble(kind)`, throttled at
`FEEDBACK_THROTTLE_MS` (55 ms). **Sound is synthesised** (Web Audio `OscillatorNode` + `GainNode`, a short
exponentially decaying blip; the `SFX` table) — no asset, no CSP change; autoplay via the
`autoplay-policy: no-user-gesture-required` switch + a defensive `ctx.resume()`. **Rumble:**
`gamepad.vibrationActuator.playEffect('dual-rumble', …)` on **every** `connected` pad from
`navigator.getGamepads()` (not the merged aggregate, which isn't a real pad). **Call sites are centralised in
`navList()`** (`move` → `nav`, `onSelect` → `nav`, `onBack` → `back`; on ✕ `onSelect` runs first, so a launch
from the games panel keeps its own `feedback('launch')` and the throttle swallows the following `nav`); manual
calls for the main card navigation, `launchApp()`, △/Select/□/Start (`nav`, if they actually open something), PS
(`back`) and the launcher-order grab. A new list view gets feedback automatically through `navList`; a hand-rolled
`edge()` must call it. During a held repeat only the sound plays (`{ repeated: true }`).

## Accessibility

- **Slow repeat** (`feedback.slowRepeat`): `setRepeatScale(2.5)` multiplies both the initial delay and the rate of
  `edgeRepeat` (list ▲▼, carousel ◀▶, letter jump); `applyRepeatPref()` sets it.
- **Screen reader** (`feedback.screenReader`): focus is *visual* (the `.focused` class; DOM focus does not move).
  When on, `renderer/a11y.js` puts a MutationObserver on `body` and writes the label (`a11yLabelOf`: `aria-label`,
  else the text) of the element that gains `.focused` into the invisible `#srAnnounce` (`aria-live="polite"`,
  `.sr-only`) with a 150 ms debounce. Off = no observer. Main adds `force-renderer-accessibility` from the next
  start (on Linux Chromium also builds the tree when Orca runs; Electron's `setAccessibilitySupportEnabled` is
  macOS/Windows only). **A new focusable element whose visible text is not descriptive (an icon/cover) gets an
  `aria-label`.**
- Always on: `.card` (`role="button"`, `aria-label` = name + description + "RUNNING"/"FAVORITE"), `.game-cell`
  (name + source), the recent/continue items, toast `role="status" aria-live="polite"`, `<html lang>`.
- **Motion:** `<html data-motion="off">` (global `animation: none !important; transition: none !important`) comes from
  a theme's `motion: "off"` **or** the user's "Animations = Off". **Contrast:** `<html data-contrast="high">`,
  theme-independent: it pulls `--dim` toward `--text` with `color-mix`, zeroes `--card-bg-opacity` /
  `--scanline-opacity`, strengthens `--card-border` and adds an `outline` on focused items.

## First-use tips

`renderer/home/tips.js`: a `TIPS` table (`home` / `gamesPanel` / `settings`), `showTipOnce(id)`, `resetSeenTips()` —
a non-modal bubble (`#tipBubble`, ~8 s) about hidden gestures, shown the first time the surface opens (home 4 s
after startup if no overlay is open; the panel/settings `onOpen`). Seen tips live in the `seenTips` key
(`get-seen-tips`/`set-seen-tips`, replaces the whole list); Settings → Look → Tips → "Show tips again" clears it.
**A new tip = one `TIPS` row + `tip.<id>` in both i18n tables.**

## Settings-view factories

In `renderer/settings/settings-toggle.js` (loaded after `settings.js`, before every view that uses them):

- `createToggleSubview({ id, hintKey, onLabelKey, offLabelKey, defaultOn, get, set })` — the shared core of the four
  on/off views; returns `{ open, handle, render, setCurrent }`. `setCurrent(value)` aligns the view to the value the
  main process **confirmed**, called by `renderer/ipc.js`'s common **`onToggleChanged(eventFn, { viewId, onKey,
  offKey, failKey, isOn })`** — a failed write also reverts the optimistic UI. (History: after the dedup the
  per-view `renderXView()` names no longer existed but `ipc.js` still called them, so adjusting a toggle threw an
  uncaught `ReferenceError` and raised the fatal overlay every time.)
- `createMultiToggleSubview({ id, hintKey, rows, getState, setState, persist, afterToggle?, preload? })` — N
  independent switches in one list (feedback, recent-games, output-behavior); the caller exposes
  `function renderXxxView() { xxxView.render(); }` because `ipc.js` handlers refer to that name and to the
  caller's own state variable (`feedbackState`/`recentGamesUiState`/`obConfig`).
- `createSelectSubview({ id, subheadKey?, rows, getCurrent, onSelect, tagFor? })` — the N-option generalisation
  (ui-scale, sleep-timer; `tagFor` for a live countdown); and **`createPrefSelectSubview({ id, subheadKey, rows,
  defaultValue, get, set, apply? })`** — a numeric, main-persisted selector (holds its own current value; see
  [config-keys.md](../config-keys.md#look-and-language)).
- **⚠️ In every one of these, `onBack: () => backToSettingsMenu(gp)` is the right form** (closing over the outer
  `gp`), **not** `onBack: (g) => backToSettingsMenu(g)`: `navList` calls `onBack()` with *no argument*, so the latter
  would run `backToSettingsMenu(undefined)`, skip the `syncEdge`, and a ○/PS hold would jump two levels (to the
  category list).
- `createArmedActionList({ rows, isRowArmed?, onImmediate?, onConfirm, rerender, isStillOpen, armMs? })` (`util.js`)
  is the render + arm + 3 s reset timer mechanism shared by the quick power menu and the Settings power view;
  it lives in `util.js` because `quick-power.js` loads long before `settings-toggle.js` (a factory call from there
  would be a `ReferenceError` at bundle load).
- Shared render helpers in `settings.js`: `renderFlatSections(sections, focusIndex, renderItem)` /
  `flatSectionItemCount(sections)` (the common core of Statistics/Diagnostics: section headers + a flat focus index
  + empty/error branches; the item shapes differ so the caller supplies `renderItem`).
