// @ts-check
'use strict';

const { requireDeps } = require('./require-deps.js');

// IPC of the preference keys: theme, feedback, "recently played" bars, background + the trivial get/set pairs via the
// `registerPrefChannel` factory. Channel names stay LITERAL strings at the call sites (the ipc-channels test extracts them
// at source level — which is why this comment has no example call either). A new simple switch = 1 `registerPrefChannel(...)`.

/**
 * @param {Object} deps
 * @param {{ on: (channel: string, fn: (event: any, payload?: any) => void) => any, handle: (channel: string, fn: (event: any, payload?: any) => any) => void }} deps.ipcMain
 * @param {typeof import('../prefs.js')} deps.prefs
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {(msg: string) => void} deps.log
 * @param {{ writeSidecar: (mac: any) => void }} deps.mainController
 * @param {{ writeSidecar: (enabled: boolean) => void }} deps.autostart
 * @param {{ writeAutostartEntry: (repoRoot: string) => void, removeAutostartEntry: () => void }} deps.xdgAutostart
 * @param {string} deps.repoRoot for the `Exec=` of the XDG autostart entry (main.js `__dirname`)
 * @param {() => void} deps.stopDoNotDisturb
 * @param {() => string[]} deps.getLauncherIcons icon paths of the added launchers (for the boot skeleton)
 * @param {string|null} deps.safeModeReason reason of the safe mode (`null` = normal start)
 */
function registerPrefsIpc(deps) {
    const {
        ipcMain, prefs, sendToRenderer, log, mainController, autostart, xdgAutostart, repoRoot, stopDoNotDisturb,
        getLauncherIcons, safeModeReason,
    } = deps;
    requireDeps(deps, ['ipcMain', 'prefs', 'sendToRenderer', 'log', 'mainController', 'autostart', 'xdgAutostart', 'repoRoot', 'stopDoNotDisturb', 'getLauncherIcons', 'safeModeReason'], 'registerPrefsIpc');
    // Uniform "read / write a simple prefs key, notify back" IPC pair factory. The payload key (`enabled`/`uiScale`/
    // `mainController`/…) comes from `valueKey`; the optional `sideEffect` runs AFTER a successful `set()` (e.g. a sidecar
    // write); `label` is the error-log text. The 3 channel names stay LITERAL at the call site (the ipc-channels test extracts
    // them with a separate regex). What does not fit (multi-field `patch`, extra handler) gets its own handler pair.
    /**
     * @param {string} getChan
     * @param {string} setChan
     * @param {string} changedEvent
     * @param {{ get: () => any, set: (v: any) => any, sideEffect?: (next: any) => void, label?: string }} spec
     * @param {string} [valueKey]
     */
    function registerPrefChannel(getChan, setChan, changedEvent, { get, set, sideEffect, label }, valueKey = 'enabled') {
        ipcMain.handle(getChan, () => get());
        ipcMain.on(setChan, (event, payload) => {
            try {
                const next = set(payload);
                if (sideEffect) sideEffect(next);
                sendToRenderer(changedEvent, { ok: true, [valueKey]: next });
            } catch (err) {
                log(`${label || changedEvent} save error: ${err.message}`);
                sendToRenderer(changedEvent, { ok: false, [valueKey]: get() });
            }
        });
    }

    // Synchronous boot state: renderer/boot/boot-theme.js sets the theme + background with it BEFORE the first paint (no
    // theme flash); `launcherIcons` are the icons of the startup skeleton. The handler is registered at module load, well
    // before the window / preload exist.
    ipcMain.on('get-boot-state', (event) => {
        try {
            event.returnValue = {
                theme: prefs.getTheme().theme,
                background: prefs.getBackgroundMap(),
                launcherIcons: getLauncherIcons(),
                safeMode: safeModeReason,
            };
        } catch (err) {
            log(`get-boot-state error: ${err.message}`);
            event.returnValue = { theme: 'neon', background: {}, launcherIcons: [], safeMode: safeModeReason };
        }
    });

    ipcMain.handle('get-theme', () => prefs.getTheme().theme);

    ipcMain.handle('list-themes', () => prefs.themeManifest);

    ipcMain.on('set-theme', (event, theme) => {
        try {
            const { theme: applied } = prefs.setTheme(theme);
            sendToRenderer('theme-changed', { theme: applied, success: true });
        } catch (err) {
            log(`Theme save error: ${err.message}`);
            sendToRenderer('theme-changed', { theme: prefs.getTheme().theme, success: false });
        }
    });

    ipcMain.handle('get-feedback', () => prefs.getFeedback());

    ipcMain.on('set-feedback', (event, partial) => {
        try {
            const next = prefs.setFeedback(partial || {});
            sendToRenderer('feedback-changed', { ...next, success: true });
        } catch (err) {
            log(`Feedback save error: ${err.message}`);
            sendToRenderer('feedback-changed', { ...prefs.getFeedback(), success: false });
        }
    });

    ipcMain.handle('get-recent-games-ui', () => prefs.getRecentGamesUi());

    ipcMain.on('set-recent-games-ui', (event, partial) => {
        try {
            const next = prefs.setRecentGamesUi(partial || {});
            sendToRenderer('recent-games-ui-changed', { ...next, success: true });
        } catch (err) {
            log(`Recently played bars save error: ${err.message}`);
            sendToRenderer('recent-games-ui-changed', { ...prefs.getRecentGamesUi(), success: false });
        }
    });

    // Background image (`background` config key) — PER-THEME map. Main ONLY stores it, the effect is renderer-side
    // (`applyBackground` sets the `#bgCustom` layer, on theme switch too). Built-in backgrounds come from the
    // data/backgrounds.json manifest, custom images from the ~/Pictures/launchers-launcher/ folder.
    ipcMain.handle('get-background', () => prefs.getBackgroundMap());

    ipcMain.handle('list-backgrounds', () => {
        try {
            return { ok: true, builtin: prefs.listBuiltinBackgrounds(), custom: prefs.listCustomBackgrounds() };
        } catch (err) {
            log(`list-backgrounds error: ${err.message}`);
            return { ok: false, builtin: [], custom: [] };
        }
    });

    ipcMain.on('set-background', (event, payload) => {
        const theme = payload && payload.theme;
        try {
            const next = prefs.setBackground(theme, payload && payload.cfg);
            sendToRenderer('background-changed', { theme, background: next, map: prefs.getBackgroundMap(), ok: true });
        } catch (err) {
            log(`Background save error: ${err.message}`);
            sendToRenderer('background-changed', { theme, map: prefs.getBackgroundMap(), ok: false });
        }
    });

    // --- Trivial prefs keys (via the registerPrefChannel factory) ---
    // UI language — main ONLY stores it, the effect is renderer-side.
    registerPrefChannel('get-language', 'set-language', 'language-changed', {
        get: prefs.getLanguage,
        set: prefs.setLanguage,
        label: 'Nyelv',
    }, 'language');

    // UI scale (`uiScale` config key) — main ONLY stores it, the effect is renderer-side
    // (`<html data-ui-scale>` + the `--ui-scale` multiplier of `styles/*.css`). Settings → Appearance → UI size.
    registerPrefChannel('get-ui-scale', 'set-ui-scale', 'ui-scale-changed', {
        get: prefs.getUiScale,
        set: prefs.setUiScale,
        label: 'UI size',
    }, 'uiScale');

    registerPrefChannel('get-main-controller', 'set-main-controller', 'main-controller-changed', {
        get: prefs.getMainController,
        set: prefs.setMainController,
        sideEffect: (next) => mainController.writeSidecar(next && next.mac),
        label: 'Main controller',
    }, 'mainController');

    registerPrefChannel('get-controller-autostart', 'set-controller-autostart', 'controller-autostart-changed', {
        get: prefs.getControllerAutostart,
        set: prefs.setControllerAutostart,
        sideEffect: (next) => autostart.writeSidecar(next),
        label: 'Auto-start',
    });

    registerPrefChannel('get-always-on-top', 'set-always-on-top', 'always-on-top-changed', {
        get: prefs.getAlwaysOnTop,
        set: prefs.setAlwaysOnTop,
        label: '"Always on top"',
    });

    registerPrefChannel('get-start-with-system', 'set-start-with-system', 'start-with-system-changed', {
        get: prefs.getStartWithSystem,
        set: prefs.setStartWithSystem,
        sideEffect: (next) => {
            if (next) xdgAutostart.writeAutostartEntry(repoRoot);
            else xdgAutostart.removeAutostartEntry();
        },
        label: '"Start with the system"',
    });

    registerPrefChannel('get-cover-download', 'set-cover-download', 'cover-download-changed', {
        get: prefs.getCoverDownload,
        set: prefs.setCoverDownload,
        label: 'Cover download',
    });

    // Numeric pickers + do-not-disturb. Main ONLY stores them — except `volumeMax` (applied by the `change-volume`
    // handler, lib/ipc/output-ipc.js) and `doNotDisturb` (read by `onLaunchSequenceStart`).
    registerPrefChannel('get-idle-timeout', 'set-idle-timeout', 'idle-timeout-changed', {
        get: prefs.getIdleTimeout,
        set: prefs.setIdleTimeout,
        label: 'Screensaver',
    }, 'value');

    registerPrefChannel('get-volume-step', 'set-volume-step', 'volume-step-changed', {
        get: prefs.getVolumeStep,
        set: prefs.setVolumeStep,
        label: 'Volume step',
    }, 'value');

    registerPrefChannel('get-volume-max', 'set-volume-max', 'volume-max-changed', {
        get: prefs.getVolumeMax,
        set: prefs.setVolumeMax,
        label: 'Volume limit',
    }, 'value');

    registerPrefChannel('get-tv-exit-hold', 'set-tv-exit-hold', 'tv-exit-hold-changed', {
        get: prefs.getTvExitHold,
        set: prefs.setTvExitHold,
        label: 'TV mode exit hold',
    }, 'value');

    // Brightness / night mode — main ONLY stores, the filter layer is renderer-side.
    registerPrefChannel('get-screen-dim', 'set-screen-dim', 'screen-dim-changed', {
        get: prefs.getScreenDim,
        set: prefs.setScreenDim,
        label: 'Brightness',
    }, 'value');

    registerPrefChannel('get-night-mode', 'set-night-mode', 'night-mode-changed', {
        get: prefs.getNightMode,
        set: prefs.setNightMode,
        label: 'Night mode',
    }, 'value');

    // Idle suspend / controller disconnect — idleness is measured by the renderer (renderer/home/idle-power.js),
    // execution goes through `system-action` and the `disconnect-idle-controllers` path below.
    // Playtime reminder: main supplies today's playtime in the `app-closed` payload, the renderer keeps the threshold.
    registerPrefChannel('get-playtime-reminder', 'set-playtime-reminder', 'playtime-reminder-changed', {
        get: prefs.getPlaytimeReminder,
        set: prefs.setPlaytimeReminder,
        label: 'Play-time reminder',
    }, 'value');

    registerPrefChannel('get-auto-suspend', 'set-auto-suspend', 'auto-suspend-changed', {
        get: prefs.getAutoSuspend,
        set: prefs.setAutoSuspend,
        label: 'Automatic sleep',
    }, 'value');

    registerPrefChannel('get-idle-disconnect', 'set-idle-disconnect', 'idle-disconnect-changed', {
        get: prefs.getIdleDisconnect,
        set: prefs.setIdleDisconnect,
        label: 'Controller disconnect when idle',
    }, 'value');

    registerPrefChannel('get-do-not-disturb', 'set-do-not-disturb', 'do-not-disturb-changed', {
        get: prefs.getDoNotDisturb,
        set: prefs.setDoNotDisturb,
        // Turning it off also stops a live inhibit (Settings is unreachable while playing anyway, but the machine
        // must not stay muted after a stuck launch sequence either).
        sideEffect: (next) => { if (!next) stopDoNotDisturb(); },
        label: '"Ne zavarj"',
    });

    // Source ids excluded from the Games panel's ALL view (Square button -> filter popup in the panel). Main only
    // stores — the filtering is renderer-side (renderer/games-panel/games-panel.js).
    registerPrefChannel('get-games-hidden-sources', 'set-games-hidden-sources', 'games-hidden-sources-changed', {
        get: prefs.getGamesHiddenSources,
        set: prefs.setGamesHiddenSources,
        label: 'Games panel source filter',
    }, 'hiddenSources');

    // Games panel grid/list view per source (ALL + every launcher separately). The `set` payload is `{ id, mode }` —
    // `set()` gets a single argument from registerPrefChannel, hence it is unpacked here.
    registerPrefChannel('get-games-view-mode', 'set-games-view-mode', 'games-view-mode-changed', {
        get: prefs.getGamesViewMode,
        set: (payload) => prefs.setGamesViewMode(payload && payload.id, payload && payload.mode),
        label: 'Games panel view mode',
    }, 'viewMode');

    // First-use tips: `set` replaces the WHOLE seen list (empty list = "Show tips again").
    registerPrefChannel('get-seen-tips', 'set-seen-tips', 'seen-tips-changed', {
        get: prefs.getSeenTips,
        set: prefs.setSeenTips,
        label: 'Seen tips',
    }, 'seenTips');

    // Individually hidden games — `set` replaces the whole list (the renderer keeps the Set).
    registerPrefChannel('get-hidden-games', 'set-hidden-games', 'hidden-games-changed', {
        get: prefs.getHiddenGames,
        set: prefs.setHiddenGames,
        label: 'Hidden games',
    }, 'hiddenGames');

    // Games panel sort order per source (R3) — the counterpart of viewMode.
    registerPrefChannel('get-games-sort-mode', 'set-games-sort-mode', 'games-sort-mode-changed', {
        get: prefs.getGamesSortMode,
        set: (payload) => prefs.setGamesSortMode(payload && payload.id, payload && payload.mode),
        label: 'Games panel sort',
    }, 'sortMode');
}

module.exports = { registerPrefsIpc };
