# Input: gamepad, PS combos, on-screen keyboard

Code: `renderer/gamepad.js` (the whole dispatcher), `renderer/util.js` (edge helpers), `renderer/keyboard.js`,
`renderer/controller/*`.

## Contents

- [Button map](#button-map)
- [PS combos](#ps-combos)
- [Polling model](#polling-model)
- [Edge-trigger gotchas](#edge-trigger-gotchas)
- [Held directions and held buttons](#held-directions-and-held-buttons)
- [Button labels per controller type](#button-labels-per-controller-type)
- [On-screen keyboard](#on-screen-keyboard)
- [Controls help](#controls-help)

## Button map

Standard Gamepad API indexes (DualSense). **If a button's role changes, also adjust `CONTROLS_HELP`**
([below](#controls-help)).

| Index | Button | Role |
|---|---|---|
| 0 | ✕ Cross | launch / select; **long hold on a real card → card quick menu**; short press acts **on release**; in the Games panel a **long ✕ = game details** |
| 1 | ○ Circle | **held (default 5 s, `tvExitHold`) → TV-mode exit**; short → "cancel/back" in panels |
| 2 | □ Square | the focused real card's quick menu (immediately); in the Games panel the source filter popup |
| 3 | △ Triangle | open the Games panel (undo a launcher removal during its toast) |
| 4/5 | L1/R1 | PC volume down/up (`pactl`), always, in any mode |
| 6/7 | L2/R2 | unused on the home screen; Games panel: source chip cycle / letter jump in a ROM list |
| 8 | Select/Share/View | opens **Settings** (`BTN.select`); in the Games panel: live **search** |
| 9 | Start/Options/Menu | quick power menu; in the Games panel root view: manual **Refresh** (`refresh-games`) |
| 12–15 | D-pad | navigation |
| 16 | PS/Home | **alone it is deliberately a no-op on the main card view** (since 2026-09-22); in an open popup it is still "back" (the `'cancel'` pseudo-key = Circle **or** PS, which the combo layer does not mask); in a kill-watch session it closes the running game |

The TV volume/mute over CEC dropped off the main menu (the `tv-volume`/`tv-mute` IPC and `lib/output/cec.js` remain,
no UI calls them; they can be re-bound anywhere).

## PS combos

PS alone closes nothing; instead three two-button combos (press the other button while **holding PS**):

- **PS + ○** → quit the launcher (`window.launcher.quit()`); works **everywhere** (main view and any popup),
  except during a killable session.
- **PS + △** → disconnect the pressing physical controller over Bluetooth (`btDisconnect('controller', mac)`). The
  target is **exact**: the renderer asks the main process's evdev watcher (`lib/evdev-pads.js`,
  [../devices.md](../devices.md#which-pad-pressed-the-ps-combo-evdev)) which MAC is holding PS
  (`resolve-combo-pad`) → `disconnectDecision(res, ctrlBtItems)`: a connected BT controller's MAC → that one; a hit
  without a MAC / not BT → `toast.controllerDisconnectWired`; no unambiguous evdev hit → the old strict
  `resolveDisconnectTarget` rule (0 BT → nothing; 1 → that; 2+ → only with a unique type, else
  `toast.controllerDisconnectAmbiguous`).
- **PS + □** → the pressing pad rumbles (`rumblePad(padIndex)`) and its badge on the top-right battery strip flashes
  (`flashControllerChip(padIndex, mac)`: the BT chip by evdev MAC `chipIndexForMac`; without a MAC the old
  order-based guess `chipIndexForPad`).

**Architecture:** the merge-all `aggregatePad()` discards *which* physical pad pressed, which the combos need, so a
new per-pad layer works on the raw `getPads()` at the **very start of the `!isLaunching` branch** of
`pollGamepad()` (before any popup branch, so it is reachable from everywhere like L1/R1): `detectPsCombos(pads)`
tracks each pad's previous ○/△/□ state (keyed by `pad.index`) and, while that pad's PS is held, fires a `{ padIndex,
padId, combo }` event on the **rising edge** of the other three (`handlePsCombo()` processes it).
`maskChordButtons(pads, heldIndices)` masks the ○/△/□ of the pad(s) holding PS to "not pressed" **before**
`aggregatePad()` — otherwise PS+△ would also open the Games panel, PS+□ the card menu and PS+○ would start the 5 s
TV-exit hold. **PS itself is not masked**. The idle detector's aggregate (at the top of `pollGamepad()`) uses the
raw, unmasked pads. Tested pure helpers: `detectPsCombos`, `maskChordButtons`, `resolveDisconnectTarget`,
`disconnectDecision`, `chipIndexForPad`/`chipIndexForMac`.

## Polling model

- **Merge-all:** `pollGamepad()` follows **no** distinguished pad. Every frame it builds one synthetic pad from all
  `connected` pads in `getPads()` (`aggregatePad()`): `buttons[i].pressed` = pressed on any pad, `axes[i]` = the
  largest absolute value. That single `gp` goes to every call site, which keeps using
  `gp.buttons[i]?.pressed` / `gp.axes[i]`. So **several controllers drive the UI at once**, and after a launcher/game
  closes every pad works again as soon as Chromium re-exposes them — no dependence on `gamepadconnected` firing
  again. `gamepaddisconnected` has **no** handler for navigation (another pad is unaffected; `main.js` only re-renders
  the controller badge); `gamepadconnected` only shows the "CONTROLLER CONNECTED" toast. A "poke" against a Chromium
  quirk that sometimes withholds pads until a button press after returning: `navigator.getGamepads()` is called in
  the `window` `focus` event and in `onAppClosed`.
- **A popup that blocks the main navigation:** branch in `pollGamepad()` with its own open check and its own
  `handle*Input()`; **don't share the `buttonStates` keys with the main nav** (in practice via `createOverlay` +
  `OVERLAY_STACK`, [overview.md](overview.md#overlays-createoverlay-and-overlay_stack)). L1/R1 volume runs at the very
  top of `pollGamepad()`, before the main/panel branching — that is the pattern for any button that must react at any
  time.
- **Throttle:** see [home.md](home.md#screensaver).
- **Kill-watch input:** while `isLaunching && killWatchActive`, `handleKillWatchInput(gp)` runs instead of every other
  branch, on its own `killWatchButtonStates` ([../launching.md](../launching.md#kill-watch-sessions-melonds)).
- **Keyboard fallback for testing without a controller** (`renderer/main.js`): ◀ ▶ card navigation, Enter/Space launch,
  Esc quit, `t` cycles the themes (the whole `themes.json` manifest); in Settings `settingsKey(btnIndex)` feeds a
  synthetic pad push (▲▼◀▶ / Enter / Esc); the on-screen keyboard accepts direct typing. The home screen's
  Select/Start/△/□ have no keyboard fallback (test with a controller).

## Edge-trigger gotchas

Helpers in `util.js`: `edge(states, key, pressed, onPress)` (fires only at the press moment), `edgePressed`,
`syncEdge(states, gp, keys)` (the `'cancel'` pseudo-key = ○ or PS), `navList(gp, states, { count, move, onSelect,
onBack })` (the "▲▼ focus, ✕ select, ○/PS back" scheme; the caller keeps the focus index in the `move(delta)`
closure, `count` 0 → ▲▼ no-op), `edgeRepeat`, `edgeHold`. Every new view gets its **own** `*ButtonStates` object (do
not share — the edge states would collide). `BTN` holds the indexes.

- **Panel close:** while a panel is open, the main branch (and with it the main `buttonStates` update) does not run.
  If the closing button (✕) is the same one the main navigation watches, its key in the main `buttonStates` sits at the
  pre-open value (`false`); if the user still holds it on close, the next frame sees a *fresh* press and fires its
  action (e.g. launches the focused card). **On close, sync every affected key with the physical state:
  `syncEdge(states, gp, keys)`** — see `closeSettings(gp)`, `backToSettingsMenu(gp)`, `closeGamesPanel(gp)`,
  `closeCardMenu(gp)`, `closeQuickPowerMenu(gp)`. Inside a panel, switching views needs no sync (the main branch stays
  skipped); entering a sub-view needs `xxxButtonStates = { cross: true }` (it did not for four views at first, so
  a ✕ entering them triggered a second immediate action).
- **Launcher return:** while a game runs the window is hidden and the rAF loop paused, so the main `buttonStates`
  (+ the ✕-hold timers `crossHoldStart`/`crossHoldFired` and `circleHoldStart`) can stay stale for hours. If a button
  is physically down at the moment of return (the closing game's own "confirm" press can coincide with the window
  regaining focus — verified with RPCS3 Big Picture Mode), it looks like a fresh press: PS → an unwanted immediate
  `quit()`, ✕ → an unwanted card relaunch. **`onAppClosed` therefore runs `syncEdge(buttonStates,
  aggregatePad(getPads()), [...])` on return and zeroes the hold timers**, just like a panel close.
- A panel's `onBack` must be `() => backToSettingsMenu(gp)` (see [overview.md](overview.md#settings-view-factories)).

## Held directions and held buttons

**Directions repeat while held; action buttons fire once.** `edgeRepeat(states, key, pressed, onPress(repeated), {
delay=380, interval=95, now })`: first press at once as `onPress(false)`, held → `onPress(true)` after `delay`, then
every `interval`; at most one firing per poll and the next time is relative to `now` (**no catch-up** — a slow render
such as the ~16 000-row ALL list does not pile up steps). Timers live in a `WeakMap<states, …>`, so re-assigning
`states = { cross: true }` or `syncEdge` resets them. `navList` (▲▼) uses it, so every menu/sub-view/wizard gets it.
**Wrap-around:** lists call `stepIndex(idx, d, n, repeated)` — a fresh press wraps, a repeat **stops** at the list
end/start (a 3-row list must not spin); **in new `navList` views use `stepIndex`, not `(x + d + n) % n`**. The main
carousel ◀▶ deliberately wraps on repeat too (`interval: CAROUSEL_REPEAT_INTERVAL_MS` = 170, because of the card
animation); the main nav ▲▼ (zone change) and `launcher-install` do not repeat. Repeating places: `navList`,
`gamepad.js` ◀▶ + stick, the games panel (▲▼◀▶ in both views + L2/R2 letter jump `LETTER_REPEAT_INTERVAL_MS` = 150),
`keyboard.js`, `settings-order.js`, `settings-system.js`, `quick-power.js`, `changelog.js` (scroll). In a repeat,
`feedback(kind, { repeated: true })` plays only the sound. The slow-repeat accessibility option multiplies delay and
interval.

**Short vs held on the same button:** `edgeHold(states, key, pressed, onTap, onHold)` (`HOLD_MS` 550) — the tap runs **on
release**; `onHold() === false` makes it count as a tap (the Games panel's ✕: tap launches, hold opens details).

## Button labels per controller type

`renderer/controller/controller-labels.js`: the UI shows glyphs matching the **active controller type** instead of
`✕ ○ △ □ PS` (Xbox → `A B Y X`, generic → `① ② ④ ③`). Every hint builder calls **`btnIcon(action)`** (span markup) /
**`btnGlyph(action)`** (raw glyph); `action` ∈ `confirm`/`back`/`menu`/`alt`/`home`/`view`/`start` (the last two =
the `buttons[8]`/`buttons[9]` pair, `⧉`/`☰`, Nintendo `－`/`＋`); the `.btn-icon` CSS class stays stable (`btn-view`,
`btn-start` too). The type comes from `mainController.type` → the type of the pad that last showed activity
(`detectActivePadType(pads)` → `noteActivePadType`) → `playstation` (default; the DualSense path is unchanged).
A type change makes `main.js`'s `setControllerTypeChangeHandler` re-render the bottom bar and the cards. **The
confirm/back branch of `pollGamepad` did not change** — still `buttons[0]`/`buttons[1]`; the Nintendo A/B swap is a
separate hardware-measurement task. Shared with the main process through `controller-id.js`
([../devices.md](../devices.md#controller-identification-and-battery)).

Controller badge on the home screen (`controller-status.js`): `controllerChips(btItems, pads)` + `pickBatteryWarnings(
items, warned, low=15, clear=25)` (pure) + `renderControllerStatus` / `pollControllerStatus` (every 30 s, only when
`!document.hidden`). One toast per device at ≤ 15 % (`toast.controllerBatteryLow`), re-armed only after ≥ 25 %
(hysteresis); zero new IPC.

## On-screen keyboard

`renderer/keyboard.js` — a controller-driven **alphabetic 2D grid**, its own `#keyboardOverlay` above the Settings
panel (`z-index: 250` > the settings overlay's 210). Callback-based (no async UI flow):
`openKeyboard({ title, initial, masked, maxLength, onConfirm(text), onCancel(), ownerStates, layout, dock, live,
onChange(text) })`. Callers: the launcher-add wizard (name/command/arguments chain; the installed-app filter is
`live` + `dock: 'bottom'`), Wi-Fi password (`masked: true`), the games search, the Settings search, launch options.

- The `keyboardOpen` branch in `pollGamepad()` goes **before** the `setupWizardOpen` branch (the keyboard opens above
  a sub-view). Grid model `KB_ROWS` (cells `{ t, v?, w? }`, `t` ∈ `char`/`shift`/`space`/`del`/`ok`/`cancel`; `w` is
  flex styling only — every cell is one navigation step). The pure `nextKeyFocus(rowLens, {r,c}, dir)` does **not**
  wrap at the edges and clamps the column to the last cell of a shorter row (not `navList`, which is 1D).
- Input: D-pad/stick = focus, ✕ = the focused cell (char inserts up to `maxLength`; Shift toggles `kbShift`; Del; OK →
  `onConfirm` + close; Cancel → `onCancel` + close), `masked` shows `•`.
- **`closeKeyboard(gp)`** → `syncEdge(kbConfig.ownerStates, gp, ['cross','cancel'])` on the *caller's*
  `*ButtonStates` (passed as `ownerStates`), so the still-held ✕ is not read as a new press by the caller's `navList`.
- **Optional modes** (built for the games search): `layout: 'compact'` → `KB_ROWS_COMPACT` (5 rows: digits, a–z + space + ⌫
  in the letter row, DONE/CANCEL; no Shift/punctuation) — the active layout is the `kbRows` variable, which
  `renderKeyboard`/`kbActivate`/`handleKeyboardInput`/`kbKey` read, **never `KB_ROWS` directly**; `dock: 'bottom'` →
  `#keyboardOverlay` gets `docked` (transparent background, panel at the bottom edge, title hidden) — the class is
  set **on open** and not removed on close (the 0.15 s fade-out must not jump to the middle); `live: true` +
  `onChange(text)` → called after every edit (grid key, □/△ shortcut, physical key); the caller must reserve space
  behind it (games panel: `--kb-h` + `kb-docked`).
- **DONE/CANCEL buttons:** **Start/Options = DONE** on every keyboard; **○/PS** is DONE too in `live` mode (the text
  stays — the filtering is already visible behind it, and a resetting ○ was misleading: "I close with ○ and all games are
  back"), CANCEL otherwise. A resetting CANCEL in live mode is only the grid's CANCEL button.
- **□ = ⌫, △ = space** on every keyboard (the hint says so).
- **Paste:** Ctrl+V / Shift+Insert → `kbKey('paste')` → `window.launcher.readClipboardText()` (`read-clipboard-text`,
  `lib/ipc/clipboard-ipc.js`, main-side `clipboard` — **in Electron 44 `readText()` is a Promise**) → `sanitizePaste`
  (newlines → space, control chars out, cut at `maxLength` with a toast on truncation). Other Ctrl/Meta combos type no
  letter (AltGr = ctrl+alt keeps its character). Works in masked mode; there is deliberately no controller "Paste"
  button.
- Keyboard fallback: `kbKey(action)` + the `main.js` keydown branch when `keyboardOpen`: direct typing / arrows /
  Enter / Esc / Backspace.

## Controls help

`renderer/controller/controller-help.js` `CONTROLS_HELP` — 3 sections (home / PS combos / Games panel), each row either
`keys` (the `btnIcon()` action names, several for a combo) or a `label` (`L1 / R1`) + a `help.*` i18n key; glyphs follow the
active type. It feeds two views: the setup wizard's `controls` step (`controlsHelpGridHtml()`, a compact grid) and
**Settings → Controllers → "Button layout"** (`settings-controls.js` with `renderFlatSections`, ▲▼ scrolls the rows).
**There is no automatic sync with the code** (the layout is spread over `edge()` calls). Tests: known actions, the PS
combos start with `home`, and the e2e (every sub-view opens; the wizard step fits without scrolling).
