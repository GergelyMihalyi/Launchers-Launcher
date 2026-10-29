// @ts-check
'use strict';

// Validated get/set of machine-specific preferences on top of `lib/config.js` (theme, feedback,
// language, UI scale, background, main controller, TV mode, switches, Games panel view). Most of them
// only have a renderer-side EFFECT — main just stores/reads (sidecar writes, where any, live in the
// calling IPC handler).

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config.js');
const { isMac } = require('./sidecars/main-controller.js'); // MAC validation (the sidecar write is in the IPC handler)
// The SINGLE source of themes is the `themes/themes.json` manifest (a versioned data file, like
// `data/launcher-catalog.json` — not machine config). The whitelist is derived from it.
const themeManifest = require('../themes/themes.json');
// The SINGLE source of the built-in backgrounds (versioned data file, like themes.json) —
// one assets/backgrounds/<id>.svg per id.
const backgroundManifest = require('../data/backgrounds.json');
const BUILTIN_BG_IDS = backgroundManifest.map((b) => b.id);

const THEME_IDS = themeManifest.map((t) => t.id);
const DEFAULT_THEME = 'neon';

// --- Pref factories ---
// Most preferences follow one of 3 patterns; the factories return `{ get, set }`, and the named
// `getX`/`setX` exports at the bottom of the module point to them. A new simple switch = 1 row.

// Bool switch. `def: true` → only an explicit `false` turns it off (missing key = on);
// `def: false` → only an explicit `true` turns it on.
function boolPref(key, def) {
    const norm = (v) => (def ? v !== false : v === true);
    return {
        get: () => norm(config.get(key, def)),
        set: (v) => { const next = norm(v); config.set(key, next); return next; },
    };
}

// Whitelisted value (string or number — strict equality); unknown → the default.
function enumPref(key, values, def) {
    const norm = (v) => (values.includes(v) ? v : def);
    return {
        get: () => norm(config.get(key, null)),
        set: (v) => { const next = norm(v); config.set(key, next); return next; },
    };
}

// Object of bool fields with per-field defaults: only `boolean` values are accepted (wrong type
// → the default / current value stays), set is a field-level merge.
function boolFlagsPref(key, defaults) {
    function get() {
        const parsed = config.get(key, null) || {};
        const out = {};
        for (const [k, def] of Object.entries(defaults)) {
            out[k] = typeof parsed[k] === 'boolean' ? parsed[k] : def;
        }
        return out;
    }
    function set(partial) {
        const cur = get();
        const p = partial || {};
        const next = {};
        for (const k of Object.keys(defaults)) {
            next[k] = typeof p[k] === 'boolean' ? p[k] : cur[k];
        }
        config.set(key, next);
        return next;
    }
    return { get, set };
}

// --- Theme (`theme` config key: `{ theme: "<id>" }`) ---

function getTheme() {
    const parsed = config.get('theme', null);
    const id = parsed && parsed.theme;
    return { theme: THEME_IDS.includes(id) ? id : DEFAULT_THEME };
}

function setTheme(theme) {
    const next = { theme: THEME_IDS.includes(theme) ? theme : DEFAULT_THEME };
    config.set('theme', next);
    return next;
}

// --- Feedback (`feedback` config key) ---
// `sound`/`rumble`/`motion` default ON, `contrast` default OFF. A new switch = 1 row here + 1 row in
// the renderer `FEEDBACK_ROWS`. Only `boolean` values are accepted (wrong type → default), field-level merge.
// `slowRepeat` / `screenReader`: slow repeat for a held direction; screen-reader support (announcing the
// focused element + Chromium's accessibility tree) — both OFF by default.
const FEEDBACK_DEFAULTS = { sound: true, rumble: true, motion: true, contrast: false, slowRepeat: false, screenReader: false };
/** @type {{ get: () => import('./types.js').FeedbackPrefs, set: (p: any) => any }} */
const feedbackPref = /** @type {any} */ (boolFlagsPref('feedback', FEEDBACK_DEFAULTS));

// --- Visibility of the recently-played bars (`recentGamesUi` config key) ---
// All ON by default — the global "Continue" bar, the Games panel's "Recently played" row and the
// quick-launch bar under the launcher card can be turned off one by one. Same pattern as `feedback`
// (field-level merge, `boolean` only, an unknown key falls back to the default).
const RECENT_GAMES_UI_DEFAULTS = { continueBar: true, gamesPanelRecent: true, launcherRecent: true };
const recentGamesUiPref = boolFlagsPref('recentGamesUi', RECENT_GAMES_UI_DEFAULTS);

// --- Main controller (`mainController` config key) ---
// `{ mac, name, type }` = the BT controller that starts the launcher; `null` / missing key =
// "any controller". The `set-main-controller` handler also refreshes the sidecar file
// (lib/sidecars/main-controller.js) read by the guard of bin/launchers-launcher-bt-trigger.sh.

/** @returns {import('./types.js').MainController|null} */
function getMainController() {
    const raw = config.get('mainController', null);
    if (!raw || typeof raw !== 'object' || !isMac(raw.mac)) return null;
    return {
        mac: raw.mac.trim().toUpperCase(),
        name: typeof raw.name === 'string' ? raw.name : '',
        type: typeof raw.type === 'string' ? raw.type : 'generic',
    };
}

function setMainController(entry) {
    if (!entry || !isMac(entry.mac)) {
        config.set('mainController', null);
        return null;
    }
    const next = {
        mac: entry.mac.trim().toUpperCase(),
        name: typeof entry.name === 'string' ? entry.name : '',
        type: typeof entry.type === 'string' ? entry.type : 'generic',
    };
    config.set('mainController', next);
    return next;
}

// --- Entering TV mode (`tvMode` config key) ---
// Programs to close + pre-commands when entering TV mode. Mirrored at startup (+ by the `set-tv-mode`
// handler, lib/ipc/tv-mode-ipc.js) into the lib/sidecars/tv-mode-enter.js sidecar read by
// bin/tv-mode-enter.sh. MACHINE-SPECIFIC — empty by default (then `tv-mode-enter.sh` only starts the launcher).

const TV_MODE_KEYS = ['closeFlatpak', 'closeNative', 'preCommands'];

/** @returns {import('./types.js').TvModePrefs} */
function getTvMode() {
    const raw = config.get('tvMode', null) || {};
    const out = /** @type {import('./types.js').TvModePrefs} */ ({});
    for (const key of TV_MODE_KEYS) {
        out[key] = Array.isArray(raw[key]) ? raw[key] : [];
    }
    return out;
}

function setTvMode(partial) {
    const cur = getTvMode();
    const p = partial || {};
    const next = {};
    for (const key of TV_MODE_KEYS) {
        next[key] = Array.isArray(p[key]) ? p[key] : cur[key];
    }
    config.set('tvMode', next);
    return next;
}

// --- Language (`language` config key) ---
// Main ONLY stores it — the effect is renderer-side (`renderer/i18n/i18n.js` `setActiveLanguage`);
// switched in Settings → Appearance → Language or the setup wizard (`set-language` IPC).

const LANGUAGES = ['hu', 'en'];
const DEFAULT_LANGUAGE = 'hu';
const languagePref = enumPref('language', LANGUAGES, DEFAULT_LANGUAGE);

// --- UI scale (`uiScale` config key) ---
// Manual UI zoom for the `rem`-based surface (Settings / Games panel, bottom bar, overlays, tips,
// toast) — `<html data-ui-scale>` + the `--ui-scale` multiplier of `styles/*.css` in the `html`
// `font-size`. Does NOT affect the carousel's `vh` clamps (the card size stays viewing-distance
// independent). Main ONLY stores it — the effect is renderer-side (`applyUiScale`).

const UI_SCALES = ['small', 'normal', 'large'];
const DEFAULT_UI_SCALE = 'normal';
const uiScalePref = enumPref('uiScale', UI_SCALES, DEFAULT_UI_SCALE);

// --- Background image (`background` config key: PER-THEME map `{ "<themeId>": entry }`) ---
// An `entry` = `{ type: 'none'|'builtin'|'custom', id?, path? }`. `none` / missing theme key = the
// theme's `.bg-glow` shows; `builtin` = an `assets/backgrounds/<id>.svg` (whitelisted from
// backgroundManifest); `custom` = absolute path to a file under ~/Pictures/launchers-launcher/.
// The background is thus BOUND TO A THEME — on a theme switch the renderer applies the other theme's
// background. Main ONLY stores it — the effect is renderer-side (`applyBackground` sets `#bgCustom`).

function normalizeBgEntry(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'none' };
    if (raw.type === 'builtin' && BUILTIN_BG_IDS.includes(raw.id)) return { type: 'builtin', id: raw.id };
    if (raw.type === 'custom' && typeof raw.path === 'string' && raw.path) return { type: 'custom', path: raw.path };
    return { type: 'none' };
}

// The whole per-theme map, `none`s filtered out (no need to store them on disk either).
function getBackgroundMap() {
    const raw = config.get('background', null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [themeId, v] of Object.entries(raw)) {
        if (typeof themeId !== 'string' || !themeId) continue;
        const e = normalizeBgEntry(v);
        if (e.type !== 'none') out[themeId] = e;
    }
    return out;
}

function getBackground(themeId) {
    return getBackgroundMap()[themeId] || { type: 'none' };
}

function setBackground(themeId, cfg) {
    const entry = normalizeBgEntry(cfg);
    const map = getBackgroundMap();
    if (typeof themeId !== 'string' || !themeId) return entry;
    if (entry.type === 'none') delete map[themeId];
    else map[themeId] = entry;
    config.set('background', map);
    return entry;
}

function listBuiltinBackgrounds() {
    return backgroundManifest;
}

// Image files (jpg/jpeg/png/webp) of ~/Pictures/launchers-launcher/ for the custom background subview.
// Missing folder (ENOENT) → empty list, NOT an error; any other fs error is rethrown (the
// `list-backgrounds` IPC handler turns it into `{ ok: false, ... }` — the caller decides what a REAL
// error means).
function listCustomBackgrounds(homeDir = os.homedir()) {
    const dir = path.join(homeDir, 'Pictures', 'launchers-launcher');
    try {
        return fs.readdirSync(dir)
            .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
            .sort()
            .map((f) => ({ name: f, path: path.join(dir, f) }));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

// --- Setup wizard state (`setupDone` config key) ---
// `true` = the first-start setup wizard has run. Missing/false → the renderer brings it up at startup
// (renderer/setup-wizard.js). It can also be started from Settings → System → "Setup wizard".
const setupDonePref = boolPref('setupDone', false);

// --- Auto-start on controller (`controllerAutostart` config key) ---
// `true` (default, also for a missing key) = a recognized controller connection may start the
// launcher. `false` = the bt-trigger guard skips the start — the launcher can still be started from
// the icon / by hand. The `set-controller-autostart` handler also refreshes the `lib/sidecars/autostart.js`
// sidecar (read by bin/launchers-launcher-bt-trigger.sh). Does NOT affect the watcher/bt-trigger systemd units.
const controllerAutostartPref = boolPref('controllerAutostart', true);

// --- "Always on top" (`alwaysOnTop` config key) ---
// `true` (default, also for a missing key) = the foreground guard (lib/launch/foreground-guard.js) is
// active — the launcher takes the focus back on blur, except while a game is starting/running.
// `false` = the guard is a no-op — the launcher behaves like a normal window and does not reclaim focus.
// Pure in-process state, no sidecar (no external consumer).
const alwaysOnTopPref = boolPref('alwaysOnTop', true);

// --- Start with the system (`startWithSystem` config key) ---
// `false` (default, also for a missing key) = the launcher window does NOT open by itself at login
// (only on a controller connection or from the icon). `true` = the `set-start-with-system` handler writes
// an XDG autostart `.desktop` entry into `~/.config/autostart/` (lib/sidecars/xdg-autostart.js) that
// starts the launcher with the graphical session. Independent of `controllerAutostart` — that one only
// enables/disables the controller BT-trigger start.
const startWithSystemPref = boolPref('startWithSystem', false);

// --- Automatic cover download (`coverDownload` config key) ---
// `true` (default, also for a missing key) = missing covers are downloaded automatically (see the
// `ensure*Covers` functions of `lib/launchers/*-library.js`). `false` = the cover downloaders of
// `lib/recent/recent-covers.js` and `lib/ipc/games-ipc.js` do not even try the network — covers ALREADY
// downloaded stay on disk (`ensure*` only downloads what is missing, never deletes).
const coverDownloadPref = boolPref('coverDownload', true);

// --- Numeric pickers ---
// All `enumPref` (whitelist, unknown → default); the default is the value hard-coded before the switch
// existed. The effect is renderer-side (screensaver / L1/R1 step / ○ hold), except `volumeMax`, applied by
// main's `change-volume` handler (lib/ipc/output-ipc.js).
// TV-mode exit has NO "Off" value: the ○ hold is the only controller exit path.
const IDLE_TIMEOUTS = [0, 3, 5, 10, 30]; // minutes, 0 = screensaver off
const VOLUME_STEPS = [2, 5, 10]; // %
const VOLUME_MAXES = [100, 85, 70, 50]; // %, 100 = no cap
const TV_EXIT_HOLDS = [3, 5, 8, 10]; // seconds
const idleTimeoutPref = enumPref('idleTimeout', IDLE_TIMEOUTS, 3);
const volumeStepPref = enumPref('volumeStep', VOLUME_STEPS, 5);
const volumeMaxPref = enumPref('volumeMax', VOLUME_MAXES, 100);
const tvExitHoldPref = enumPref('tvExitHold', TV_EXIT_HOLDS, 5);

// --- Brightness + night mode ---
// Software filter layer above the launcher window (renderer/settings/settings-screen-filter.js) —
// main ONLY stores. `screenDim` = dimming % (0 = full brightness), `nightMode` = warm filter strength
// (0 = off, 1 = mild, 2 = strong). DDC/CI (`ddcutil`) is deliberately not used.
const SCREEN_DIMS = [0, 20, 40, 60]; // % dimming
const NIGHT_MODES = [0, 1, 2]; // off / mild / strong
const screenDimPref = enumPref('screenDim', SCREEN_DIMS, 0);
const nightModePref = enumPref('nightMode', NIGHT_MODES, 0);

// --- Idle auto-suspend + controller disconnect ---
// minutes, 0 = off. Idleness is measured by the renderer (renderer/home/idle-power.js, only while the
// launcher is focused); main executes via the existing `system-action` / `disconnect-idle-controllers`
// paths. Both OFF by default.
const AUTO_SUSPENDS = [0, 30, 60, 120];
const IDLE_DISCONNECTS = [0, 10, 20, 30];
const autoSuspendPref = enumPref('autoSuspend', AUTO_SUSPENDS, 0);
// Playtime reminder: after this many hours of play today, it notifies on return (does not block); 0 = off.
const PLAYTIME_REMINDERS = [0, 1, 2, 3, 4];
const playtimeReminderPref = enumPref('playtimeReminder', PLAYTIME_REMINDERS, 0);
const idleDisconnectPref = enumPref('idleDisconnect', IDLE_DISCONNECTS, 0);

// --- Do-not-disturb while playing (`doNotDisturb` config key) ---
// `true` (default) = `lib/launch/do-not-disturb.js` silences desktop notifications during the launch
// sequence; `false` = no inhibit is started.
const doNotDisturbPref = boolPref('doNotDisturb', true);

// --- Games panel source filter (`gamesHiddenSources` config key) ---
// Source ids excluded from the ALL view; ONLY narrows the ALL aggregation (the source's own chip and the
// card menu still reach it). Main ONLY stores, filtering is renderer-side. Source ids come from the shared
// launcher registry. Default = empty array.
const { GAMES_SOURCE_IDS } = require('../launcher-registry.js');

function getGamesHiddenSources() {
    const raw = config.get('gamesHiddenSources', []);
    return Array.isArray(raw) ? [...new Set(raw.filter((id) => GAMES_SOURCE_IDS.includes(id)))] : [];
}

function setGamesHiddenSources(list) {
    const next = Array.isArray(list) ? [...new Set(list.filter((id) => GAMES_SOURCE_IDS.includes(id)))] : [];
    config.set('gamesHiddenSources', next);
    return next;
}

// --- Games panel grid/list view (`gamesViewMode` config key) ---
// Per source (`GAMES_SOURCE_IDS` + the virtual `'all'` view) the Games panel shows that source's games as a
// cover grid or a text list — Settings → Games → "Grid or list" (renderer/settings/settings-games-view.js).
// The stored map only holds the DEVIATIONS; `resolveGamesViewMode` supplies the default
// (`all` -> 'list', everything else -> 'grid').
const GAMES_VIEW_MODES = ['grid', 'list'];
const GAMES_VIEW_MODE_IDS = ['all', ...GAMES_SOURCE_IDS];

function getGamesViewMode() {
    const raw = config.get('gamesViewMode', {});
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

// Pure helper: stored map + a source id -> the mode to apply. Missing/invalid entry -> the
// per-source default.
function resolveGamesViewMode(map, id) {
    const v = map && map[id];
    return GAMES_VIEW_MODES.includes(v) ? v : (id === 'all' ? 'list' : 'grid');
}

function setGamesViewMode(id, mode) {
    if (!GAMES_VIEW_MODE_IDS.includes(id) || !GAMES_VIEW_MODES.includes(mode)) return getGamesViewMode();
    const next = { ...getGamesViewMode(), [id]: mode };
    config.set('gamesViewMode', next);
    return next;
}

// --- Games panel sort order (`gamesSortMode` config key; toggled with R3) ---
// Per source (`GAMES_VIEW_MODE_IDS`: the virtual 'all' + every game source) the list order:
// name (default) / last played / playtime. Only DEVIATIONS are stored.
const GAMES_SORT_MODES = ['name', 'recent', 'playtime', 'added'];

function getGamesSortMode() {
    const raw = config.get('gamesSortMode', {});
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

function setGamesSortMode(id, mode) {
    if (!GAMES_VIEW_MODE_IDS.includes(id) || !GAMES_SORT_MODES.includes(mode)) return getGamesSortMode();
    const next = { ...getGamesSortMode(), [id]: mode };
    config.set('gamesSortMode', next);
    return next;
}

// --- Individually hidden games (`hiddenGames` config key) ---
// The games' favorite keys (`<source>-game-<id>` / `retroarch:<system>:<name>`); hidden / restored in the
// Games panel's game details. String keys only, no duplicates, at most MAX_HIDDEN_GAMES (a runaway
// renderer must not bloat the config).
const MAX_HIDDEN_GAMES = 5000;

function cleanHiddenGames(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const k of list) {
        if (typeof k !== 'string' || !k || k.length > 600 || seen.has(k)) continue;
        seen.add(k);
        out.push(k);
        if (out.length >= MAX_HIDDEN_GAMES) break;
    }
    return out;
}

function getHiddenGames() {
    return cleanHiddenGames(config.get('hiddenGames', []));
}

function setHiddenGames(list) {
    const next = cleanHiddenGames(list);
    config.set('hiddenGames', next);
    return next;
}

// --- First-use tips (`seenTips` config key) ---
// Ids of the tips already shown (the table lives in `renderer/home/tips.js`; here only short string ids,
// no duplicates, at most MAX_SEEN_TIPS — no mirrored list in main).
const MAX_SEEN_TIPS = 64;

function cleanSeenTips(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter((t) => typeof t === 'string' && t && t.length <= 40))].slice(0, MAX_SEEN_TIPS);
}

function getSeenTips() {
    return cleanSeenTips(config.get('seenTips', []));
}

function setSeenTips(list) {
    const next = cleanSeenTips(list);
    config.set('seenTips', next);
    return next;
}

// --- Per-game launch options (`gameLaunchOptions` config key; lib/launch/launch-options.js) ---
// `{ "<game-key>": "<text>" }`; only parseable text is stored, empty text deletes the entry.
const MAX_LAUNCH_OPTION_ENTRIES = 500;

function getGameLaunchOptions() {
    const raw = config.get('gameLaunchOptions', {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
    return out;
}

function getGameLaunchOption(key) {
    return typeof key === 'string' ? (getGameLaunchOptions()[key] || '') : '';
}

/** @returns {{ ok: boolean, text?: string, error?: string }} */
function setGameLaunchOption(key, text) {
    if (typeof key !== 'string' || !key || key.length > 600) return { ok: false, error: 'invalid-key' };
    const { parseLaunchOptions } = require('./launch/launch-options.js');
    const parsed = parseLaunchOptions(text);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const map = getGameLaunchOptions();
    if (parsed.text) {
        if (!(key in map) && Object.keys(map).length >= MAX_LAUNCH_OPTION_ENTRIES) return { ok: false, error: 'too-many' };
        map[key] = parsed.text;
    } else {
        delete map[key];
    }
    config.set('gameLaunchOptions', map);
    return { ok: true, text: parsed.text };
}

module.exports = {
    getGameLaunchOption, getGameLaunchOptions, setGameLaunchOption,
    getSeenTips, setSeenTips, cleanSeenTips,
    getHiddenGames, setHiddenGames, cleanHiddenGames,
    getGamesSortMode, setGamesSortMode, GAMES_SORT_MODES,
    getTheme, setTheme,
    getFeedback: feedbackPref.get, setFeedback: feedbackPref.set,
    getRecentGamesUi: recentGamesUiPref.get, setRecentGamesUi: recentGamesUiPref.set,
    getMainController, setMainController,
    getTvMode, setTvMode,
    getSetupDone: setupDonePref.get, setSetupDone: setupDonePref.set,
    getLanguage: languagePref.get, setLanguage: languagePref.set,
    getUiScale: uiScalePref.get, setUiScale: uiScalePref.set,
    getBackground, getBackgroundMap, setBackground, listBuiltinBackgrounds, listCustomBackgrounds,
    getControllerAutostart: controllerAutostartPref.get, setControllerAutostart: controllerAutostartPref.set,
    getAlwaysOnTop: alwaysOnTopPref.get, setAlwaysOnTop: alwaysOnTopPref.set,
    getStartWithSystem: startWithSystemPref.get, setStartWithSystem: startWithSystemPref.set,
    getCoverDownload: coverDownloadPref.get, setCoverDownload: coverDownloadPref.set,
    getIdleTimeout: idleTimeoutPref.get, setIdleTimeout: idleTimeoutPref.set,
    getVolumeStep: volumeStepPref.get, setVolumeStep: volumeStepPref.set,
    getVolumeMax: volumeMaxPref.get, setVolumeMax: volumeMaxPref.set,
    getTvExitHold: tvExitHoldPref.get, setTvExitHold: tvExitHoldPref.set,
    getDoNotDisturb: doNotDisturbPref.get, setDoNotDisturb: doNotDisturbPref.set,
    getScreenDim: screenDimPref.get, setScreenDim: screenDimPref.set,
    getNightMode: nightModePref.get, setNightMode: nightModePref.set,
    getAutoSuspend: autoSuspendPref.get, setAutoSuspend: autoSuspendPref.set,
    getPlaytimeReminder: playtimeReminderPref.get, setPlaytimeReminder: playtimeReminderPref.set, PLAYTIME_REMINDERS,
    getIdleDisconnect: idleDisconnectPref.get, setIdleDisconnect: idleDisconnectPref.set,
    IDLE_TIMEOUTS, VOLUME_STEPS, VOLUME_MAXES, TV_EXIT_HOLDS,
    SCREEN_DIMS, NIGHT_MODES, AUTO_SUSPENDS, IDLE_DISCONNECTS,
    getGamesHiddenSources, setGamesHiddenSources,
    getGamesViewMode, setGamesViewMode, resolveGamesViewMode,
    THEME_IDS, DEFAULT_THEME, FEEDBACK_DEFAULTS, RECENT_GAMES_UI_DEFAULTS, TV_MODE_KEYS, LANGUAGES, DEFAULT_LANGUAGE, UI_SCALES, DEFAULT_UI_SCALE, themeManifest, backgroundManifest,
    GAMES_SOURCE_IDS, GAMES_VIEW_MODES, GAMES_VIEW_MODE_IDS,
};
