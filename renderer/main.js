// Renderer entry point: starts the initial queries + DOM event wiring + starts the gamepad poll loop + the keyboard fallback.
// Load order: AFTER every other renderer/*.js (every function/global is defined by now).

// The active language (`language` config key). It must be known BEFORE the first card render: the card labels ("Games", the press
// hint, the badges) go through tr(), and a card drawn before the language arrived would stay in the default language until a switch.
const languageReady = window.launcher.getLanguage().then((lang) => setActiveLanguage(lang)).catch(ignoreError);

// Launcher list from the main process (IPC) — from the customLaunchers config key, ordered.
async function initLaunchers() {
    launchers = await window.launcher.getLaunchers();
    await languageReady;
    renderCards();
    // "Continue": the initial focus is on the most recently launched launcher. renderCards() sets the focus by id/default/0 — on the
    // first render (no prevId) we override that with the helper.
    focusedIndex = mostRecentLauncherIndex(launchers);
    layoutCarousel();
    renderRecentBar(); // after overriding the initial focus, the quick-launch bar belongs to the right launcher too
    // Startup timeline (lib/startup-timeline.js): cards drawn — reported on the NEXT frame, so the browser has actually painted them.
    requestAnimationFrame(() => window.launcher.reportStartupMark('launchersRendered'));
    refreshContinueBar(); // global "Continue" bar
}
// An explicit `.catch()` — an IPC error here would take the whole card list, so the fatal overlay (reload/quit) is appropriate, but
// the context label should be 'initLaunchers', not the implicit global 'unhandledrejection' (every fire-and-forget Promise needs a
// `.catch()` so the generic unhandledrejection handler does not catch it).
initLaunchers().catch((err) => reportClientError('initLaunchers', err));
// The launchers with a custom ROM source — for the card menu's "Open games" row.
refreshCustomGameSourceIds().catch(ignoreError);

// Launcher icon loader (util.js launcherLoaderHtml): a broken icon file → FALLBACK_ICON. The `error` event does not bubble but can be
// caught in the capture phase, so a component built with innerHTML needs no later hooking (and no inline `onerror`). The
// `data-fallback` marker guards against a loop if FALLBACK_ICON itself failed.
document.addEventListener('error', (e) => {
    const el = /** @type {HTMLImageElement} */ (e.target);
    if (el && el.tagName === 'IMG' && el.classList.contains('loader-icon') && !el.dataset.fallback) {
        el.dataset.fallback = '1';
        el.src = FALLBACK_ICON;
    }
}, true);

// The bottom hint bar depends on two queries: the active language (`language` config) and the TV control capabilities (`tvCaps` —
// it does not affect the main-menu bar TODAY, but the CEC switch of the output-behavior settings needs it). One render once BOTH
// have arrived (no flicker on the bar).
Promise.allSettled([
    languageReady,
    window.launcher.getTvCapabilities().then((caps) => { tvCaps = caps || { cec: false, ddc: false }; }),
]).then(() => { applyStaticLabels(); renderBottomBar(); });

// The static (not list-rendered) text nodes of index.html — the HU markup is the no-JS fallback, overwritten here with `tr()`. Also
// runs on a language switch (applyLanguageEverywhere).
function applyStaticLabels() {
    const set = (id, key) => { const el = $(id); if (el) el.textContent = tr(key); };
    set('exitProgressLabel', 'static.exitHold');
    set('exitLabel', 'static.shutdown');
    set('volumeLabel', 'bar.volume');
    set('gamesPanelTitle', 'games.card');
    const sbtn = $('settingsIconBtn');
    if (sbtn) sbtn.title = tr('bar.settings');
    // Safe mode (lib/safe-mode.js): the reason from the boot state ('crashes' | 'renderer' | 'env' | null).
    const safe = window.launcher.initialSafeMode;
    const banner = $('safeModeBanner');
    if (banner) {
        banner.hidden = !safe;
        if (safe) {
            const key = { env: 'static.safeModeForced', renderer: 'static.safeModeRenderer' }[safe] || 'static.safeMode';
            banner.textContent = tr(key);
        }
    }
}

// The bottom hint bar from the `tr('bar.*')` strings (index.html has a static HU fallback).
function renderBottomBar() {
    const bar = $('bottomBar');
    if (!bar) return;
    // The button glyphs follow the active controller type (renderer/controller/controller-labels.js); the setControllerTypeChangeHandler
    // hook (below) calls this function again on a pad switch.
    const s = controllerHintSymbols();
    const hints = [
        ['btn-icon btn-x', s.confirm, tr('bar.launch')],
        ['btn-icon btn-square', s.alt, tr('bar.cardMenu')],
        [null, '◀ ▶', tr('bar.nav')],
        ['btn-icon btn-triangle', s.menu, tr('games.card')],
        ['btn-icon btn-view', s.view, tr('bar.settings')],
        [null, 'L1/R1', tr('bar.volume')],
        ['btn-icon btn-start', s.start, tr('bar.power')],
        ['btn-icon btn-ps', s.home, tr('bar.quit')],
    ];
    bar.innerHTML = hints.map(([cls, sym, label]) => {
        const icon = cls
            ? `<span class="${cls}">${sym}</span>`
            : `<span style="color:var(--dim)">${sym}</span>`;
        return `<div class="hint">${icon} ${esc(label)}</div>`;
    }).join('');
}

// First start: if the setup wizard has not run yet, bring it up (renderer/setup-wizard.js).
window.launcher.getSetupState()
    .then((s) => {
        if (!s || !s.done) { openSetupWizard(false); return; }
        maybeShowChangelog(); // "What's new" panel after a self-update
    })
    .catch(ignoreError);

// Theme init: renderer/boot/boot-theme.js ALREADY set the active theme's data-theme + <link> from the preload's synchronous
// `initialTheme` (flicker-free start). Here we only load the manifest (THEMES) for the theme subview + call applyTheme again for the
// motion/contrast/background side effects (idempotent).
currentTheme = window.launcher.initialTheme || currentTheme;
Promise.all([window.launcher.listThemes(), window.launcher.getTheme()])
    .then(([manifest, theme]) => {
        if (Array.isArray(manifest) && manifest.length) {
            THEMES = manifest;
            injectThemeLinks(manifest);
        }
        applyTheme(theme);
        if (settingsView === 'theme') renderThemeList();
    })
    .catch(() => {
        applyTheme(window.launcher.initialTheme || currentTheme);
        window.launcher.getTheme().then(applyTheme).catch(ignoreError);
    });

// Header clock: immediately + every minute (follows the minute rollover within ~10 s).
tickClock();
setInterval(tickClock, 10000);

// Home-screen controller badge: immediate render + BT poll, then a battery refresh every 30 s (only with a visible window).
// renderer/controller/controller-status.js.
startControllerStatus();

// First-use tips (renderer/home/tips.js): after loading the seen list, the home-screen tip with a small delay, if nothing opened
// meanwhile (panel / launch).
loadSeenTips().then(() => setTimeout(() => {
    if (!isLaunching && !OVERLAY_STACK.some((o) => o.isOpen())) showTipOnce('home');
}, 4000)).catch(ignoreError);

// A game already running meanwhile (the renderer reloaded / the launcher came back): the Continue bar's "BACK" item.
window.launcher.getActiveSession()
    .then((info) => { activeSessionInfo = info && info.name ? info : null; renderContinueBar(); })
    .catch(ignoreError);

// Button labels matching the controller type (renderer/controller/controller-labels.js): the configured type of the main controller
// wins; otherwise the type of the last active pad; fallback 'playstation'. On a type change the bottom bar + the cards are redrawn
// (the settings/games hints refresh in their own render anyway).
window.launcher.getMainController()
    .then((c) => setMainControllerType(c && c.type))
    .catch(ignoreError);
setControllerTypeChangeHandler(() => {
    renderBottomBar();
    if (cards.length) renderCards();
    if (typeof gamesPanel.isOpen() !== 'undefined' && gamesPanel.isOpen()) renderGamesPanelHint();
});

$('settingsIconBtn').addEventListener('click', openSettings);

window.addEventListener('gamepadconnected', () => {
    showStatus(tr('toast.controllerConnected'));
    pollControllerStatus();
});

// For the badge: a pad disconnecting ONLY refreshes #controllerStatus - it does not affect pollGamepad's merge-all logic (which
// deliberately has no disconnect branch).
window.addEventListener('gamepaddisconnected', () => {
    renderControllerStatus();
    pollControllerStatus();
});

// When returning from a launcher, Chromium sometimes holds back the pads until a button press; a getGamepads() call on focus regain
// may "nudge" the state refresh.
window.addEventListener('focus', () => { navigator.getGamepads(); pollControllerStatus(); });

// The screensaver only counts with a focused window; the paused rAF loop of a hidden window would not notice a focus loss (see
// renderer/home/idle.js onLauncherBlur()).
window.addEventListener('blur', onLauncherBlur);

// A resolution change (e.g. the TV-mode startup/desktop profile switches monitors) immediately recomputes the size/offset of the
// carousel cards - no navigation is needed for layoutCarousel() to rerun.
window.addEventListener('resize', () => { if (cards.length) layoutCarousel(); });

// The actual height of the fixed bottom bar -> the --bottom-bar-h CSS var used by the .container padding-bottom, so the content above it
// (e.g. the quick-launch bar) never hangs under/behind the bar. The height may change at runtime (language switch / controller type
// switch / hint wrapping / uiScale) - followed with a ResizeObserver, not a hand-duplicated CSS clamp formula (like the carousel's
// measureCardWidth()).
(() => {
    const bar = $('bottomBar');
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const sync = () => document.documentElement.style.setProperty('--bottom-bar-h', `${bar.offsetHeight}px`);
    new ResizeObserver(sync).observe(bar);
    sync();
})();

// Start the gamepad poll loop (pollGamepad is defined in renderer/gamepad.js).
requestAnimationFrame(pollGamepad);

// Keyboard nav for the Settings subviews. The existing handleSettingsInput() gets a synthetic pad "nudge": a pressed frame + (setTimeout
// 0) a released frame, so the navList/edge logic runs exactly as with a controller (the release resets the edge state for the next press
// — without a controller pollGamepad does not call the handler that would do it).
function synthPadFrame(btnIndex, pressed) {
    return {
        buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed && i === btnIndex, value: 0 })),
        axes: [0, 0, 0, 0],
    };
}

function settingsKey(btnIndex) {
    handleSettingsInput(synthPadFrame(btnIndex, true));
    setTimeout(() => handleSettingsInput(synthPadFrame(btnIndex, false)), 0);
}

function cardMenuKey(btnIndex) {
    handleCardMenuInput(synthPadFrame(btnIndex, true));
    setTimeout(() => handleCardMenuInput(synthPadFrame(btnIndex, false)), 0);
}

// Keyboard fallback (debug / test) — the nav*() helpers are shared with the gamepad main nav.
document.addEventListener('keydown', (e) => {
    // On-screen keyboard open (renderer/keyboard.js) — direct typing fallback.
    if (keyboardPanel.isOpen()) {
        // Ctrl+V / Shift+Insert = paste; other Ctrl/Meta combinations do NOT type a letter (AltGr may arrive as ctrl+alt on Linux — that is
        // a character, not a command).
        const cmd = (e.ctrlKey && !e.altKey) || e.metaKey;
        if ((cmd && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert')) { e.preventDefault(); kbKey('paste'); }
        else if (cmd) { /* another command combination: no effect */ }
        else if (e.key === 'Enter') kbKey('confirm');
        else if (e.key === 'Escape') kbKey('cancel');
        else if (e.key === 'Backspace') kbKey('backspace');
        else if (e.key === 'ArrowUp') kbKey({ dir: 'up' });
        else if (e.key === 'ArrowDown') kbKey({ dir: 'down' });
        else if (e.key === 'ArrowLeft') kbKey({ dir: 'left' });
        else if (e.key === 'ArrowRight') kbKey({ dir: 'right' });
        else if (e.key.length === 1) kbKey(e.key);
        return;
    }
    // The setup wizard is open: the main nav is blocked, only the wizard steps (Esc = back).
    if (setupWizard.isOpen()) {
        if (e.key === 'ArrowDown') wizKey(1);
        if (e.key === 'ArrowUp') wizKey(-1);
        if (e.key === 'Enter' || e.key === ' ') wizKey('select');
        if (e.key === 'Escape') wizKey('back');
        return;
    }
    // The Settings panel is open: the main nav is blocked — the keys go to the existing handleSettingsInput() as a synthetic pad nudge
    // (settingsKey, below). For testing without a controller / emergency navigation next to a stuck controller.
    if (settingsPanel.isOpen()) {
        if (e.key === 'ArrowUp') settingsKey(BTN.up);
        else if (e.key === 'ArrowDown') settingsKey(BTN.down);
        else if (e.key === 'ArrowLeft') settingsKey(BTN.left);
        else if (e.key === 'ArrowRight') settingsKey(BTN.right);
        else if (e.key === 'Enter' || e.key === ' ') settingsKey(BTN.cross);
        else if (e.key === 'Escape') settingsKey(BTN.circle);
        return;
    }
    // "What's new" panel open: Enter/Space/Esc closes it.
    if (changelogPanel.isOpen()) {
        if (['Enter', ' ', 'Escape'].includes(e.key)) closeChangelog();
        return;
    }
    // Flatpak installer overlay open.
    if (launcherInstall.isOpen()) {
        const k = { ArrowUp: BTN.up, ArrowDown: BTN.down, Enter: BTN.cross, ' ': BTN.cross, Escape: BTN.circle }[e.key];
        if (k !== undefined) {
            handleLauncherInstallInput(synthPadFrame(k, true));
            setTimeout(() => handleLauncherInstallInput(synthPadFrame(k, false)), 0);
        }
        return;
    }
    // Card quick menu open: the main nav is blocked, only the menu steps.
    if (cardMenu.isOpen()) {
        if (e.key === 'ArrowUp') cardMenuKey(BTN.up);
        else if (e.key === 'ArrowDown') cardMenuKey(BTN.down);
        else if (e.key === 'Enter' || e.key === ' ') cardMenuKey(BTN.cross);
        else if (e.key === 'Escape') cardMenuKey(BTN.circle);
        return;
    }
    // Games panel open: typing on a physical keyboard goes into the live search (Backspace deletes, Esc clears the search). If it was not
    // handled (empty search / panel closed), the old fallback continues.
    if (typeof gamesPanel.isOpen() !== 'undefined' && gamesPanel.isOpen()) {
        let handled = false;
        if (e.key === 'Escape') handled = gamesSearchKey('clear');
        else if (e.key === 'Backspace') handled = gamesSearchKey('backspace');
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) handled = gamesSearchKey(e.key);
        if (handled) {
            e.preventDefault();
            return;
        }
    }
    if (e.key === 'ArrowLeft') navFocusPrev();
    if (e.key === 'ArrowRight') navFocusNext();
    if (e.key === 'ArrowDown') navEnterRecentBar();
    if (e.key === 'ArrowUp') navExitRecentBar();
    if (e.key === 'Enter' || e.key === ' ') navActivate();
    if (e.key === 'Escape') window.launcher.quit();
    // 't' - cycle through the themes (for testing without a controller)
    if (e.key === 't') {
        const i = THEMES.findIndex((x) => x.id === currentTheme);
        const next = THEMES[(i + 1) % THEMES.length];
        applyTheme(next.id);
        window.launcher.setTheme(next.id);
        if (settingsView === 'theme') renderThemeList();
    }
});
