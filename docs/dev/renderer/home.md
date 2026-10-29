# Home screen

Code: `renderer/home/*` (`carousel.js`, `card-menu.js`, `quick-power.js`, `idle.js`, `warmup.js`, `idle-power.js`,
`tips.js`), plus the markup in `index.html`.

## Contents

- [Carousel](#carousel)
- [Quick-launch bar under the focused card](#quick-launch-bar-under-the-focused-card)
- [Continue bar](#continue-bar)
- [Card quick actions](#card-quick-actions)
- [Quick power menu](#quick-power-menu)
- [Screensaver](#screensaver)
- [Startup splash](#startup-splash)

## Carousel

Cards are **absolutely positioned** on a `.cards` stage (no flex/gap). `layoutCarousel()` computes, for each card, a
**ring offset** relative to the focused one (`ringOffset(i, focused, n)` — the short way round, signed) and sets
inline `transform` / `opacity` / `z-index` / `pointer-events` from `computeCarouselPos(baseWidth)`: `center` =
`scale(1)` + `.focused`; `left`/`right` = `translateX(∓0.71×baseWidth) scale(0.66)` at opacity 0.4; `far-*` = off
screen, opacity 0. With N ≥ 3 launchers exactly 3 cards are visible; N = 2 → centre + right; N = 1 → centre only.

- **Inline transforms, not CSS classes**: theme CSS (`.card.focused { transform }`) would out-rank a class under the
  `:root[data-theme]` prefix; themes' `.card.focused` transforms were removed. `.card.focused` now only carries the
  border and glow — the "size" comes from `scale(1)` vs `scale(0.66)`.
- **Spacing from the measured width** (`measureCardWidth()` → `getComputedStyle(cards[0]).width`; `transform` does not
  change it, so the shrunk side cards report the same base) — no JS copy of the CSS `vh` values. `resize` re-runs
  `layoutCarousel()` (resolution change when entering TV mode). Card size is `vh`-based `clamp()`: follow that
  pattern for any scalable card element.
- **Animation:** transition `cubic-bezier(0.34, 1.4, 0.64, 1)` (a slight overshoot); the blurred `.card-bg` icon
  moves with a **parallax** (`CARD_BG_PARALLAX = 0.1` of the card's `p.x`, opposite direction); `data-motion=off`
  disables both. **Wrap teleport:** when navigating makes a card's offset jump by more than 1 (wrapping round), for
  one frame it gets `.no-anim` and is placed at the off-screen point of the destination side, then a
  `requestAnimationFrame` re-enables the animation and slides it home (a reflow `void card.offsetWidth` between
  the steps; the pending rAF recomputes a fresh offset so quick consecutive navigation doesn't drift). `win31`
  keeps `transition: none` so the carousel snaps.
- `renderCards()` ends with `cardPrevOffset.clear()` + `layoutCarousel()` + `renderRecentBar()` +
  `updateCarouselPeek()`; `updateFocus()` only sets `focusedIndex` + `layoutCarousel()`. Edge "peek" arrows
  (`#carouselPeek{Left,Right}`, faint `‹ ›`, `z-index: 0`, only with more than 3 cards, `peek-breathe` animation).
- **Initial focus = the most recently launched launcher** (`mostRecentLauncherIndex`), set by `initLaunchers()`
  after `renderCards()`, **only on the first load**.
- **Per-launcher accent:** the optional `accent` (`#rrggbb`) → `cardAccent(l)` (regex-validated: the hex is
  interpolated into a `style` attribute) → `style="--card-accent:<hex>"` on the `.card`; CSS uses
  `var(--card-accent, var(--accent))`; the glow colour goes through the `--focus-glow-color` token (default
  `var(--accent)`, the `.card` rule sets it to `var(--card-accent, var(--accent))`; `--focus-shadow` uses
  `color-mix(... var(--focus-glow-color) N%, transparent)`). `neon`/`nintendo`/`deck` honour it; `win31`/`oled`
  exclude it with `& .card { --card-accent: var(--accent) !important }`.
- The **Games pseudo-card** (`GAMES_CARD`, id `__games__`) is appended by `renderCards()` and is deliberately not in
  `launchers` ([../games-panel.md](../games-panel.md#the-panel-ui)).
- Each `.card` also gets a blurred background icon (`<img class="card-bg">`, same `src`, `z-index: -1`,
  `filter: blur()`, `opacity: var(--card-bg-opacity)`; error → `display: none`, not the fallback icon).
  Icons: `assets/icons/<id>.(png|svg)`, referenced by a relative path; `renderCards()` binds an `error` listener
  → `FALLBACK_ICON`, so a missing file is not a broken-image glyph. A new launcher: download the icon there and
  reference it relatively.

## Quick-launch bar under the focused card

`#recentBar` (below `.cards`) shows the **focused** card's `recentGames` (from the `launchersWithUsage()` payload) as
mini cover icons (`<button class="recent-game">`, cover `<img>` via `fileUrl()` with an `error` fallback to the
`.recent-game-noart` title placeholder); only on the focused card; fixed `min-height` so the layout doesn't jump
between launchers; empty list → the bar is empty but keeps its space. Colour `var(--accent)`.
- `recentBarFocus` (global in `carousel.js`): `-1` = on the card, `0..2` = in the bar. The main navigation branch in
  `gamepad.js` handles it (the bar is part of the main nav, not its own overlay): in the bar ◀▶ steps between
  icons, ▼ enters (if any), ▲ returns, ✕ calls `launchRecentGame(entry)`. **A short ○ does not step back** (the main
  nav watches ○ for the 5 s TV-mode-exit hold) — only ▲.
- `launchRecentGame(entry)` follows the games-panel launch helpers (`isLaunching` + `showLoading` + the `kind`'s
  `launch*` + `armLaunchWatchdog`). `renderRecentBar()` is called from `renderCards()`, `updateFocus()`,
  `initLaunchers()` (after the initial focus) and `onAppClosed`; `updateFocus()` resets `recentBarFocus`.

## Continue bar

`#continueBar` (in `.container`, after `.header`, above the carousel) shows the **latest games of all sources**
(`get-continue-games` = `globalRecentGames(8)` merged with Lutris; `CONTINUE_BAR_MAX` = 8). No push channel: `ipc.js`
`onRunningChanged` / `onAppClosed` and `initLaunchers()` call `refreshContinueBar()` (fetch + render). Empty → `bar.hidden =
true` (unlike `#recentBar` it takes no space; the `.container` loses `has-continue`). The focused item's cover is
**blurred in the background** (`#continueBackdrop`, `updateContinueBackdrop()`; `data-motion="off"` = no cross-fade),
and a still-running launcher-started game adds a "▶ BACK" first item ([../launching.md](../launching.md#cancel-resume-session-summary)).
- **Vertical three-zone navigation** (`nav*` helpers in `gamepad.js`, `continueFocus` in `state.js`): continue bar
  (top) ↔ cards (middle) ↔ `#recentBar` (bottom); ▲ from the cards enters the continue bar, ▼ returns; ◀▶ steps between
  icons; ✕ launches `continueBarGames()[continueFocus]`; `inContinueBar()` / `inRecentBar()` guards; `updateFocus()`
  resets both. The keyboard fallback goes through the same `nav*` helpers.

## Card quick actions

On the focused **real** launcher card (not the Games card, not the bars — `focusedLauncherCardId()`) a **long ✕**
(550 ms, `handleCardCrossInput()`; a short ✕ launches **on release** = `navActivate`) **or an immediate □** opens a
standalone `.settings-overlay` (`cardMenuOpen`, `handleCardMenuInput`, after the games-panel branch in `pollGamepad`);
□ was added because the hold was undiscoverable. `closeCardMenu(gp)` → `syncEdge(buttonStates, gp, ['cross','ps'])`;
on entry `{ cross: true }`.
- **Root page:** "Move to the front" (`setLauncherOrder([id, …rest])`) / "Open games" / "Accent colour ▸" /
  "Remove" (only `l.custom`). **The row indexes vary per launcher** ("Open games" appears only for some), so returning
  from the accent page computes the focus with `cardMenuRootRows().findIndex(r => r.id === 'accent')`, never a
  hard-coded `1`.
- **Remove = confirm + undo:** the first ✕ only arms (`.armed`, "ONCE MORE ✕…", resets after
  `CARD_REMOVE_ARM_MS` 3 s; navigating/closing also disarms), the second calls `removeLauncher`. Then for
  `CARD_REMOVE_UNDO_MS` (8 s) the toast reads "NAME REMOVED · △ UNDO" (`showStatus(..., { ms })`) and the home screen's
  △ calls `undoLauncherRemoval()` → `undo-remove-launcher`. The main process keeps a one-element trash for
  `LAUNCHER_REMOVE_UNDO_MS` (30 s) with the entry, its order position and its custom ROM sources; the imported icon
  is deleted when the trash empties. A new removal finalises the earlier one.
- **"Open games" row:** shown only if `launcherHasGamesEntry(l.id)`: the id is in `LAUNCHER_ID_TO_GAMES_SOURCE`
  (usually 1:1 with the panel's source id: ryujinx/pcsx2/cemu/rpcs3/ppsspp/dolphin/melonds/duckstation/lutris/
  steam; `retroarch` → `'retro'`, as there is no single RetroArch list) **or** `l.id === 'heroic'` (its three stores
  have no single `heroic` filter). On select, `openLauncherGamesFromCardMenu(id, gp)` **closes the menu first**,
  then calls `openGamesPanelForLauncher(id)` (async: it first checks with the launcher's `list-*` IPC that there is at
  least one hit); `false` → a `toast.cardGamesEmpty` and the panel is not opened at all (user decision — no empty
  panel flash). Heroic: `pickHeroicSource(gameRows)` filters to the first non-empty store in
  `HEROIC_SOURCE_PRIORITY = ['gog','legendary','nile']` (L2/R2 hops to another; there is deliberately no combined
  virtual `heroic` filter). `openGamesPanel(initialSource)` takes the starting source.
- **Accent page:** the fixed `CARD_ACCENT_PALETTE` (8 hex + "Default") as `.theme-swatch` swatches; ✕ =
  `setLauncherAccent({ id, accent })` (`null` clears). A fixed palette, not HSV (the overlay is 85 % opaque).
  The `suppressLaunchersToast` flag swallows the generic "ORDER SAVED" toast (the menu shows its own).
- Keyboard fallback: `cardMenuKey(btnIndex)` (the `settingsKey` pattern, shared `synthPadFrame`).

## Quick power menu

Start/Options/Menu (`BTN.start`, `buttons[9]`) opens, from **anywhere** on the home screen, a standalone overlay:
Power off / Reboot / Sleep / Close program. `quickPowerOpen`, `handleQuickPowerInput`, `closeQuickPowerMenu(gp)` →
`syncEdge(buttonStates, gp, ['cross','ps','start'])`, on entry `{ cross: true }`. `QP_ROWS`: `poweroff`/`reboot`/`suspend`
(`armed: true`, two-step ✕) + `quit` (`armed: false`, immediate `window.launcher.quit()` — the same as the PS combo;
the watcher restarts the launcher at the next BT trigger). No new IPC (`systemAction`/`quit` already existed).
Hand-rolled `edge()` input (not `navList`: "armed" is a third state next to focus/selection), through
`createArmedActionList` ([overview.md](overview.md#settings-view-factories)).
This menu and Settings → System → Power are **two code paths on purpose** (call-site level), so the quick button
does not depend on the settings navigation depth; only the repeated mechanism is shared.

## Screensaver

After the configured gamepad inactivity (`idleTimeout`, default 3 min, 0 = off) a black `pointer-events: none` overlay
shows the **active launchers' icons spinning and bouncing** (the classic bouncing-logo pattern; deliberate on an OLED
TV: a static image — even a static clock — would itself be a burn-in risk) plus a **discreet bouncing clock**
(`HH:MM`, `stepAxis`, no rotation, slower `ATTRACT_CLOCK_SPEED` 55 px/s, updated only at the minute change).
`z-index: 300` — above every overlay. No icon–icon collisions (walls only; an aesthetic/complexity decision). **No
CEC interaction** (turning the TV off/muting would be too aggressive for a visual saver, and the CEC state cannot be
queried reliably from here).
- `pollGamepad()` at the very top (before the branches, like the volume buttons) aggregates the pad, calls
  `noteActivity(gp)` (any button **or** stick movement counts as activity, not only threshold-crossing input) and
  `checkIdle()`. Pure functions: `isIdle(lastInputAt, now, thresholdMs)`, `stepAxis(pos, v, dt, size, boundMax)`,
  `resolveIdleFocus(hasFocus, hadFocus, now, lastInputAt)`.
- **It counts and starts only while the launcher window has focus** (`document.hasFocus()`, not `document.hidden`, which
  covers both "hidden, a game is running" and "another window is in front"); on focus **return**
  `resolveIdleFocus` resets `lastInputAt` to now, so time spent in the background does not count. `main.js` binds the
  `window` `blur` event to `onLauncherBlur()` (`idleHadFocus = false` + hide), because while the window is hidden
  `requestAnimationFrame` (and `checkIdle` with it) pauses, so no loop could notice the focus loss.
- `showIdleOverlay()` spawns an `<img class="attract-icon">` per active launcher (the Games card excluded) with random
  position/direction/spin (`spawnAttractIcons`), driven by its own `dt`-based rAF loop (`attractTick`, ≤ 50 ms/frame);
  `hideIdleOverlay()` cancels the rAF and empties the overlay. It uses inline `transform: translate() rotate()`
  (theme CSS specificity rules out a class).
- **Auto sleep / idle BT disconnect** (`idle-power.js`): `autoSuspend` / `idleDisconnect` measure idleness only while the
  launcher is focused, once per stretch; sleep goes through `system-action`, the disconnect through
  `disconnect-idle-controllers` → `bluetooth.disconnectGamepads()`.
- **Poll throttle while idle:** every `pollGamepad` re-schedule goes through `pollNext()`: with no pad input for
  `IDLE_POLL_MS` (2 s) and `!document.hidden`, `setTimeout(pollGamepad, 66)` (~15 fps) instead of
  `requestAnimationFrame`; the first pad delta returns to rAF (≤ 66 ms latency to the first press). A hidden window
  keeps rAF (the browser stops it by itself). The idle overlay is covered by the same 15 fps; `attractTick`'s own rAF
  stays at 60 fps. Pure helper `shouldThrottlePoll(hidden, lastInputAt, now, idleMs)`.
- **Auto sleep / idle disconnect decisions:** "idle" is the same as for the screensaver (no pad button/stick input **and** the launcher window has focus); a
  running game does not count (the launcher is hidden, the focus-return reset zeroes the counter, `isLaunching` also blocks); one minute before auto sleep a toast
  (`toast.autoSuspendWarning`) appears and any button cancels it; the disconnect has no warning because PS reconnects at once; **each action fires at most once per
  idle stretch** (one `lastInputAt` value) — otherwise the huge idle time measured after a resume would put the machine straight back to sleep; both default off
  (sleep Off/30/60/120 min, disconnect Off/10/20/30 min); disconnect = every connected BT gamepad (wired pads untouched). Limits: only controller input counts as
  activity (not keyboard/mouse); after a wake with no controller (power button) the next sleep arms only in a new stretch after the first controller input; a
  disconnected main controller reconnecting does not start TV mode (the BT trigger's "launcher already running" guard).
- A forgotten-input gotcha: see "panel close / launcher return" in [input.md](input.md#edge-trigger-gotchas).

## Startup splash

The logo's **lift-off animation** covers the start while everything loads in the background (2026-10-27): a controller with the
D-pad-shaped rocket seated in its pad → the pad shakes (ignition: glow, smoke puffs, flame) → the rocket lifts off and the
**camera follows it up: the controller slides out of the frame at the bottom** (`.sp-world`), the rocket grows to the logo size and
its flame shrinks to the logo's short one → the lettering **"LAUNCHERS / LAUNCHER"** slides in **to the right of the rocket**
(final frame = the logo, rocket + lettering centred; no controller). The program's user-visible name is *Launchers Launcher*.
- **Parts:** `index.html` `#bootSplash` (first element of `<body>`: an inline SVG, 1280×720 viewBox — the controller/smoke are in the design's own coordinates inside `.sp-world`, the CSS places them — the letters are *paths*, so no
  font/network is needed at the first paint) + `styles/08-boot-splash.css` + `renderer/boot/boot-splash.js` (a boot script after
  `#cards`, outside the renderer bundle). **Pure CSS animation**, no JS frame loop.
- **Timeline** (the `sp-total` animation on the root = 3.4 s; the delays/durations of the parts sum to that —
  `test/contracts/boot-splash.test.js` guards it): fade-in 0–0.5 s · ignition 0.5–1.2 s · lift-off 1.2–2.7 s (the rocket flies to the logo position, the world drops away, the flame goes long → short) · lettering 2.3–3.4 s.
- **Dismissal = BOTH:** the real cards are drawn (`boot-splash.js` observes `#cards`: `renderCards()` overwrites the
  `.card-skeleton` placeholders — no coupling to renderer code) **and** `sp-total` ended. The animation always plays through
  (user decision) — a fast start does not cut it short; a slow start holds the final frame (the flame keeps flickering).
  Then `.is-leaving` fades it out (0.45 s) and the element is removed. A 20 s failsafe removes it anyway.
- **The BASE style is the final frame**; keyframes only give the `from` state (`both` fill). So `data-motion="off"` (the global
  `animation: none !important`) leaves a **static logo** — and the `animationcancel` event (or `animationName === 'none'` at
  the first style resolve) marks the animation done, so the static logo goes away as soon as the cards are ready.
- **Theme-independent** (fixed `#0E1120` / `#FF7A1A`; the theme is not necessarily applied at the first paint). `z-index: 340`:
  above the screensaver (300), below the brightness/night filters (350/351) and the fatal error overlay (400).
- The renderer reload (fatal overlay ✕, renderer-crash recovery) shows it again — the only reload triggers.
- **Offscreen tools:** `test/e2e/harness.js` has a scenario that checks the splash is removed (and not before 3.3 s);
  `tools/user-guide/user-guide-shots.js` removes it right after the load (it would cover the shots). A new offscreen script that
  photographs the real UI must do the same.
- **Previewing the animation** (offscreen, deterministic): pause all `document.getAnimations()` and set `currentTime` per
  frame, then `capturePage()` — no wall-clock waiting.
- **Logo assets:** `assets/logo/` (`logo.svg`, `logo-wordmark.svg`, `logo-512.png`); where the logo is used: the `.desktop` icon
  (`share/launchers-launcher.desktop`), the XDG autostart entry, the favicon, the Electron window `icon`, and the setup wizard's
  welcome step (`.wizard-logo`). The window title / `.desktop` `Name` = "Launchers Launcher"; the foreground guard's KWin
  `activateWindow('Launchers Launcher')` matches the window title — they change together. Internal identifiers
  (`launchers-launcher-*` files/units, the repo folder, data dirs) were deliberately NOT renamed.
