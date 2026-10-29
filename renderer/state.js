// The renderer/*.js files share ONE global lexical scope (no bundler; the load order in index.html matters). This file collects in one
// place the few `let`s that SEVERAL files MUTATE, so "who writes this?" can be answered at a glance.
// Load order: AFTER util.js, BEFORE every other renderer/*.js. Background: docs/dev/renderer/overview.md#file-layout-and-script-order
//
// | global              | what                                  | written by (besides the declaration)                     |
// | ------------------- | ------------------------------------- | -------------------------------------------------------- |
// | launchers           | the launcher list (without GAMES_CARD)| ipc.js (onLaunchersChanged/onRunningChanged), main.js    |
// | recentBarFocus      | -1 = on the card; 0..2 = in the       | gamepad.js (nav*), carousel.js (renderCards/updateFocus),|
// |                     | quick-launch bar                      | games-panel.js (startGameLaunch)                         |
// | continueGames       | list of the global "Continue" bar     | carousel.js (refreshContinueBar from get-continue-games) |
// | activeSessionInfo   | the running game (BACK item)          | renderer/ipc.js (`active-session` push), main.js (startup) |
// | continueFocus       | -1 = not in the Continue bar; 0..2    | gamepad.js (nav*), carousel.js (updateFocus/renderCards) |
// | isLaunching         | is an app launch in progress (the     | gamepad.js (launchApp/watchdog/endLaunching),            |
// |                     | main branch of pollGamepad blocks)    | games-panel.js (startGameLaunch)                         |
// | buttonStates        | edge-trigger state of the MAIN nav    | settings.js/games-panel.js/card-menu.js/quick-power.js   |
// |                     |                                       | on panel close (syncEdge)                                |
// | feedbackState       | mirror of the `feedback` config key   | ipc.js (getFeedback/onFeedbackChanged), settings-feedback|
// | recentGamesUiState  | mirror of the `recentGamesUi` key     | ipc.js (getRecentGamesUi/onRecentGamesUiChanged),        |
// |                     | (3 "recently played" bars on/off)     | settings-recent-games.js                                 |
// | THEMES              | the theme manifest (fallback: neon)   | main.js (with the list-themes IPC response)              |
// | tvCaps              | { cec, ddc } — is there TV control    | main.js (get-tv-capabilities); gamepad.js READS it       |
// | killWatchActive     | is a "killable" (force-closable with  | ipc.js (onAppLaunched/onAppClosed/onAppError);           |
// |                     | PS/Home) game running — currently     | gamepad.js READS it (pollGamepad + armLaunchWatchdog)    |
// |                     | melonDS only                          |                                                          |
//
// Write-ONCE registries: `SETTINGS_VIEWS` of `settings.js` (every `settings-<id>.js` sets `SETTINGS_VIEWS['<id>'] = {...}` at its bottom),
// `setControllerTypeChangeHandler(fn)` of `controller-labels.js` (called by the `main.js` init). State written by a single file stays in
// that file (`cards`/`focusedIndex` in the carousel, `settingsView`, `gamesPanel*`, `currentTheme`, the `*ButtonStates` objects).

let launchers = [];       // see carousel.js (renderCards renders [...launchers, GAMES_CARD])
let recentBarFocus = -1;  // quick-launch bar focus
let continueGames = [];   // global "Continue" bar
let activeSessionInfo = null; // the game launched from the launcher and still running { appId, name, cover } — the Continue bar's "BACK" item
let continueFocus = -1;   // -1 = not in the Continue bar; 0..2 = in it
let isLaunching = false;   // double-launch guard + guard of pollGamepad's main branch
let launchSessionName = ''; // name of the last launched app/game (overlays.js showLoading) — for the summary toast on return
let buttonStates = {};     // edge-trigger state of the main card navigation (renderer/util.js `edge`)
let feedbackState = { sound: true, rumble: true, motion: true, contrast: false }; // renderer/feedback.js
let recentGamesUiState = { continueBar: true, gamesPanelRecent: true, launcherRecent: true }; //
let THEMES = [{ id: 'neon', label: 'Neon (alap)' }]; // the themes/themes.json manifest (loaded by the main.js init)
let tvCaps = { cec: false, ddc: false }; // fail-closed: a get-tv-capabilities IPC turn-on-olja (main.js)
// Time of the last failed launch (renderer/ipc.js `onAppError`) — for `LOG_JUMP_MS` after it, Select opens the Log subview directly
// instead of Settings.
let launchErrorAt = 0;
const LOG_JUMP_MS = 10000;
let killWatchActive = false; // is a killable (force-closable with PS/Home) game running — see gamepad.js
