// @ts-check
'use strict';

// SETTINGS of the game sources: the custom ROM-folder sources (`customGameSources`), the manual melonDS ROM folders
// (`melondsRomDirs` + the flatpak sandbox override), and the generic folder browser (`browse-dir` — for the ROM folder /
// backup target / manual launcher folder pickers). Loading the lists stays in games-ipc; after a source change
// `invalidateGameSource(id)` clears the matching cache. Plus the sandbox visibility of the flatpak emulators' ROM folders
// (`get-rom-access` — informational only).

const os = require('os');
const customRoms = require('../launchers/custom-roms-library.js');
const dirBrowse = require('../dir-browse.js');
const { createRomAccessChecker } = require('../launchers/rom-access.js');
const { createFlatpakGrants } = require('../launchers/flatpak-grants.js');
const { requireDeps } = require('./require-deps.js');
const { str, plainObject, flatpakAppId, PATH_MAX } = require('../validate.js');

/**
 * @param {Object} deps
 * @param {Object} deps.config
 * @param {(msg: string) => void} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {Record<string, any>} deps.emulatorSources descriptor of the registry emulators (melonDS library)
 * @param {(id: string) => void} deps.invalidateGameSource the games-ipc source cache invalidator
 * @param {() => Array<{ id: string }>} [deps.getLaunchers] the added launchers (a custom ROM source can only be
 *   assigned to an existing launcher; the ROM access check looks at the flatpak-variant ones)
 * @param {Record<string, any>} deps.workerScans the worker-scan TTL caches (`romDirs` — the ROM folders + realpath)
 * @param {(appId: string) => Promise<string[]|null>} [deps.readFlatpakFilesystems] for tests
 * @param {(file: string, args: string[], opts?: any) => Promise<any>} [deps.exec] for the `flatpak override` call (tests)
 */
function createGameSourcesHandlers(deps) {
    const {
        config, log, sendToRenderer, emulatorSources, invalidateGameSource, workerScans,
        getLaunchers = () => [], readFlatpakFilesystems, exec,
    } = deps;
    requireDeps(deps, ['config', 'log', 'sendToRenderer', 'emulatorSources', 'invalidateGameSource', 'workerScans'], 'createGameSourcesHandlers');

    const romAccess = createRomAccessChecker({
        emulatorSources, getLaunchers, log,
        loadRomDirs: (id, args) => workerScans.romDirs(id, ...args),
        invalidateRomDirs: () => workerScans.romDirs.invalidate(),
        ...(readFlatpakFilesystems ? { readFilesystems: readFlatpakFilesystems } : {}),
    });

    // Record of the flatpak permissions granted by the launcher (`flatpakGrants`) — the confirmed
    // "Grant access" and the automatic melonDS override.
    const grants = createFlatpakGrants({ config, log, ...(exec ? { exec } : {}) });
    const melondsAppId = () => {
        const lib = emulatorSources.melonds && emulatorSources.melonds.library;
        return lib && lib.MELONDS_FLATPAK_ID;
    };
    try {
        const id = melondsAppId();
        if (id) grants.adoptExisting(id, config.get('melondsRomDirs', []));
    } catch (err) {
        log(`flatpakGrants bookkeeping error: ${err.message}`);
    }

    // `{ ok, items: [{ appId, path, at }] }` — the permissions granted by the launcher.
    function listRomGrants() {
        return { ok: true, items: grants.list() };
    }

    // `{ appId, dir }` → grant access. ONLY for an (app, folder) pair the fresh check now reports as "not visible" —
    // the renderer cannot request an arbitrary folder. `{ ok, reason? }`.
    async function grantRomAccess(payload) {
        if (!plainObject(payload)) return { ok: false, reason: 'invalid request' };
        const appId = flatpakAppId(payload.appId);
        const dir = str(payload.dir, PATH_MAX);
        if (!appId || !dir) return { ok: false, reason: 'invalid request' };
        const check = await romAccess.check({ refresh: true });
        if (!check.ok || !check.items.some((it) => it.appId === appId && it.dir === dir && !it.visible)) {
            return { ok: false, reason: 'the folder is not among the folders the sandbox cannot see' };
        }
        const res = await grants.grant(appId, dir);
        romAccess.invalidate();
        return res;
    }

    // `{ appId, dir }` → revoke a permission granted by the launcher. `{ ok, reason? }`.
    async function revokeRomAccess(payload) {
        if (!plainObject(payload)) return { ok: false, reason: 'invalid request' };
        const appId = flatpakAppId(payload.appId);
        const dir = str(payload.dir, PATH_MAX);
        if (!appId || !dir) return { ok: false, reason: 'invalid request' };
        const res = await grants.revoke(appId, dir);
        romAccess.invalidate();
        return res;
    }

    // `{ refresh? }` → `{ ok, items: [{ source, name, appId, dir, visible }] }` (only the added flatpak emulators).
    function getRomAccess(payload) {
        return romAccess.check({ refresh: !!(payload && payload.refresh) });
    }

    function getCustomGameSources() {
        return { ok: true, sources: customRoms.readCustomGameSources(config) };
    }

    // `{ launcherId, dirs, exts, argsTemplate }` → save (normalized); `{ launcherId, remove: true }` → delete.
    // The launcher must exist. `{ ok, sources, reason? }`.
    function setCustomGameSource(payload) {
        if (!plainObject(payload)) return { ok: false, reason: 'invalid request', sources: customRoms.readCustomGameSources(config) };
        const launcherId = str(payload.launcherId);
        if (!launcherId || !getLaunchers().some((l) => l.id === launcherId)) return { ok: false, reason: 'unknown launcher', sources: customRoms.readCustomGameSources(config) };
        const rest = customRoms.readCustomGameSources(config).filter((s) => s.launcherId !== launcherId);
        let next = rest;
        if (!payload.remove) {
            const src = customRoms.normalizeCustomGameSource(payload);
            if (!src) return { ok: false, reason: 'invalid folder / extension', sources: customRoms.readCustomGameSources(config) };
            next = [...rest, src];
        }
        try {
            config.set('customGameSources', next);
        } catch (err) {
            log(`customGameSources save error: ${err.message}`);
            return { ok: false, reason: err.message, sources: customRoms.readCustomGameSources(config) };
        }
        invalidateGameSource('custom');
        log(`Custom ROM source ${payload.remove ? 'removed' : 'saved'}: ${launcherId}`);
        return { ok: true, sources: next };
    }

    function getMelondsRomDirs() {
        return config.get('melondsRomDirs', []);
    }

    // The flatpak sandbox override chain lives in `syncFlatpakOverrides` of `lib/launchers/melonds-library.js`
    // (the gotcha of ROM folders outside $HOME, see there).
    function setMelondsRomDirs(dirs) {
        try {
            const prev = config.get('melondsRomDirs', []);
            const next = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d) : [];
            config.set('melondsRomDirs', next);
            romAccess.invalidate();
            emulatorSources.melonds.library.syncFlatpakOverrides(prev, next, { log })
                .then(() => {
                    // The melonDS override is also booked into the record (revocable in the ROM-folder permissions view).
                    const id = melondsAppId();
                    const home = os.homedir();
                    const outside = (d) => d !== home && !d.startsWith(`${home}/`);
                    if (id) {
                        for (const d of next.filter(outside)) grants.record(id, d);
                        for (const d of prev.filter((x) => outside(x) && !next.includes(x))) grants.forget(id, d);
                    }
                    romAccess.invalidate(); // the override changes the permission too
                })
                .catch((err) => log(`melonDS flatpak sandbox sync error: ${err.message}`));
            sendToRenderer('melonds-rom-dirs-changed', { dirs: next, ok: true });
        } catch (err) {
            log(`melondsRomDirs save error: ${err.message}`);
            sendToRenderer('melonds-rom-dirs-changed', { dirs: config.get('melondsRomDirs', []), ok: false });
        }
    }

    // Generic folder browser. Nonexistent / unreadable folder → `ok: false`, does not throw.
    function browseDir(dirPath) {
        const target = typeof dirPath === 'string' && dirPath ? dirPath : os.homedir();
        try {
            return { ok: true, ...dirBrowse.listSubdirs(target) };
        } catch (err) {
            log(`browse-dir error (${target}): ${err.message}`);
            return { ok: false, path: target, parent: null, dirs: [] };
        }
    }

    return { getCustomGameSources, setCustomGameSource, getMelondsRomDirs, setMelondsRomDirs, browseDir, getRomAccess, listRomGrants, grantRomAccess, revokeRomAccess };
}

/**
 * @param {Parameters<typeof createGameSourcesHandlers>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerGameSourcesIpc(deps) {
    const { ipcMain } = deps;
    requireDeps(deps, ['ipcMain'], 'registerGameSourcesIpc');
    const h = createGameSourcesHandlers(deps);
    ipcMain.handle('get-custom-game-sources', () => h.getCustomGameSources());
    ipcMain.handle('set-custom-game-source', (event, payload) => h.setCustomGameSource(payload));
    ipcMain.handle('get-melonds-rom-dirs', () => h.getMelondsRomDirs());
    ipcMain.on('set-melonds-rom-dirs', (event, dirs) => h.setMelondsRomDirs(dirs));
    ipcMain.handle('browse-dir', (event, dirPath) => h.browseDir(dirPath));
    ipcMain.handle('get-rom-access', (event, payload) => h.getRomAccess(payload));
    ipcMain.handle('list-rom-grants', () => h.listRomGrants());
    ipcMain.handle('grant-rom-access', (event, payload) => h.grantRomAccess(payload));
    ipcMain.handle('revoke-rom-access', (event, payload) => h.revokeRomAccess(payload));
    return h;
}

module.exports = { createGameSourcesHandlers, registerGameSourcesIpc };
