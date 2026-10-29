'use strict';

// Shared fake `deps` of the launcher-list IPC modules (lib/ipc/launcher-manage-ipc.js + launcher-variant-ipc.js):
// a mocked `lib/launcher-list.js` (the pure `checkLauncherPayload`/`nativeCmdsOf` are the real ones),
// fake flatpak/config/log/sendToRenderer, and the caller-side launcher-list state (`seedRaw`).

const path = require('node:path');
const realLib = require('../../lib/launcher-list.js');
const { checkLauncherPayload } = realLib;

function fakeDeps(overrides = {}) {
    const customLaunchers = [];
    let orderIds = [];
    let launchersRaw = [];
    let launchers = [];
    const sent = [];
    const logs = [];
    const reloadCalls = [];
    let accents = {};

    const base = {
        sent, logs, customLaunchers, reloadCalls,
        launchersLib: {
            writeLauncherOrder: (ids) => { orderIds = ids; },
            readLauncherOrder: () => orderIds.slice(),
            orderLaunchers: (ids, raw) => {
                const byId = new Map(raw.map((l) => [l.id, l]));
                const out = ids.map((id) => byId.get(id)).filter(Boolean);
                for (const l of raw) if (!out.includes(l)) out.push(l);
                return out;
            },
            isAccentColor: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
            isLauncherInstalled: async (entry) => entry.id === 'steam',
            detectLauncherInstall: async (entry) => ({ installed: entry.id === 'steam', nativeCmd: null }),
            nativeCmdsOf: realLib.nativeCmdsOf,
            readLauncherPaths: () => ({}),
            isValidLauncher: (o) => !!o && typeof o.id === 'string' && typeof o.name === 'string'
                && typeof o.cmd === 'string' && Array.isArray(o.args),
            matchCatalogEntry: () => null,
            checkLauncherPayload, // the real (pure) check — this is what we test through the handler
            commandExists: async (cmd) => cmd === 'firefox' || cmd === '/opt/game/run.sh',
            readCustomLaunchers: () => customLaunchers.slice(),
            writeCustomLaunchers: (list) => { customLaunchers.length = 0; customLaunchers.push(...list); },
        },
        flatpak: {
            listInstalledFlatpakApps: async () => [{ appId: 'org.foo.Bar', name: 'Bar' }],
            flatpakRunAppId: (args) => (Array.isArray(args) && args[args.indexOf('run') + 1]) || null,
            runFlatpak: async () => ({ code: 0, out: '' }),
            flatpakErrorLine: () => 'bad output',
            FLATPAK_REMOTE_TIMEOUT_MS: 1000,
            FLATPAK_INSTALL_TIMEOUT_MS: 1000,
        },
        launcherCatalog: [
            { id: 'steam', name: 'Steam', hint: '', icon: '', cmd: 'steam', args: [], accent: '#112233' },
            {
                id: 'heroic', name: 'Heroic', hint: '', icon: '', cmd: 'flatpak',
                args: ['run', 'com.heroicgameslauncher.hgl'], flathubId: 'com.heroicgameslauncher.hgl',
            },
        ],
        config: {
            get: (key, fallback) => (key === 'launcherAccents' ? accents : fallback),
            set: (key, value) => { if (key === 'launcherAccents') accents = { ...value }; },
        },
        log: (msg) => logs.push(msg),
        sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
        repoRoot: path.join(__dirname, '..', '..'),
        getLaunchersRaw: () => launchersRaw,
        setLaunchers: (list) => { launchers = list; },
        reloadLaunchers: () => {
            reloadCalls.push(true);
            launchersRaw = customLaunchers.slice();
            launchers = customLaunchers.slice();
        },
        launchersPayload: () => launchers,
        // test helpers (not `deps` fields, read before the create call)
        seedRaw: (list) => { launchersRaw = list; launchers = list; },
        getLaunchersState: () => ({ raw: launchersRaw, launchers }),
    };
    return { ...base, ...overrides };
}

module.exports = { fakeDeps };
