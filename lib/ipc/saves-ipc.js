// @ts-check
'use strict';

// IPC handlers of the "Save backups" subview: target folder (`saveBackup.dir`, default `~/launchers-launcher-saves`) and the
// "one backup at a time" guard; discovery is `lib/saves/save-sources.js`, archiving is `save-backup.js`. The result is the
// `save-backup-done` push. `lib/saves/*` loads LAZILY (on first call): `save-sources.js` loads every emulator library module,
// which cost ~16–20 ms on the critical startup path. Background: docs/dev/launchers/README.md#save-backup

const fsp = require('fs/promises');
const path = require('path');
const { requireDeps } = require('./require-deps.js');
const { str, plainObject, oneOf } = require('../validate.js');
const {
    SAVE_AUTO_AFTER_GAME_MIN_MS, SAVE_AUTO_DAILY_MIN_MS, SAVE_AUTO_STARTUP_DELAY_MS, SAVE_AUTO_AFTER_GAME_DELAY_MS,
} = require('../timings.js');

/** Automatic backup modes (`saveBackup.auto`): off / after a game (≥ 1 hour apart) / daily (at startup + after a game, ≥ 24 hours). */
const AUTO_MODES = ['off', 'afterGame', 'daily'];

/**
 * @param {Object} deps
 * @param {{ get: (key: string, fallback?: any) => any, patch: (key: string, partial: Object) => void }} deps.config
 * @param {(msg: string) => void} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {string} [deps.version] the launcher version (into the manifest)
 * @param {() => boolean} [deps.isGameActive] is a game starting/running (no restore meanwhile)
 * @param {typeof import('../saves/save-sources.js')} [deps.saveSources] overridable for tests
 * @param {typeof import('../saves/save-backup.js')} [deps.saveBackup] overridable for tests
 */
function createSavesHandlers(deps) {
    const {
        config, log, sendToRenderer, version = '', saveSources: sourcesOverride = null, saveBackup: backupOverride = null,
        isGameActive = () => false,
    } = deps;
    requireDeps(deps, ['config', 'log', 'sendToRenderer'], 'createSavesHandlers');
    let running = false;
    /** @type {typeof import('../saves/save-sources.js')} */
    let sourcesLib = sourcesOverride;
    /** @type {typeof import('../saves/save-backup.js')} */
    let backupLib = backupOverride;
    const saveSources = () => sourcesLib || (sourcesLib = require('../saves/save-sources.js'));
    const saveBackup = () => backupLib || (backupLib = require('../saves/save-backup.js'));

    function backupDir() {
        const cfg = config.get('saveBackup', {});
        return cfg && typeof cfg.dir === 'string' && cfg.dir ? cfg.dir : saveBackup().defaultSaveBackupDir();
    }

    function autoMode() {
        const cfg = config.get('saveBackup', {});
        return AUTO_MODES.includes(cfg && cfg.auto) ? cfg.auto : 'off';
    }

    // Switching the automatic mode (`saveBackup.auto`); invalid value → rejected.
    function setSaveBackupAuto(mode) {
        const m = oneOf(mode, AUTO_MODES);
        if (!m) return { ok: false };
        config.patch('saveBackup', { auto: m });
        return { ok: true, auto: m };
    }

    function detect() {
        return saveSources().detectSaveSources({ melondsRomDirs: config.get('melondsRomDirs', []) });
    }

    async function getSaveBackupState() {
        try {
            const dir = backupDir();
            const [sources, backups, compressor] = await Promise.all([
                detect(), saveBackup().listSaveBackups(dir), saveBackup().detectCompressor(),
            ]);
            return {
                ok: true, dir, isDefaultDir: dir === saveBackup().defaultSaveBackupDir(), running, compressor, auto: autoMode(),
                keep: saveBackup().SAVE_BACKUP_KEEP, sources,
                backups: backups.map(({ name, bytes, mtimeMs }) => ({ name, bytes, mtimeMs })),
            };
        } catch (err) {
            log(`Save status query error: ${err.message}`);
            return { ok: false };
        }
    }

    // The target folder: only an existing, absolute folder (the browser/manual entry gives such).
    async function setSaveBackupDir(dir) {
        if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false };
        try {
            if (!(await fsp.stat(dir)).isDirectory()) return { ok: false };
        } catch {
            return { ok: false };
        }
        config.patch('saveBackup', { dir });
        return { ok: true, dir };
    }

    async function runSaveBackup(opts = {}) {
        if (running) return;
        running = true;
        let result;
        try {
            const [sources, compressor] = await Promise.all([detect(), saveBackup().detectCompressor()]);
            result = await saveBackup().createSaveBackup({ destDir: backupDir(), sources, compressor, version });
            log(result.ok
                ? `Save backup: ${result.file} (${result.bytes} B, ${result.sources} sources)`
                : `Save backup error: ${result.error}`);
        } catch (err) {
            result = { ok: false, error: err.message };
            log(`Save backup error: ${err.message}`);
        } finally {
            running = false;
        }
        sendToRenderer('save-backup-done', opts.auto ? { ...result, auto: true } : result);
    }

    // Automatic backup: `trigger` = 'startup' (the startup attempt) | 'afterGame' (end of a game session). In 'afterGame'
    // mode only the session end counts, in 'daily' both; if the latest backup is younger than the limit → skipped. Never
    // throws; nothing to back up → skipped silently.
    async function autoBackup(trigger) {
        try {
            const mode = autoMode();
            if (mode === 'off' || running || isGameActive()) return;
            if (mode === 'afterGame' && trigger !== 'afterGame') return;
            const minAge = mode === 'daily' ? SAVE_AUTO_DAILY_MIN_MS : SAVE_AUTO_AFTER_GAME_MIN_MS;
            const [newest] = await saveBackup().listSaveBackups(backupDir());
            if (newest && Date.now() - newest.mtimeMs < minAge) return;
            if (!(await detect()).length) return;
            log(`Automatic save backup (${mode}, ${trigger})`);
            await runSaveBackup({ auto: true });
        } catch (err) {
            log(`Automatic save backup error: ${err.message}`);
        }
    }

    // After a game session ends, with a small delay (the load must not coincide with the picture switch after the launcher returns).
    function autoBackupAfterGame() {
        if (autoMode() === 'off') return;
        setTimeout(() => { autoBackup('afterGame').catch(() => { }); }, SAVE_AUTO_AFTER_GAME_DELAY_MS).unref();
    }

    // The (delayed) attempt after startup — main calls it once; tests do NOT call it.
    function scheduleStartupBackup() {
        setTimeout(() => { autoBackup('startup').catch(() => { }); }, SAVE_AUTO_STARTUP_DELAY_MS).unref();
    }

    // Content of an archive (for the restore picker): `{ ok, createdAt, sources: [{ id, name }] }`.
    async function getSaveBackupContents(name) {
        const lib = saveBackup();
        if (!lib.isBackupName(name)) return { ok: false };
        const manifest = await lib.readBackupManifest(path.join(backupDir(), name));
        if (!manifest) return { ok: false };
        return { ok: true, createdAt: manifest.createdAt, sources: manifest.sources.map(({ id, name: n }) => ({ id, name: n })) };
    }

    // Restore: `{ name, sourceId }` (`sourceId` = one source or 'all'). Safeguards: cannot run together with a backup /
    // game; before it a safety backup of the CURRENT state (aborts if that fails); only paths under `$HOME` listed in the
    // archive's manifest are written. Ends with a `save-restore-done` push.
    async function restoreSaveBackup(payload) {
        let result;
        if (!plainObject(payload)) { sendToRenderer('save-restore-done', { ok: false, error: 'invalid' }); return; }
        const name = str(payload.name, 200);
        const sourceId = str(payload.sourceId, 100);
        if (running) { sendToRenderer('save-restore-done', { ok: false, error: 'busy' }); return; }
        if (isGameActive()) { sendToRenderer('save-restore-done', { ok: false, error: 'game-running' }); return; }
        running = true;
        try {
            const lib = saveBackup();
            if (!name || !sourceId || !lib.isBackupName(name)) throw new Error('invalid');
            const file = path.join(backupDir(), name);
            const manifest = await lib.readBackupManifest(file);
            if (!manifest) throw new Error('manifest');
            // Safety backup of the current state (does not prune old ones: the archive to restore must not disappear either).
            const [sources, compressor] = await Promise.all([detect(), lib.detectCompressor()]);
            if (sources.length) {
                const safety = await lib.createSaveBackup({
                    destDir: backupDir(), sources, compressor, version, keep: Number.MAX_SAFE_INTEGER,
                });
                if (!safety.ok) throw new Error(`safety-backup: ${safety.error}`);
            }
            const res = await lib.restoreSaveBackup({ file, sourceId, manifest });
            result = { ...res, name, sourceId };
            log(res.ok ? `Save restored: ${name} (${sourceId})` : `Save restore error: ${res.error}`);
        } catch (err) {
            result = { ok: false, error: err.message, name, sourceId };
            log(`Save restore error: ${err.message}`);
        } finally {
            running = false;
        }
        sendToRenderer('save-restore-done', result);
    }

    return {
        getSaveBackupState, setSaveBackupDir, setSaveBackupAuto, runSaveBackup, autoBackup, autoBackupAfterGame,
        scheduleStartupBackup, getSaveBackupContents, restoreSaveBackup, isRunning: () => running,
    };
}

/**
 * @param {Parameters<typeof createSavesHandlers>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerSavesIpc(deps) {
    const { ipcMain } = deps;
    requireDeps(deps, ['ipcMain'], 'registerSavesIpc');
    const h = createSavesHandlers(deps);
    ipcMain.handle('get-save-backup-state', () => h.getSaveBackupState());
    ipcMain.handle('set-save-backup-dir', (event, dir) => h.setSaveBackupDir(dir));
    ipcMain.handle('set-save-backup-auto', (event, mode) => h.setSaveBackupAuto(mode));
    ipcMain.on('run-save-backup', () => { h.runSaveBackup().catch(() => { }); });
    ipcMain.handle('get-save-backup-contents', (event, name) => h.getSaveBackupContents(name));
    ipcMain.on('restore-save-backup', (event, payload) => { h.restoreSaveBackup(payload).catch(() => { }); });
    return h;
}

module.exports = { createSavesHandlers, registerSavesIpc };
