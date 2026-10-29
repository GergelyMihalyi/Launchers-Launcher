'use strict';

// Fake `window.launcher` data for the e2e smoke (test/e2e/harness.js) — with the REAL response
// shapes of the main.js handlers (see the individual `ipcMain.handle` calls). No Electron
// dependency, the stub preload requires it. Intentionally deterministic (no Math.random).

const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const catalog = require(path.join(root, 'data', 'launcher-catalog.json'));
const themeManifest = require(path.join(root, 'themes', 'themes.json'));

// 5 launchers from the catalog (also runs the N > 3 branch of the carousel ring math).
const LAUNCHER_IDS = ['steam', 'heroic', 'retroarch', 'pcsx2', 'melonds'];
const launchers = LAUNCHER_IDS
    .map((id) => catalog.find((c) => c.id === id))
    .filter(Boolean)
    .map((c, i) => ({
        ...c,
        custom: true,
        usage: { count: 5 - i, lastLaunchedAt: new Date(Date.UTC(2026, 8, 20 - i)).toISOString() },
        running: i === 1,
        recentGames: i === 0 ? [
            { key: 'steam-game-1', name: 'Portal 2', cover: null, kind: 'steam', params: { appid: '1' } },
            { key: 'steam-game-2', name: 'Hades', cover: null, kind: 'steam', params: { appid: '2' } },
        ] : [],
    }));

const WORDS = ['Super', 'Mega', 'Zelda', 'Metroid', 'Sonic', 'Kirby', 'Contra', 'Castle', 'Street', 'Final',
    'Dragon', 'Star', 'Tetris', 'Pilot', 'Racer', 'Quest', 'Legend', 'Blaster', 'Ninja', 'Galaxy'];

// ~16 000 RetroArch ROMs, grouped by system (the shape of `list-retroarch-all-games`).
function retroAllGames(total = 16000) {
    const systems = ['Nintendo - Nintendo Entertainment System', 'Nintendo - Super Nintendo Entertainment System',
        'Sega - Mega Drive - Genesis', 'Sony - PlayStation'];
    const per = Math.ceil(total / systems.length);
    return systems.map((system, s) => ({
        system,
        games: Array.from({ length: per }, (_, i) => {
            const n = s * per + i;
            const label = `${WORDS[n % WORDS.length]} ${WORDS[(n * 7) % WORDS.length]} ${n}`;
            return { label, path: `/roms/${s}/${n}.zip`, cover: null };
        }),
    }));
}

const RETRO_ALL = retroAllGames();

const steamGames = Array.from({ length: 40 }, (_, i) => ({
    name: `${WORDS[i % WORDS.length]} Steam ${i}`, source: 'steam', appid: String(1000 + i), cover: null,
}));
const heroicGames = Array.from({ length: 12 }, (_, i) => ({
    name: `${WORDS[(i + 3) % WORDS.length]} GOG ${i}`, source: 'gog', appName: `gog${i}`, cover: null,
}));

const ok = (items) => ({ ok: true, items });

// invoke calls: method name -> return value (the stub wraps it in Promise.resolve).
const INVOKE = {
    getLaunchers: launchers,
    getContinueGames: [
        { key: 'steam-game-1', name: 'Portal 2', cover: null, kind: 'steam', params: { appid: '1' }, lastLaunchedAt: '2026-09-20T10:00:00.000Z' },
    ],
    getFavoriteGames: [],
    getTheme: 'neon',
    listThemes: themeManifest,
    getLanguage: 'hu',
    getTvCapabilities: { cec: false, ddc: false },
    getFeedback: { sound: false, rumble: false, motion: true, contrast: false },
    getRecentGamesUi: { continueBar: true, gamesPanelRecent: true, launcherRecent: true },
    getBackground: {},
    getUiScale: 'normal',
    getSleepTimer: { minutes: 0, endsAt: null },
    readClipboardText: { ok: true, text: '' },
    getGamesWarmupState: { running: false, done: 0, total: 0 },
    getSetupState: { done: true },
    getChangelog: { pending: false, heading: '', lines: [] },
    getMainController: null,
    getControllerAutostart: true,
    getAlwaysOnTop: true,
    getStartWithSystem: false,
    getCoverDownload: true,
    getIdleTimeout: 3,
    getVolumeStep: 5,
    getVolumeMax: 100,
    getTvExitHold: 5,
    getDoNotDisturb: true,
    getScreenDim: 0,
    getNightMode: 0,
    getAutoSuspend: 0,
    getIdleDisconnect: 0,
    getGamesCacheInfo: ok([{ id: 'covers', path: '/home/e2e/.local/share/launchers-launcher/covers', bytes: 48200000, files: 812 }, { id: 'scan', path: '/home/e2e/.local/share/launchers-launcher/scan-cache', bytes: 910000, files: 4 }]),
    clearGamesCache: { ok: true, freedBytes: 49110000 },
    getGamesHiddenSources: [],
    getGamesViewMode: {},
    getGamesSortMode: {},
    getHiddenGames: [],
    getSeenTips: [],
    noteGamesSeen: { ok: true, newKeys: [] },
    listCoverImages: { ok: true, items: [] },
    listSettingsExports: { ok: true, items: [] },
    forgetWifi: { ok: true, removed: 1 },
    getGameLaunchOption: { ok: true, text: '' },
    getActiveSession: null,
    listRomGrants: { ok: true, items: [] },
    getGamesSortStats: { ok: true, items: {} },
    getMelondsRomDirs: [],
    getRomAccess: { ok: true, items: [] },
    getDisplayConfig: { monitor: 'DP-3', sink: null, desktop: null },
    getAppInfo: { version: '1.0.0', electron: process.versions.electron || '?', node: process.versions.node, chrome: process.versions.chrome || '?', gpu: 'enabled', gpuReason: null, ozone: 'wayland', desktop: 'kde', formatDrift: [] },
    getStartupTimeline: [{ name: 'appReady', ms: 180 }, { name: 'windowCreated', ms: 640 }, { name: 'launchersRendered', ms: 1350 }],
    getSelftest: [{ cmd: 'pactl', ok: true }, { cmd: 'kscreen-doctor', ok: false }],
    installHostPackages: {
        ok: true, installer: 'pkcon', packages: ['libkscreen-bin'], unmapped: [], missingAfter: [],
        selftest: [{ cmd: 'pactl', ok: true }, { cmd: 'kscreen-doctor', ok: true }],
    },
    getUsageStats: ok([
        { key: 'steam', kind: 'launcher', name: 'Steam', count: 5, totalMs: 3600000, lastSessionMs: 60000, lastLaunchedAt: '2026-09-20T10:00:00.000Z' },
    ]),
    getVolume: 40,
    checkUpdate: { state: 'up-to-date' },
    checkDependencies: {
        ok: true,
        outdated: [{ name: 'typescript', current: '5.9.3', wanted: '5.9.3', latest: '7.0.2', major: true }],
        audit: { total: 0, critical: 0, high: 0, moderate: 0, low: 0 },
    },
    listGames: ok([...steamGames, ...heroicGames]),
    getSaveBackupState: {
        ok: true, dir: '/home/e2e/launchers-launcher-saves', isDefaultDir: true, running: false, compressor: 'zstd', keep: 5,
        sources: [
            { id: 'pcsx2', name: 'PCSX2', bytes: 17300000, paths: [{ path: '/home/e2e/.var/app/net.pcsx2.PCSX2/config/PCSX2/memcards', bytes: 17300000 }] },
            { id: 'retroarch', name: 'RetroArch', bytes: 400000, paths: [{ path: '/home/e2e/.var/app/org.libretro.RetroArch/config/retroarch/saves', bytes: 400000 }] },
        ],
        backups: [{ name: 'launchers-launcher-saves-2026-09-24_210000.tar.zst', bytes: 6840871, mtimeMs: 1790276400000 }],
    },
    setSaveBackupDir: { ok: true, dir: '/home' },
    getGameDetails: {
        ok: true,
        launcher: { count: 3, totalMs: 5400000, lastLaunchedAt: '2026-09-20T10:00:00.000Z' },
        native: { playtimeMs: null, lastPlayedAt: 1758362400000, label: 'Steam' },
        file: null,
        cover: { override: null, suggestion: '/home/e2e/Pictures/launchers-launcher/covers/steam/1.png' },
    },
    listGamesRecent: ok([
        { key: 'steam-game-1', name: 'Portal 2', cover: null, kind: 'steam', params: { appid: '1' }, lastLaunchedAt: '2026-09-20T10:00:00.000Z' },
    ]),
    listRetroarchSystems: ok(RETRO_ALL.map((g) => ({ system: g.system, count: g.games.length }))),
    listRetroarchAllGames: ok(RETRO_ALL),
    listRetroarchGames: ok(RETRO_ALL[0].games.slice(0, 500)),
    // The shared `list-emulator-games` { source } — per source; the rest are empty.
    listEmulatorGames: ({ source } = {}) => ({
        pcsx2: ok(Array.from({ length: 30 }, (_, i) => ({ id: `SLUS-${i}`, name: `PS2 ${WORDS[i % WORDS.length]} ${i}`, path: `/ps2/${i}.iso`, serial: `SLUS-${i}`, cover: null }))),
        melonds: ok(Array.from({ length: 10 }, (_, i) => ({ id: `NDS${i}`, name: `DS ${WORDS[i]} ${i}`, path: `/nds/${i}.nds`, gamecode: `A${i}`, cover: null }))),
    }[source] || ok([])),
    listAudioSinks: ok([{ name: 'alsa_output.hdmi', description: 'HDMI / TV' }, { name: 'alsa_output.usb', description: 'USB headphones' }]),
    listMonitors: ok([
        { name: 'DP-3', label: 'DP-3 — 2560×1080', active: true, priority: 1 },
        { name: 'HDMI-A-1', label: 'HDMI-A-1 — 3840×2160', active: false, priority: 0 },
    ]),
    listBtDevices: ok([{ mac: 'AA:BB:CC:DD:EE:FF', name: 'DualSense', connected: true, battery: 80, type: 'dualsense' }]),
    listWifi: { ok: true, device: true, radio: true, items: [
        { ssid: 'Home', signal: 80, active: true, security: 'WPA2', secured: true, enterprise: false, saved: true },
        { ssid: 'Neighbor 5G', signal: 40, active: false, security: 'WPA2 WPA3', secured: true, enterprise: false, saved: false },
    ] },
    setWifiRadio: { ok: true },
    listLauncherCatalog: catalog.map((c) => ({ ...c, installed: true, active: LAUNCHER_IDS.includes(c.id), known: true })),
    findLauncherExecutables: { ok: true, guess: false, items: [{ path: '/opt/ryujinx/Ryujinx', name: 'Ryujinx' }] },
    setLauncherPath: { ok: true },
    listBackgrounds: { ok: true, builtin: [], custom: [] },
    listConfigBackups: ok([{ name: 'config.json.bak-2026-09-23', kind: 'daily', date: '2026-09-23', mtimeMs: 0, size: 2048 }]),
    listTvModeApps: ok([]),
    listIcons: ok([]),
    listInstalledApps: ok([
        { key: 'flatpak:org.foo.Bar', kind: 'flatpak', name: 'Bar Game', appId: 'org.foo.Bar', cmd: 'flatpak', args: ['run', 'org.foo.Bar'], icon: null, known: false },
        { key: 'desktop:firefox', kind: 'native', name: 'Firefox', desktopId: 'firefox', cmd: 'firefox', args: [], icon: null, known: false },
    ]),
    readLog: ok([
        { text: '[2026-09-24T10:00:00.000Z] start', level: 'info' },
        { text: '[2026-09-24T10:00:01.000Z] WARN TV power-on skipped', level: 'warn' },
        { text: '[2026-09-24T10:00:02.000Z] ERROR [renderer] boom', level: 'error' },
    ]),
    exportLog: { ok: true, file: '/home/e2e/launchers-launcher-log-2026-09-25_120000.txt', bytes: 100 },
    browseDir: { ok: true, path: '/home', parent: '/', dirs: [] },
    resolveComboPad: { ok: false, matched: false, mac: null },
};

module.exports = { INVOKE, launchers, RETRO_ALL, WORDS };
