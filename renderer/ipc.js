// Main -> renderer notifications (window.launcher.on*) + the initial query of the AUDIO badge. Load order: AFTER every other renderer/*.js
// (the handlers reference carousel / gamepad / settings-* globals), BEFORE main.js. Toast texts go through `tr('toast.*')`.

window.launcher.onVolumeChanged(({ volume }) => showVolumeOverlay(volume));

// A "killable" game (eligible for the PS/Home force close, currently only melonDS) started — from now on `pollGamepad()` treats PS as
// "close the game", not as quitting the launcher (renderer/gamepad.js). A fresh `killWatchButtonStates`, so an already held PS does not
// fire an immediate edge.
// The running game: main's `active-session` push (spawn → { appId, name, cover }, close → null).
// The launcher brought forward from outside (launcher icon / `launchers-launcher-show.sh` while a game runs): the launch loader must not stay
// — the "▶ BACK" item in the Continue bar takes you back into the game.
window.launcher.onLauncherRevealed(() => {
    if (!isLaunching || killWatchActive) return;
    endLaunching();
    hideLoading();
    renderContinueBar();
});

window.launcher.onActiveSession((info) => {
    activeSessionInfo = info && info.name ? info : null;
    if (!activeSessionInfo && continueFocus > 0 && continueFocus >= continueBarGames().length) continueFocus = -1;
    renderContinueBar();
});

window.launcher.onAppLaunched((data) => {
    killWatchActive = !!(data && data.killable);
    if (killWatchActive) {
        const gp = aggregatePad(getPads());
        killWatchButtonStates = {};
        if (gp) syncEdge(killWatchButtonStates, gp, ['ps']);
    }
});

// `git pull --ff-only` failed (the relaunch did not happen) — release the "update in progress" screen and show a toast. See
// renderer/settings/settings-update.js.
window.launcher.onUpdateFailed(({ message }) => {
    updateInProgress = false;
    if (settingsView === 'update') {
        updateStatus = { state: 'error', message };
        renderUpdateView();
    }
    showStatus(tr('toast.updateFailed'), true);
});

// Restoring a config backup failed (the relaunch did not happen) — see renderer/settings/settings-config-backups.js.
// The game save backup finished / failed (renderer/settings/settings-save-backup.js).
window.launcher.onSaveBackupDone((res) => onSaveBackupDone(res));
window.launcher.onSaveRestoreDone((res) => onSaveRestoreDone(res));
window.launcher.onSettingsImportFailed(() => showStatus(tr('toast.settingsImportFailed'), true));

window.launcher.onConfigRestoreFailed(() => {
    showStatus(tr('toast.configRestoreFailed'), true);
});

// A system command (power off/reboot/sleep) did not run — typically polkit refused it (on another machine where the user has no active
// local session). See settings-system.js.
window.launcher.onSystemActionFailed(() => {
    showStatus(tr('toast.systemActionFailed'), true);
});

// Self-update phase change — after the git pull, IF package.json/package-lock.json are affected too, main runs npm install automatically;
// this push signals that the "UPDATE IN PROGRESS…" screen text should change. See settings-update.js.
window.launcher.onApplyUpdateProgress(({ phase }) => {
    if (settingsView === 'update' && updateInProgress) renderUpdateProgress(phase);
});

// Sleep timer — session-only, main stores it. Initial query (e.g. the state of a timer armed before the panel opened) + the feedback of
// `set-sleep-timer`.
window.launcher.getSleepTimer().then(({ minutes, endsAt }) => {
    sleepTimerMinutes = minutes || 0;
    sleepTimerEndsAt = endsAt || null;
}).catch(ignoreError);
window.launcher.onSleepTimerChanged(({ minutes, endsAt }) => {
    sleepTimerMinutes = minutes || 0;
    sleepTimerEndsAt = endsAt || null;
    if (settingsView === 'sleep-timer') renderSleepTimerView();
    showStatus(sleepTimerMinutes > 0 ? tr('toast.sleepTimerOn', { minutes: sleepTimerMinutes }) : tr('toast.sleepTimerOff'));
});
window.launcher.onSleepTimerWarning(() => {
    showStatus(tr('toast.sleepTimerWarning'), true);
});

// Language switch (another window / a hand config edit may fire it too). The visible tr()-based surfaces are redrawn
// (applyLanguageEverywhere in settings-language.js).
window.launcher.onLanguageChanged(({ language, ok }) => {
    if (!ok) return;
    setActiveLanguage(language);
    applyLanguageEverywhere();
});

// In-app flatpak install — for the launcher-install.js overlay.
window.launcher.onFlatpakInstallProgress((data) => {
    if (typeof liInstallProgress === 'function') liInstallProgress(data);
});
window.launcher.onFlatpakInstallDone((data) => {
    if (typeof liInstallDone === 'function') liInstallDone(data);
});

window.launcher.onLaunchersChanged((next) => {
    launchers = next;
    renderCards();
    if (settingsView === 'launchers') {
        refreshLaunchersRows();
        showStatus(tr('toast.launchersUpdated'));
    } else if (typeof suppressLaunchersToast !== 'undefined' && suppressLaunchersToast) {
        suppressLaunchersToast = false; // the card quick menu already showed its own toast
    } else {
        showStatus(tr('toast.orderSaved'));
    }
});

// Refreshes the "● RUNNING" badges + the quick-launch bar (main-side poller / bringToFront / thumbnail-fetch push) - no toast (unlike the
// order save of launchers-changed). A targeted DOM refresh, not a full renderCards() (see carousel.js refreshRunningState); if the launcher
// list changed meanwhile (add/remove), a full redraw is needed.
window.launcher.onRunningChanged((next) => {
    launchers = next;
    if (cards.length !== launchers.length + 1) renderCards();
    else refreshRunningState();
    refreshContinueBar(); // refresh of the global "Continue" bar
    refreshGamesPanelRecentIfOpen(); // the same push for the games panel's summary recent bar
    refreshGamesPanelFavoritesIfOpen(); // the same push for the favorite RetroArch covers
});

// The Games panel warmup indicator (see renderer/home/warmup.js): push + query at startup.
window.launcher.onGamesWarmupState(applyWarmupState);
window.launcher.getGamesWarmupState().then(applyWarmupState).catch(ignoreError);

window.launcher.onAppClosed((summary) => {
    endLaunching();
    killWatchActive = false;
    // The launcher window may have been hidden for hours, the `pollGamepad` rAF loop was paused → `buttonStates` is stale. If a button is held
    // at the MOMENT of the return (e.g. the exiting game's own confirmation), it would look like a fresh press (`ps` → `quit()`, `cross` → card
    // launch). So it is synced to the physical state (the `syncEdge` gotcha pattern, see docs/dev/renderer/input.md).
    const gp = aggregatePad(getPads());
    if (gp) {
        syncEdge(buttonStates, gp, ['cross', 'left', 'right', 'up', 'down', 'ps', 'select', 'triangle', 'square', 'start']);
    }
    crossHoldStart = null;
    crossHoldFired = false;
    circleHoldStart = null;
    hideLoading();
    renderCards(); // refresh the quick-launch bar + "● RUNNING" badges from the fresh `launchers`
    refreshContinueBar();
    showStatus(sessionSummaryText(summary, launchSessionName));
    const reminder = playtimeReminderText(summary, playtimeReminderHours);
    if (reminder) showStatus(reminder, false, { ms: 6000 });
});

// The session summary on return — the decision is in `sessionSummary()` of renderer/overlays.js (tested), only the text here.
function sessionSummaryText(summary, name) {
    const s = sessionSummary(summary, name);
    if (!s) return tr('toast.backToLauncher');
    return tr(s.key, { name: s.name, session: formatDuration(s.sessionMs), total: formatDuration(s.totalMs) });
}

window.launcher.onAppError(({ appId, error, errorKey, params }) => {
    endLaunching();
    killWatchActive = false;
    // The same "launcher return" gotcha as in `onAppClosed` (see the detailed explanation there): the spawn-watchdog/`child.on('error')` branch
    // also goes through `scheduleBringToFront()`, so the window may already have been hidden (the `pollGamepad` rAF loop paused) by the time
    // this event arrives — sync `buttonStates` to the current physical button state before doing anything else with it.
    const gp = aggregatePad(getPads());
    if (gp) {
        syncEdge(buttonStates, gp, ['cross', 'left', 'right', 'up', 'down', 'ps', 'select', 'triangle', 'square', 'start']);
    }
    crossHoldStart = null;
    crossHoldFired = false;
    circleHoldStart = null;
    hideLoading();
    // main sends a key (errorKey + params) + HU prose (error) as a fallback. The toast says that Select now opens the Log directly
    // (renderer/gamepad.js).
    const msg = errorKey ? tr(errorKey, params || {}) : error;
    launchErrorAt = Date.now();
    showStatus(tr('toast.errorLog', { msg, view: btnGlyph('view') }), true);
});

window.launcher.onAudioSinkChanged(({ success, description, name }) => {
    if (success) {
        $('audioCurrentName').textContent = description || name;
        showStatus(tr('toast.audio', { name: description || name }));
    } else {
        showStatus(tr('toast.audioFailed'), true);
    }
});

window.launcher.onMonitorConfigChanged(({ success, label, name, confirmMs }) => {
    endMonitorSwitching(); // clears the "SWITCHING…" marker, selectable again (renderer/settings/settings-startup.js)
    if (success) {
        if (settingsView === 'startup-output') startupConfig.monitor = name;
        // The chosen monitor was not active → "Keep?" countdown; the toast only comes on confirmation.
        if (confirmMs) startMonitorConfirm(label || name, confirmMs);
        else showStatus(tr('toast.startupMonitor', { name: label || name }));
        if (settingsView === 'startup-output') renderStartupOutput();
    } else {
        showStatus(tr('toast.startupMonitorFailed'), true);
        if (settingsView === 'startup-output') renderStartupOutput();
    }
});

// The "Keep?" countdown expired / was declined with ○ — main has already reverted.
window.launcher.onMonitorConfigReverted(({ name, error, kept }) => {
    endMonitorConfirm();
    endMonitorSwitching();
    if (settingsView === 'startup-output') {
        startupConfig.monitor = name || null;
        renderStartupOutput();
    }
    // `kept`: the previous output (e.g. the TV turned off meanwhile) was not available — the visible one stays.
    if (kept) showStatus(tr('toast.monitorRevertKept', { name: name || '' }), true);
    else showStatus(tr(error ? 'toast.monitorRevertFailed' : 'toast.monitorReverted'), !!error);
});

window.launcher.onBtDeviceChanged(({ kind, success, action, mac, name, devices }) => {
    const st = btState[kind];
    st.busyMac = null;
    if (devices) {
        st.list = devices;
        sortBtList(st.list);
    }
    if (settingsView === viewFor(kind)) {
        const idx = st.list.findIndex((d) => d.mac === mac);
        st.focusIndex = idx !== -1 ? idx : Math.min(st.focusIndex, Math.max(0, st.list.length - 1));
        renderBtDeviceList(kind);
    }
    if (kind === 'controller') {
        // the fresh controller list for the home-screen badge too (type + battery)
        ctrlBtItems = st.list;
        renderControllerStatus();
    }
    const okKey = { connect: 'toast.btConnected', disconnect: 'toast.btDisconnected', pair: 'toast.btPaired' }[action] || 'toast.btConnected';
    const failKey = { connect: 'toast.btConnectFailed', disconnect: 'toast.btDisconnectFailed', pair: 'toast.btPairFailed' }[action] || 'toast.btConnectFailed';
    showStatus(tr('toast.bt', { name: name || mac, status: tr(success ? okKey : failKey) }), !success);
    if (action === 'pair' && success && settingsView === viewFor(kind)) {
        // after a successful pairing the item of the found list is already among the paired ones
        st.found = (st.found || []).filter((f) => f.mac !== mac);
        renderBtDeviceList(kind);
    }
});

window.launcher.onBtScanResult(({ kind, ok, found }) => {
    const st = btState[kind];
    st.scanning = false;
    st.found = ok ? (found || []) : [];
    if (settingsView === viewFor(kind)) {
        if (!ok) showStatus(tr('toast.btScanFailed'), true);
        else if (!st.found.length) showStatus(tr('toast.btScanEmpty'));
        renderBtDeviceList(kind);
    }
});

window.launcher.onThemeChanged(({ theme, success }) => {
    if (success) {
        showStatus(tr('toast.theme', { name: theme.toUpperCase() }));
    } else {
        applyTheme(theme); // back to the theme actually saved
        if (settingsView === 'theme') renderThemeList();
        showStatus(tr('toast.themeFailed'), true);
    }
});

window.launcher.onFeedbackChanged((payload) => {
    feedbackState = normalizeFeedback(payload);
    applyMotionPref();
    applyContrastPref();
    applyRepeatPref();
    applyScreenReaderPref();
    const success = payload && payload.success;
    if (settingsView === 'feedback') renderFeedbackView();
    if (settingsView === 'accessibility') renderAccessibilityView();
    if (success) {
        // The 6 switches of the `feedback` key live in 2 subviews ("Sound and rumble" + "Accessibility"), the push does not say which one
        // changed — a generic "saved" toast.
        showStatus(tr('toast.feedback'));
    } else {
        showStatus(tr('toast.feedbackFailed'), true);
    }
});

window.launcher.onRecentGamesUiChanged((payload) => {
    recentGamesUiState = normalizeRecentGamesUi(payload);
    const success = payload && payload.success;
    if (settingsView === 'recent-games') renderRecentGamesUiView();
    renderContinueBar();
    renderRecentBar();
    if (gamesPanel.isOpen()) renderGamesPanel();
    if (!success) showStatus(tr('toast.recentGamesUiFailed'), true);
});

window.launcher.onMainControllerChanged(({ ok, mainController }) => {
    // The button labels follow the type of the main controller (renderer/controller/controller-labels.js).
    setMainControllerType(mainController && mainController.type);
    if (settingsView === 'main-controller') {
        mainControllerCurrentMac = mainController && mainController.mac
            ? mainController.mac.toUpperCase() : null;
        renderMainControllerView();
    }
    if (ok) {
        const name = mainController ? (mainController.name || mainController.mac) : tr('toast.mainControllerAny');
        showStatus(tr('toast.mainController', { name }));
    } else {
        showStatus(tr('toast.mainControllerFailed'), true);
    }
});

// Push feedback of the `createToggleSubview`-based on/off subviews (controller-autostart/always-on-top/start-with-system/cover-download).
// `createToggleSubview` exports a `setCurrent(v)` (through `SETTINGS_VIEWS[viewId]`) that aligns the view with the value CONFIRMED by main
// (on a failed write the optimistic UI reverts) — do NOT write a per-view `renderXView()`/`XCurrent` global (there is none; calling it would
// cause an uncaught ReferenceError, i.e. #fatalOverlay).
function onToggleChanged(eventFn, {
    viewId, onKey, offKey, failKey, isOn,
}) {
    eventFn(({ ok, enabled }) => {
        const on = isOn(enabled);
        const view = SETTINGS_VIEWS[viewId];
        if (view && view.setCurrent) view.setCurrent(on);
        showStatus(ok ? tr(on ? onKey : offKey) : tr(failKey), !ok);
    });
}

onToggleChanged(window.launcher.onControllerAutostartChanged, {
    viewId: 'controller-autostart',
    onKey: 'toast.controllerAutostartOn', offKey: 'toast.controllerAutostartOff', failKey: 'toast.controllerAutostartFailed',
    isOn: (enabled) => enabled !== false,
});
onToggleChanged(window.launcher.onAlwaysOnTopChanged, {
    viewId: 'always-on-top',
    onKey: 'toast.alwaysOnTopOn', offKey: 'toast.alwaysOnTopOff', failKey: 'toast.alwaysOnTopFailed',
    isOn: (enabled) => enabled !== false,
});
onToggleChanged(window.launcher.onStartWithSystemChanged, {
    viewId: 'start-with-system',
    onKey: 'toast.startWithSystemOn', offKey: 'toast.startWithSystemOff', failKey: 'toast.startWithSystemFailed',
    isOn: (enabled) => enabled === true,
});
onToggleChanged(window.launcher.onCoverDownloadChanged, {
    viewId: 'cover-download',
    onKey: 'toast.coverDownloadOn', offKey: 'toast.coverDownloadOff', failKey: 'toast.coverDownloadFailed',
    isOn: (enabled) => enabled !== false,
});
onToggleChanged(window.launcher.onDoNotDisturbChanged, {
    viewId: 'do-not-disturb',
    onKey: 'toast.doNotDisturbOn', offKey: 'toast.doNotDisturbOff', failKey: 'toast.doNotDisturbFailed',
    isOn: (enabled) => enabled !== false,
});

// Numeric pickers (`createPrefSelectSubview`): loaded at startup (so the renderer-side effect — screensaver / L1/R1 step / ○ hold — uses the
// saved value from the first minute) + the `*-changed` push → the confirmed value + toast ("<MENU ITEM>: <VALUE>").
function onPrefSelectChanged(eventFn, viewId) {
    const view = SETTINGS_VIEWS[viewId];
    view.load().catch(ignoreError);
    eventFn(({ ok, value }) => {
        view.setCurrent(value);
        showStatus(ok
            ? tr('toast.prefValue', { name: tr('menu.' + viewId), value: tr(view.labelKeyFor(value)) }).toUpperCase()
            : tr('toast.prefFailed'), !ok);
    });
}
onPrefSelectChanged(window.launcher.onIdleTimeoutChanged, 'idle-timeout');
onPrefSelectChanged(window.launcher.onVolumeStepChanged, 'volume-step');
onPrefSelectChanged(window.launcher.onVolumeMaxChanged, 'volume-max');
onPrefSelectChanged(window.launcher.onTvExitHoldChanged, 'tv-exit-hold');
onPrefSelectChanged(window.launcher.onScreenDimChanged, 'screen-dim');
onPrefSelectChanged(window.launcher.onNightModeChanged, 'night-mode');
onPrefSelectChanged(window.launcher.onAutoSuspendChanged, 'auto-suspend');
onPrefSelectChanged(window.launcher.onPlaytimeReminderChanged, 'playtime-reminder');
onPrefSelectChanged(window.launcher.onIdleDisconnectChanged, 'idle-disconnect');

// Initial load of the `feedback` config key (`feedbackState` of renderer/feedback.js).
window.launcher.getFeedback().then((f) => {
    if (f) feedbackState = normalizeFeedback(f);
    applyMotionPref();
    applyContrastPref();
    applyRepeatPref();
    applyScreenReaderPref();
}).catch(ignoreError);

// Initial load of the `recentGamesUi` config key — toggles of the 3 "recently played" bars. The first call of
// `renderContinueBar()`/`renderRecentBar()` runs AFTER the carousel init (renderer/main.js initLaunchers()), so updating the state is enough
// here — it will be fresh at render time.
window.launcher.getRecentGamesUi().then((v) => {
    if (v) recentGamesUiState = normalizeRecentGamesUi(v);
}).catch(ignoreError);

// Background image (`background`): per-theme map — the renderer always paints the ACTIVE theme's background (settings-theme.js applyTheme
// calls it too). The map is seeded immediately from the preload's synchronous `initialBackground` (no gap between body parse and the
// get-background resolution — the image painted by the <head> boot script stays continuous).
try {
    if (window.launcher.initialBackground) bgSetMap(window.launcher.initialBackground);
    applyBackgroundForTheme(window.launcher.initialTheme || (typeof currentTheme !== 'undefined' && currentTheme) || 'neon');
} catch (e) { /* without boot data the async path below takes over */ }
window.launcher.getBackground().then((map) => {
    bgSetMap(map);
    applyBackgroundForTheme((typeof currentTheme !== 'undefined' && currentTheme) || 'neon');
}).catch(ignoreError);
window.launcher.onBackgroundChanged(({ map, ok }) => {
    if (map) bgSetMap(map);
    applyBackgroundForTheme((typeof currentTheme !== 'undefined' && currentTheme) || 'neon');
    if (settingsView === 'background') renderBackgroundView();
    showStatus(ok ? tr('toast.background') : tr('toast.backgroundFailed'), !ok);
});

// UI scale (`uiScale`): initial load + `ui-scale-changed` push.
window.launcher.getUiScale().then((id) => applyUiScale(id)).catch(ignoreError);
window.launcher.onUiScaleChanged(({ uiScale, ok }) => {
    applyUiScale(uiScale);
    if (settingsView === 'ui-scale') renderUiScaleView();
    const labelKey = { small: 'sv.uiScaleSmall', normal: 'sv.uiScaleNormal', large: 'sv.uiScaleLarge' }[uiScale] || 'sv.uiScaleNormal';
    showStatus(ok ? tr('toast.uiScale', { size: tr(labelKey) }) : tr('toast.uiScaleFailed'), !ok);
});

// "Monitors and TV (CEC)": the toggle writes immediately, this is the feedback.
window.launcher.onOutputBehaviorChanged((payload) => {
    if (settingsView === 'output-behavior' && payload && payload.ok) {
        obConfig = {
            keepOtherMonitors: !!payload.keepOtherMonitors,
            standbyOnExit: !!payload.standbyOnExit,
            cecPowerOn: payload.cecPowerOn !== false,
        };
        renderOutputBehaviorView();
    }
    showStatus(payload && payload.ok ? tr('toast.outputBehavior') : tr('toast.outputBehaviorFailed'), !(payload && payload.ok));
});

// "TV mode: close": the checkbox writes immediately, this is the feedback.
window.launcher.onTvModeChanged((payload) => {
    showStatus(payload && payload.ok ? tr('toast.tvMode') : tr('toast.tvModeFailed'), !(payload && payload.ok));
});

// "melonDS ROM folders" — add/remove already rendered locally (optimistically), this only signals the save's success/failure.
window.launcher.onMelondsRomDirsChanged((payload) => {
    if (!payload || payload.ok) return;
    showStatus(tr('toast.melondsRomDirsFailed'), true);
});

window.launcher.listAudioSinks().then((res) => {
    const current = (res.items || []).find((s) => s.isDefault);
    if (current) {
        $('audioCurrentName').textContent = current.description;
    }
}).catch(ignoreError);
