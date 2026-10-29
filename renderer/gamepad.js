// Gamepad: merge-all pad aggregation, the skeleton of the main poll loop + the card navigation branch, launch + watchdog, PC volume buttons.
// Load order: after overlays.js / carousel.js, BEFORE settings*.js (pollGamepad calls the settings handlers at runtime). Square + L2/R2 are
// unused in the main menu TODAY (the CEC tv-volume/tv-mute IPC exists and can be rebound from anywhere). `aggregatePad` is pure
// (test/gamepad.test.js); STARTING pollGamepad happens in renderer/main.js. Background: docs/dev/renderer/input.md

// Node/test: BTN comes from renderer/util.js (a global <script> in the browser) — the PS combo
// (detectPsCombos/maskChordButtons) reads it
if (typeof BTN === 'undefined' && typeof module !== 'undefined') {
    // eslint-disable-next-line no-undef
    Object.assign(globalThis, { BTN: module.require('./util.js').BTN });
}

function launchApp() {
    if (isLaunching || !cards.length) return; // double-launch guard
    const appId = cards[focusedIndex].dataset.app;
    // The "Games" pseudo-launcher card spawns nothing, it only opens the renderer/games-panel/games-panel.js overlay (see carousel.js
    // GAMES_CARD) - no `isLaunching`, no `loadingOverlay` as for a real launch.
    if (appId === GAMES_CARD_ID) { feedback('nav'); openGamesPanel(); return; }
    feedback('launch');
    isLaunching = true;
    const launcher = launchers.find((l) => l.id === appId);
    // Launcher already running: no new instance, only a switch to its window - the loading overlay reflects that too.
    showLoading(launcher.name, launcher.running ? tr('verb.switch') : tr('verb.launching'), launcher.id);
    window.launcher.launch(appId);
    armLaunchWatchdog();
}

// Launching a game from the quick-launch bar under the focused launcher card. Builds on the shared `startGameLaunch()` (games-panel.js):
// `params`/`kind` come from the `recentGames` entry (steam/retroarch: derived by main from the launcher's OWN "recently played" data;
// heroic: stored).
// The Continue bar's "BACK" item: brings the running game's window forward (main activates it + hides the launcher).
function resumeRunningGame() {
    feedback('launch');
    window.launcher.resumeActiveSession().then((res) => {
        if (res && res.ok && !res.activated) showStatus(tr('toast.resumeNoWindow'));
    }).catch(ignoreError);
}

function launchRecentGame(entry) {
    if (!entry) return;
    startGameLaunch({ kind: entry.kind, params: entry.params, name: entry.name, cover: entry.cover });
}

// --- Main card navigation actions ---
// The pollGamepad edges AND the keyboard fallback of renderer/main.js call these — one source, no drift. Three vertical focus zones:
//   continueBar (top)  ↔  cards (middle)  ↔  quick-launch bar (bottom)
// `continueFocus >= 0` = in the global Continue bar; `recentBarFocus >= 0` = in the per-launcher quick-launch bar; otherwise among the
// carousel cards. ◀▶ in a bar steps between the mini icons.
function inRecentBar() {
    return recentBarFocus >= 0 && focusedRecentGames().length > 0;
}
function inContinueBar() {
    return continueFocus >= 0 && continueBarGames().length > 0;
}
// `repeated` = repeat of a held direction (edgeRepeat) — sound only, no rumble; the keyboard fallback (renderer/main.js) calls it without
// arguments.
function navFocusPrev(repeated) {
    crossHoldStart = null; crossHoldFired = false; // a card change cancels the ✕ hold
    if (inContinueBar()) {
        continueFocus = Math.max(0, continueFocus - 1);
        renderContinueBar();
    } else if (inRecentBar()) {
        recentBarFocus = Math.max(0, recentBarFocus - 1);
        renderRecentBar();
    } else {
        updateFocus(focusedIndex - 1);
    }
    feedback('nav', { repeated });
}
function navFocusNext(repeated) {
    crossHoldStart = null; crossHoldFired = false; // a card change cancels the ✕ hold
    if (inContinueBar()) {
        continueFocus = Math.min(continueBarGames().length - 1, continueFocus + 1);
        renderContinueBar();
    } else if (inRecentBar()) {
        recentBarFocus = Math.min(focusedRecentGames().length - 1, recentBarFocus + 1);
        renderRecentBar();
    } else {
        updateFocus(focusedIndex + 1);
    }
    feedback('nav', { repeated });
}
// ▼: continueBar → back to the card; card → into the quick-launch bar.
function navEnterRecentBar() {
    if (inContinueBar()) { continueFocus = -1; renderContinueBar(); feedback('back'); return; }
    if (!inRecentBar() && focusedRecentGames().length) { recentBarFocus = 0; renderRecentBar(); feedback('nav'); }
}
// ▲: quick-launch bar → back to the card; card → into the global Continue bar.
function navExitRecentBar() {
    if (recentBarFocus >= 0) { recentBarFocus = -1; renderRecentBar(); feedback('back'); return; }
    if (continueFocus < 0 && continueBarGames().length) { continueFocus = 0; renderContinueBar(); feedback('nav'); }
}
function navActivate() {
    if (inContinueBar()) {
        const entry = continueBarGames()[continueFocus];
        if (entry && entry.resume) resumeRunningGame();
        else launchRecentGame(entry);
    }
    else if (inRecentBar()) launchRecentGame(focusedRecentGames()[recentBarFocus]);
    else launchApp();
}

// The main-nav ✕ branch: on a real launcher card a LONG press opens the card quick menu, a short one (on release) launches.
// GAMES_CARD / the bars: immediate edge, as before.
function handleCardCrossInput(gp) {
    const pressed = gp.buttons[BTN.cross]?.pressed;
    const launcherId = (typeof focusedLauncherCardId === 'function') ? focusedLauncherCardId() : null;
    if (!launcherId) {
        edge(buttonStates, 'cross', pressed, navActivate);
        crossHoldStart = null;
        crossHoldFired = false;
        return;
    }
    if (pressed) {
        if (crossHoldStart == null && !buttonStates.cross) { crossHoldStart = Date.now(); crossHoldFired = false; }
        buttonStates.cross = true;
        if (!crossHoldFired && crossHoldStart != null && Date.now() - crossHoldStart >= CARD_MENU_HOLD_MS) {
            crossHoldFired = true;
            crossHoldStart = null;
            feedback('nav');
            openCardMenu(launcherId);
        }
    } else {
        if (buttonStates.cross && !crossHoldFired) navActivate(); // short press → launch
        buttonStates.cross = false;
        crossHoldStart = null;
        crossHoldFired = false;
    }
}

// Gamepad handling
//
// Merge-all: we do not follow one designated pad, but read ALL connected controllers every frame (aggregatePad), and a button/axis from
// any of them drives the UI. So several pads work at once, and after returning from a launcher every pad is live as soon as Chromium
// exposes them again - we do not depend on the `gamepadconnected` event firing again.
let volumeButtonStates = {};
const AXIS_THRESHOLD = 0.5;
const CAROUSEL_REPEAT_INTERVAL_MS = 170; // repeat interval of a held ◀▶ in the main carousel
const DEADZONE = 0.2;
let circleHoldStart = null;
// Long ✕ press on the focused launcher card → card quick menu. A short ✕ LAUNCHES (`navActivate` runs on RELEASE of the button if
// there was no hold).
let crossHoldStart = null;
let crossHoldFired = false;
const CARD_MENU_HOLD_MS = 550;
// `buttonStates` (edge-trigger state of the main nav) + `isLaunching` are written from SEVERAL files (settings.js/games-panel.js on
// panel close, games-panel.js on launch) → renderer/state.js.

// Idle-screensaver activity timestamp (see renderer/home/idle.js checkIdle()). Any button OR stick movement is "activity", not only
// input crossing the navigation threshold.
let lastInputAt = Date.now();

function noteActivity(gp) {
    const anyButton = gp.buttons.some((b) => b.pressed);
    const anyAxis = gp.axes.some((a) => Math.abs(a) > DEADZONE);
    if (anyButton || anyAxis) lastInputAt = Date.now();
}

// Rate switch of the main pollGamepad rAF loop: after 2 s without pad input (focused but idle — e.g. in front of an OLED TV) 60→~15
// fps, so getPads/aggregatePad/checkIdle do not spin needlessly. On the first pad delta (noteActivity → lastInputAt) the next tick
// switches back to rAF immediately, so navigation responsiveness is unaffected (max ~66 ms delay to the first button press). With a
// hidden window (a game is running) it stays rAF — the browser pauses that by itself, while a setTimeout would keep spinning at 15 fps.
const IDLE_POLL_MS = 2000;
const IDLE_POLL_INTERVAL_MS = 66; // ~15 fps

function shouldThrottlePoll(hidden, lastInputAtMs, nowMs, idleMs) {
    return !hidden && nowMs - lastInputAtMs > idleMs;
}

function pollNext() {
    if (shouldThrottlePoll(document.hidden, lastInputAt, Date.now(), IDLE_POLL_MS)) {
        setTimeout(pollGamepad, IDLE_POLL_INTERVAL_MS);
    } else {
        requestAnimationFrame(pollGamepad);
    }
}

// Launch watchdog: if the launched app does not take over the screen AND neither `app-closed` nor `app-error` arrives (the `child` died
// without firing either event, or main's `bringToFront` timer got lost), `isLaunching` would stay `true` forever -> the start of
// `pollGamepad()` blocks and the UI freezes. This releases it.
let launchWatchdog = null;
const LAUNCH_WATCHDOG_MS = 45000;

function clearLaunchWatchdog() {
    if (launchWatchdog) { clearTimeout(launchWatchdog); launchWatchdog = null; }
}

function armLaunchWatchdog() {
    clearLaunchWatchdog();
    launchWatchdog = setTimeout(() => {
        launchWatchdog = null;
        if (!isLaunching) return;
        // The launcher window is hidden → the app took over the screen, keep waiting (the return is handled by app-closed / bringToFront).
        // `killWatchActive`: in a killable (melonDS) session the window is DELIBERATELY not hidden (`document.hidden` stays false), so this
        // guards against a false "failed launch" toast after 45 s on a game that is actually running (see docs/dev/launching.md).
        if (document.hidden || killWatchActive) { armLaunchWatchdog(); return; }
        isLaunching = false;
        hideLoading();
        // The game is alive (the launcher only came back in front of it): not a "failed launch" — the Continue bar's "BACK" item takes you back.
        if (activeSessionInfo) { renderContinueBar(); return; }
        showStatus(tr('toast.launchFailed'), true);
    }, LAUNCH_WATCHDOG_MS);
}

function endLaunching() {
    isLaunching = false;
    clearLaunchWatchdog();
}

// --- Controller force close ("kill-watch") ---
// Some emulators (currently only melonDS) offer no controller exit — while `killWatchActive` is true (signalled by main's
// `app-launched` push, see renderer/ipc.js onAppLaunched), the PS/Home button does NOT close the launcher but the running game via
// the `kill-active-game` IPC. Own edge state (not the main `buttonStates`), because while a killable game runs, the main nav branch
// (which would also write the `ps` key) does not run (`isLaunching` guard).
let killWatchButtonStates = {};

function handleKillWatchInput(gp) {
    edge(killWatchButtonStates, 'ps', gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        window.launcher.killActiveGame();
    });
}

// Cancelling a launch on the loading screen: while the launcher is still visible (`isLaunching`, not a killable session), holding ○
// for `LAUNCH_CANCEL_HOLD_MS` cancels the launch — main stops its own spawned process (if still alive) and the launcher comes back.
// Own hold state; the main nav branch does not run meanwhile.
const LAUNCH_CANCEL_HOLD_MS = 1000;
let launchCancelHoldStart = null;

function handleLaunchCancelInput(gp) {
    if (!gp.buttons[BTN.circle]?.pressed) {
        if (launchCancelHoldStart !== null) { launchCancelHoldStart = null; setLoadingCancelProgress(0); }
        return;
    }
    if (launchCancelHoldStart === null) launchCancelHoldStart = performance.now();
    const ratio = (performance.now() - launchCancelHoldStart) / LAUNCH_CANCEL_HOLD_MS;
    if (ratio < 1) { setLoadingCancelProgress(ratio); return; }
    launchCancelHoldStart = null;
    setLoadingCancelProgress(0);
    feedback('back');
    window.launcher.cancelLaunch().then((res) => {
        if (res && res.killed === false) showStatus(tr('toast.launchCancelledLeft'));
    }).catch(ignoreError);
}

// How long ○ must be held to exit TV mode — Settings → Startup → "TV-mode exit time" (`tvExitHold` pref, s); loaded by
// renderer/ipc.js. Deliberately has no "off" value: this is the only controller exit path from TV mode.
let circleHoldMs = 5000;

function handleVolumeButtons(gp) {
    edge(volumeButtonStates, 'l1', gp.buttons[BTN.l1]?.pressed, () => window.launcher.changeVolume(-volumeStep));
    edge(volumeButtonStates, 'r1', gp.buttons[BTN.r1]?.pressed, () => window.launcher.changeVolume(volumeStep));
}

// --- PS combo (PS + Circle/Triangle/Square) ---
// The merge-all aggregatePad drops WHICH physical pad pressed — the disconnect/flash target needs exactly that, so this layer works on
// the RAW (getPads()) pad list, with per-pad previous-frame state.
let psComboPrev = new Map(); // pad.index -> { circle, triangle, square } previous physical state

// Per pad: while that pad's PS (BTN.ps) is held, returns one { padIndex, padId, combo } for each RISING edge (not pressed -> pressed)
// of Circle/Triangle/Square. The returned `heldIndices` is the set of pad.indexes currently holding PS (for masking).
function detectPsCombos(pads) {
    const fired = [];
    const heldIndices = new Set();
    const seen = new Set();
    for (const p of pads) {
        seen.add(p.index);
        const prev = psComboPrev.get(p.index) || { circle: false, triangle: false, square: false };
        const cur = {
            circle: !!p.buttons[BTN.circle]?.pressed,
            triangle: !!p.buttons[BTN.triangle]?.pressed,
            square: !!p.buttons[BTN.square]?.pressed,
        };
        if (p.buttons[BTN.ps]?.pressed) {
            heldIndices.add(p.index);
            if (cur.circle && !prev.circle) fired.push({ padIndex: p.index, padId: p.id, combo: 'quit' });
            if (cur.triangle && !prev.triangle) fired.push({ padIndex: p.index, padId: p.id, combo: 'disconnect' });
            if (cur.square && !prev.square) fired.push({ padIndex: p.index, padId: p.id, combo: 'identify' });
        }
        psComboPrev.set(p.index, cur);
    }
    // Drop the state of vanished (disconnected) pads so the Map does not grow forever.
    for (const key of Array.from(psComboPrev.keys())) {
        if (!seen.has(key)) psComboPrev.delete(key);
    }
    return { fired, heldIndices };
}

// For the pads in `heldIndices`, masks Circle/Triangle/Square as "not pressed" BEFORE handing them to aggregatePad() — otherwise a
// PS+Triangle combo would also trigger the standalone Triangle action (Games panel), PS+Square the card quick menu, and PS+Circle would
// start the 5 s TV-exit hold of Circle too. The PS button itself is NOT masked — so in open panels the existing "○/PS = back"
// (`syncEdge` 'cancel' pseudo key) stays unchanged for a standalone (non-combo) PS press.
function maskChordButtons(pads, heldIndices) {
    if (!heldIndices || !heldIndices.size) return pads;
    return pads.map((p) => {
        if (!heldIndices.has(p.index)) return p;
        const buttons = p.buttons.map((b, i) => (
            (i === BTN.circle || i === BTN.triangle || i === BTN.square) ? { pressed: false, value: 0 } : b
        ));
        // NOT `{ ...p, buttons }` — the native Gamepad's `axes`/`id`/`index` are GETTERS on Gamepad.prototype, not own enumerable
        // properties; a spread silently drops them (`p.axes` -> undefined -> aggregatePad() fails on `.length`).
        return { index: p.index, id: p.id, buttons, axes: p.axes };
    });
}

// Disconnect target for the PS+Triangle combo — ONLY in an unambiguous case (the Gamepad API gives no MAC; a wrong guess would
// disconnect someone else's controller, so instead of the order estimate used for PS+Square a stricter rule applies here).
function resolveDisconnectTarget(padType, btItems) {
    const connected = (btItems || []).filter((d) => d.connected);
    if (connected.length === 0) return null; // probably a USB pad — nothing to disconnect
    if (connected.length === 1) return connected[0]; // a single BT controller — unambiguous
    const matches = connected.filter((d) => d.type === padType);
    return matches.length === 1 ? matches[0] : null; // 2+ of the same type -> no guessing
}

// MAC of the controller pressing the PS combo, from main's evdev watcher (lib/evdev-pads.js, `resolve-combo-pad` IPC). The Gamepad API
// gives no MAC; main knows from the kernel `uniq` field which device is holding PS right now.
// Error / no evdev → `{ ok: false }` → the caller falls back to the old (estimating / strict) rule.
function resolveComboPadSafe() {
    if (!window.launcher || typeof window.launcher.resolveComboPad !== 'function') {
        return Promise.resolve({ ok: false, matched: false, mac: null });
    }
    return window.launcher.resolveComboPad().catch(() => ({ ok: false, matched: false, mac: null }));
}

// PS + Triangle decision from the evdev match (`res`) + the BT list:
//   { action: 'disconnect', mac } | { action: 'wired' } | { action: 'fallback' }
// `matched` + the MAC belongs to a connected BT controller → exactly that one; `matched` but no MAC or not in the BT list → a wired
// (USB) pad, nothing to disconnect; otherwise the old `resolveDisconnectTarget` rule.
function disconnectDecision(res, btItems) {
    if (!res || !res.matched) return { action: 'fallback' };
    const mac = res.mac ? String(res.mac).toUpperCase() : null;
    const hit = mac && (btItems || []).find((d) => d.connected && String(d.mac || '').toUpperCase() === mac);
    return hit ? { action: 'disconnect', mac: hit.mac } : { action: 'wired' };
}

// Rumbles the pressing pad (PS + Square) — the padIndex from the Gamepad API is exact, not an estimate.
function rumblePad(padIndex) {
    try {
        const pad = Array.from(navigator.getGamepads ? navigator.getGamepads() : [])
            .find((p) => p && p.index === padIndex);
        const act = pad && pad.vibrationActuator;
        if (act && typeof act.playEffect === 'function') {
            act.playEffect('dual-rumble', { duration: 350, strongMagnitude: 0.8, weakMagnitude: 0.6 }).catch(ignoreError);
        }
    } catch { /* no rumble support */ }
}

function handlePsCombo({ padIndex, padId, combo }) {
    if (combo === 'quit') {
        feedback('back');
        window.launcher.quit();
        return;
    }
    if (combo === 'disconnect') {
        feedback('back');
        resolveComboPadSafe().then((res) => {
            const btItems = typeof ctrlBtItems !== 'undefined' ? ctrlBtItems : [];
            const decision = disconnectDecision(res, btItems);
            if (decision.action === 'disconnect') {
                window.launcher.btDisconnect('controller', decision.mac);
                return;
            }
            if (decision.action === 'wired') {
                showStatus(tr('toast.controllerDisconnectWired'), true);
                return;
            }
            const target = resolveDisconnectTarget(classifyController(padId || ''), btItems);
            if (!target) {
                showStatus(tr('toast.controllerDisconnectAmbiguous'), true);
                return;
            }
            window.launcher.btDisconnect('controller', target.mac);
        });
        return;
    }
    if (combo === 'identify') {
        feedback('nav');
        rumblePad(padIndex);
        resolveComboPadSafe().then((res) => {
            const mac = res && res.matched ? res.mac : null;
            if (typeof flashControllerChip === 'function') flashControllerChip(padIndex, mac);
        });
    }
}

// gamepaddisconnected: deliberately no handler. pollGamepad() reads the list of connected pads fresh every frame, so a pad
// disconnecting does not affect the others and no controller state gets stuck. The `gamepadconnected` + `focus` listeners are wired
// by renderer/main.js (so this file stays free of top-level DOM access → `aggregatePad` can be required from Node for tests).

// All connected, "connected" pads (getGamepads() may return null holes).
function getPads() {
    return Array.from(navigator.getGamepads()).filter((p) => p && p.connected);
}

// Type of the last pad showing activity (the button labels follow it if no main controller is set — see
// renderer/controller/controller-labels.js). pad.id is classified by the shared classifyController() (controller-id.js). null = no
// active pad right now.
function detectActivePadType(pads) {
    for (const p of pads) {
        const active = (p.buttons || []).some((b) => b && b.pressed)
            || (p.axes || []).some((a) => typeof a === 'number' && Math.abs(a) > DEADZONE);
        if (active) return classifyController(p.id);
    }
    return null;
}

// Synthetic "merged" pad: buttons[i].pressed = pressed on any pad, axes[i] = the value with the biggest absolute deflection across
// the pads. Every call site (handleVolumeButtons, handleSettingsInput, main nav etc.) uses it as `gp.buttons[i]?.pressed` /
// `gp.axes[i]`, just like a single pad.
function aggregatePad(pads) {
    if (!pads.length) return null;
    const nButtons = pads.reduce((m, p) => Math.max(m, p.buttons.length), 0);
    const buttons = [];
    for (let i = 0; i < nButtons; i++) {
        let pressed = false;
        let value = 0;
        for (const p of pads) {
            const b = p.buttons[i];
            if (!b) continue;
            if (b.pressed) pressed = true;
            if (Math.abs(b.value) > Math.abs(value)) value = b.value;
        }
        buttons.push({ pressed, value });
    }
    const nAxes = pads.reduce((m, p) => Math.max(m, p.axes.length), 0);
    const axes = [];
    for (let i = 0; i < nAxes; i++) {
        let v = 0;
        for (const p of pads) {
            const a = p.axes[i];
            if (typeof a === 'number' && Math.abs(a) > Math.abs(v)) v = a;
        }
        axes.push(v);
    }
    return { buttons, axes };
}

// Open popups in PRIORITY order (topmost first) — ONE table walked by pollGamepad() so that only the TOPMOST open overlay gets the
// button press in a frame. `isOpen`/`handle` are CLOSURES: the array is built at the top of the file, while the referenced globals
// (settings.js, keyboard.js, …) load later — a direct reference would throw a ReferenceError, a closure only reads on call. The keydown
// fallback of `renderer/main.js` does NOT read this table. Background: docs/dev/renderer/overview.md#overlays-createoverlay-and-overlay_stack
const OVERLAY_STACK = [
    { isOpen: () => keyboardPanel.isOpen(), handle: (gp) => handleKeyboardInput(gp) },
    { isOpen: () => setupWizard.isOpen(), handle: (gp) => handleSetupWizardInput(gp) },
    { isOpen: () => changelogPanel.isOpen(), handle: (gp) => handleChangelogInput(gp) },
    { isOpen: () => launcherInstall.isOpen(), handle: (gp) => handleLauncherInstallInput(gp) },
    { isOpen: () => settingsPanel.isOpen(), handle: (gp) => handleSettingsInput(gp) },
    // The source filter popup and the game details view open ABOVE the Games panel.
    { isOpen: () => gamesFilter.isOpen(), handle: (gp) => handleGamesFilterInput(gp) },
    { isOpen: () => gamesDetails.isOpen(), handle: (gp) => handleGameDetailsInput(gp) },
    { isOpen: () => gamesPanel.isOpen(), handle: (gp) => handleGamesPanelInput(gp) },
    { isOpen: () => cardMenu.isOpen(), handle: (gp) => handleCardMenuInput(gp) },
    { isOpen: () => quickPower.isOpen(), handle: (gp) => handleQuickPowerInput(gp) },
];

function pollGamepad() {
    // Idle watching ALWAYS runs, regardless of the main nav/Settings/Games panel state (like the volume buttons) - see
    // renderer/home/idle.js checkIdle().
    const padsNow = getPads();
    const gpForIdle = aggregatePad(padsNow);
    if (gpForIdle) {
        noteActivity(gpForIdle);
        // The button labels follow the type of the last active pad (controller-labels.js).
        const activeType = detectActivePadType(padsNow);
        if (activeType) noteActivePadType(activeType);
    }
    checkIdle();

    // Killable (currently only melonDS) session — the launcher window is DELIBERATELY NOT hidden (the killable branch of `spawnGame` in
    // `lib/launch/launch-controller.js`), melonDS's OWN `--fullscreen` covers it visually because of KWin stacking — so this rAF loop is
    // guaranteed to run: the PS/Home button then closes the game, not the launcher.
    if (isLaunching && killWatchActive) {
        if (gpForIdle) handleKillWatchInput(gpForIdle);
        pollNext();
        return;
    }

    if (!isLaunching) {
        // PS combo: per-pad (NOT aggregated) detection, then masking of the chord buttons BEFORE the aggregate reaches the nav/panel logic —
        // see the "PS combo" section above. This branch runs from everywhere (main card view AND any open popup), except a killable (melonDS)
        // session, which already returned on the `if (isLaunching && killWatchActive)` branch above.
        const { fired: psCombosFired, heldIndices: psHeldIndices } = detectPsCombos(padsNow);
        for (const c of psCombosFired) handlePsCombo(c);
        const gp = aggregatePad(maskChordButtons(padsNow, psHeldIndices));
        if (gp) {
            // L1/R1 work in every mode (main nav or an open panel)
            handleVolumeButtons(gp);
        }
        if (gp) {
            // Open popup (keyboard/wizard/"What's new"/installer/Settings/source filter/Games panel/card menu/quick system menu) — only the
            // TOPMOST gets the button press (OVERLAY_STACK, see above).
            for (const overlay of OVERLAY_STACK) {
                if (overlay.isOpen()) {
                    overlay.handle(gp);
                    pollNext();
                    return;
                }
            }
            // Card navigation: D-pad (14 left / 15 right) OR the left stick (axis 0). REPEATS when held (edgeRepeat) — the carousel's card
            // animation is longer than a list step, hence a slower rate (CAROUSEL_REPEAT_INTERVAL_MS). The carousel wraps around when held (the
            // wrap teleport is ready for it). ▲▼ are DELIBERATELY edges: a zone switch (Continue bar ↔ card ↔ quick-launch bar); a held ▼ must not
            // fall through two zones.
            const leftX = gp.axes[0];
            const stickLeft = leftX < -AXIS_THRESHOLD;
            const stickRight = leftX > AXIS_THRESHOLD;

            // Card / quick-launch bar navigation — the concrete actions live in the nav*() helpers (shared with the keydown fallback).
            edgeRepeat(buttonStates, 'left', gp.buttons[BTN.left]?.pressed || stickLeft, navFocusPrev, { interval: CAROUSEL_REPEAT_INTERVAL_MS });
            edgeRepeat(buttonStates, 'right', gp.buttons[BTN.right]?.pressed || stickRight, navFocusNext, { interval: CAROUSEL_REPEAT_INTERVAL_MS });
            edge(buttonStates, 'down', gp.buttons[BTN.down]?.pressed, navEnterRecentBar);
            edge(buttonStates, 'up', gp.buttons[BTN.up]?.pressed, navExitRecentBar);
            handleCardCrossInput(gp);
            // A standalone PS press in the card view is DELIBERATELY a no-op (closing moved to the PS+Circle combo, see "PS combo").
            // Share/View (buttons[8]) → Settings. After a failed launch (`launchErrorAt`), for `LOG_JUMP_MS` it goes straight to the Log.
            edge(buttonStates, 'select', gp.buttons[BTN.select]?.pressed, () => {
                feedback('nav');
                if (Date.now() - launchErrorAt < LOG_JUMP_MS) { launchErrorAt = 0; openSettingsView('log'); } else openSettings();
            });
            // △ Triangle → opens the Games panel directly (otherwise only reachable from the GAMES_CARD at the end of the carousel). This branch
            // only runs if no overlay is open (the earlier `if (gp && gamesPanel.isOpen())` would have returned already), so no separate "already
            // open" guard is needed. Right after a launcher removal, for `CARD_REMOVE_UNDO_MS` △ means UNDO (renderer/home/card-menu.js) — the toast
            // says so too.
            edge(buttonStates, 'triangle', gp.buttons[BTN.triangle]?.pressed, () => {
                feedback('nav');
                if (launcherUndoPending()) undoLauncherRemoval(); else openGamesPanel();
            });
            // □ Square → the quick menu of the focused REAL launcher card, immediately (the long ✕ hold — handleCardCrossInput/CARD_MENU_HOLD_MS —
            // stays as muscle memory, but it was undiscoverable).
            edge(buttonStates, 'square', gp.buttons[BTN.square]?.pressed, () => {
                const launcherId = (typeof focusedLauncherCardId === 'function') ? focusedLauncherCardId() : null;
                if (launcherId) { feedback('nav'); openCardMenu(launcherId); }
            });
            // Start/Options/Menu (buttons[9]) → quick system menu (renderer/home/quick-power.js).
            edge(buttonStates, 'start', gp.buttons[BTN.start]?.pressed, () => {
                if (typeof openQuickPowerMenu === 'function') { feedback('nav'); openQuickPowerMenu(); }
            });

            // Long press of Circle (button 1) - `circleHoldMs` (default 5 s) - TV-mode exit
            const circleBtn = gp.buttons[BTN.circle]?.pressed;
            if (circleBtn) {
                if (!circleHoldStart) {
                    circleHoldStart = Date.now();
                }
                const elapsed = Date.now() - circleHoldStart;
                if (elapsed >= circleHoldMs) {
                    circleHoldStart = null;
                    hideExitProgress();
                    showExitLabel();
                    window.launcher.exitTvMode();
                } else {
                    updateExitProgress(elapsed / circleHoldMs);
                }
            } else {
                circleHoldStart = null;
                hideExitProgress();
            }
        }
    } else if (gpForIdle) {
        handleLaunchCancelInput(gpForIdle);
    }
    pollNext();
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        aggregatePad, detectActivePadType, shouldThrottlePoll,
        detectPsCombos, maskChordButtons, resolveDisconnectTarget, disconnectDecision,
    });
}
