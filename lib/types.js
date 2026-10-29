'use strict';

// Shared JSDoc @typedefs for the ts-checked `lib/*.js` modules. DELIBERATELY exports an empty object (types only).
// Usage: `/** @typedef {import('./types.js').Launcher} Launcher */`.

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/**
 * The log function (a `lib/exec.js` `createLogger()` instance, or the optional `log` parameter of
 * `lib/*`). A falsy value = "do not log" (the caller asked for no logging).
 * @typedef {(msg: string) => void} Logger
 */

/**
 * The part of Electron's `ipcMain` we use — the `register*Ipc({ ipcMain, … })` functions of
 * `lib/ipc/*-ipc.js` register on it (a fake object works in tests).
 * @typedef {Object} IpcMainLike
 * @property {(channel: string, fn: (event: any, payload?: any) => void) => any} on
 * @property {(channel: string, fn: (event: any, payload?: any) => any) => void} handle
 */

// ---------------------------------------------------------------------------
// Launcher object (customLaunchers config key / data/launcher-catalog.json, extended with
// runtime fields by lib/recent/usage.js decorateLaunchers())
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Launcher
 * @property {string} id
 * @property {string} name
 * @property {string} [hint]
 * @property {string} [icon]                relative path (assets/icons/<id>.svg)
 * @property {string} cmd
 * @property {string[]} args
 * @property {boolean} [default]
 * @property {string} [accent]              #rrggbb per-launcher accent color
 * @property {boolean} [custom]             came from the customLaunchers config key
 * @property {string} [wmMatch]             for the switchToRunning() window activation
 * @property {UsageEntry|null} [usage]      added by decorateLaunchers()
 * @property {boolean} [running]            added by decorateLaunchers()
 * @property {RecentGameEntry[]} [recentGames] added by decorateLaunchers()
 */

// ---------------------------------------------------------------------------
// `display` config key (lib/output/displays.js)
// ---------------------------------------------------------------------------

/**
 * The "desktop" output profile used when leaving TV mode.
 * @typedef {Object} DesktopProfile
 * @property {string[]} monitors           ordered connector list (first = priority 1)
 * @property {string|null} sink
 * @property {boolean} disableOthers        connected outputs not on the list are turned off
 * @property {boolean} pinned               true = pinned by hand, `captureDesktopSnapshot` never overwrites it
 */

/**
 * Normalized shape of the `display` config key (lib/output/displays.js `normalizeDisplayConfig`).
 * `monitor`/`sink`/`desktop` are ALWAYS present (null if missing); the TV keys ONLY when they hold a
 * non-default value.
 * @typedef {Object} DisplayConfig
 * @property {string|null} monitor          startup monitor connector
 * @property {string|null} sink             startup audio device
 * @property {DesktopProfile|null} desktop
 * @property {boolean} [tvIsStartupMonitor]
 * @property {boolean} [standbyOnExit]
 * @property {boolean} [keepOtherMonitors]  do NOT disable the other outputs at startup
 * @property {boolean} [cecPowerOn]         only stored as `false` (default true)
 * @property {number} [cecTarget]           1..15 CEC logical address
 */

// ---------------------------------------------------------------------------
// `feedback` / `mainController` / `tvMode` config keys (lib/prefs.js)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FeedbackPrefs
 * @property {boolean} sound
 * @property {boolean} rumble
 * @property {boolean} motion
 * @property {boolean} contrast
 * @property {boolean} [slowRepeat] slow repeat for a held direction
 * @property {boolean} [screenReader] screen-reader support
 */

/**
 * @typedef {Object} MainController
 * @property {string} mac                   AA:BB:CC:DD:EE:FF (uppercase)
 * @property {string} name
 * @property {'dualsense'|'dualshock'|'xbox'|'generic'|string} type
 */

/**
 * @typedef {Object} TvModePrefs
 * @property {string[]} closeFlatpak
 * @property {string[]} closeNative
 * @property {string[]} preCommands
 */

// ---------------------------------------------------------------------------
// `usage` / `recentGames` config keys (lib/recent/usage.js, lib/recent/recent-games.js)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} UsageEntry
 * @property {number} count
 * @property {string} lastLaunchedAt        ISO timestamp
 * @property {number} [totalMs]             accumulated playtime — missing = 0
 * @property {number} [lastSessionMs]       length of the last session
 */

/**
 * One item of the `recentGames` MRU list (Heroic: stored; Steam/RetroArch: derived).
 * @typedef {Object} RecentGameEntry
 * @property {string} key                   e.g. steam-game-<appid> / retroarch:<system>:<label>
 * @property {string} name
 * @property {string|null} cover            absolute cover path or null
 * @property {string|null} kind             'steam' | 'heroic' | 'retroarch'
 * @property {Object} params                for re-invoking the launch IPC
 * @property {string} lastLaunchedAt
 */

// ---------------------------------------------------------------------------
// Parser outputs (lib/parse.js)
// ---------------------------------------------------------------------------

/**
 * `kscreen-doctor -j` -> one connected output (lib/parse.js `parseMonitors`).
 * @typedef {Object} Monitor
 * @property {string} name                  connector (DP-3)
 * @property {number|null} width
 * @property {number|null} height
 * @property {boolean} active               whether the output is enabled
 * @property {number} priority              1-based (0 = disabled)
 * @property {string} label                 "DP-3 — 2560×1080"
 */

/**
 * `pactl list sinks` -> one audio device (lib/parse.js `parseSinks`).
 * @typedef {Object} AudioSink
 * @property {string} name
 * @property {string} description
 * @property {boolean} isDefault
 */

module.exports = {};
