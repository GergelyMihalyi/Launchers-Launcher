// @ts-check
'use strict';

// IPC of the Settings → System "Update", "Restore settings" and the "What's new" panel. The git/npm chain is
// `lib/update/self-update.js`, the backups `lib/config.js`, the CHANGELOG section `lib/update/changelog.js`. The relaunch
// after a successful update / restore is the caller's `relaunch(reason)` (cleanup + `app.relaunch()` + `app.exit(0)` — in
// ONE place because of the watcher's exit-code convention).

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const transfer = require('../config-transfer.js');
const selfUpdate = require('../update/self-update.js');
const { requireDeps } = require('./require-deps.js');

/**
 * @param {Object} deps
 * @param {import('../types.js').IpcMainLike} deps.ipcMain
 * @param {(msg: string) => void} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {(label: string, fn: () => Promise<any>) => Promise<{ ok: boolean, items: any[] }>} deps.safeList
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void,
 *   listBackups: () => any[], restoreBackup: (name: string) => { ok: boolean, error?: string } }} deps.config
 * @param {string} deps.repoRoot the repo root (git/npm cwd, CHANGELOG.md)
 * @param {(reason: string) => void} deps.relaunch
 * @param {string} [deps.version] the launcher version (into the export file)
 */
function registerUpdateIpc(deps) {
    const { ipcMain, log, sendToRenderer, safeList, config, repoRoot, relaunch } = deps;
    requireDeps(deps, ['ipcMain', 'log', 'sendToRenderer', 'safeList', 'config', 'repoRoot', 'relaunch'], 'registerUpdateIpc');
    // --- Self-update ---
    ipcMain.handle('check-update', () => selfUpdate.checkForUpdate(repoRoot, log));
    // Dependency hygiene: `npm outdated` + `npm audit` — informational only.
    ipcMain.handle('check-dependencies', () => require('../update/dep-health.js').checkDependencyHealth(repoRoot));
    ipcMain.on('apply-update', async () => {
        const result = await selfUpdate.applyUpdate(repoRoot, {
            log,
            onProgress: (phase) => sendToRenderer('apply-update-progress', { phase }),
        });
        if (!result.ok) {
            sendToRenderer('update-failed', { message: result.message });
            return;
        }
        relaunch('apply-update: siker -> relaunch');
    });

    // --- Restore settings ---
    ipcMain.handle('list-config-backups', () => safeList('config backup list error', async () => config.listBackups()));
    ipcMain.on('restore-config-backup', (event, name) => {
        const result = config.restoreBackup(name);
        if (!result.ok) {
            log(`restore-config-backup: ${name} — ${result.error}`);
            sendToRenderer('config-restore-failed', { message: result.error });
            return;
        }
        relaunch(`restore-config-backup: ${name} restored -> relaunch`);
    });

    // --- Settings transfer (lib/config-transfer.js): export into `~/launchers-launcher-settings-<date>.json`, import from such a
    // file. The file list only returns the DIRECT files of the home folder matching the name pattern; import accepts a name from
    // the list (no path traversal), writes the whitelisted keys, and relaunches. ---
    const transferDir = () => os.homedir();

    ipcMain.handle('export-settings', async () => {
        try {
            const name = transfer.exportFileName();
            const file = path.join(transferDir(), name);
            await fsp.writeFile(file, transfer.exportPortableSettings(config, { version: deps.version || '' }), { mode: 0o600 });
            log(`Settings exported: ${file}`);
            return { ok: true, name, dir: transferDir() };
        } catch (err) {
            log(`Settings export error: ${err.message}`);
            return { ok: false };
        }
    });

    ipcMain.handle('list-settings-exports', () => safeList('settings export list error', async () => {
        const names = (await fsp.readdir(transferDir())).filter((n) => transfer.FILE_NAME_RE.test(n));
        const out = [];
        for (const name of names) {
            try {
                const st = await fsp.stat(path.join(transferDir(), name));
                if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
            } catch { /* deleted meanwhile */ }
        }
        return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }));

    ipcMain.on('import-settings', async (event, name) => {
        try {
            if (typeof name !== 'string' || !transfer.FILE_NAME_RE.test(name)) throw new Error('unknown file');
            const parsed = transfer.parsePortableSettings(await fsp.readFile(path.join(transferDir(), name), 'utf8'));
            if (!parsed.ok) throw new Error(parsed.error);
            const res = transfer.applyPortableSettings(config, parsed.settings || {});
            log(`Settings imported: ${name} — ${res.applied.length} key(s)${res.skipped.length ? `, skipped: ${res.skipped.join(', ')}` : ''}${parsed.ignored && parsed.ignored.length ? `, not transferable: ${parsed.ignored.join(', ')}` : ''}`);
            relaunch(`import-settings: ${name} -> relaunch`);
        } catch (err) {
            log(`Settings import error: ${err.message}`);
            sendToRenderer('settings-import-failed', { message: err.message });
        }
    });

    // --- "What's new": the `pendingChangelog` marker (written by apply-update) + the latest CHANGELOG.md section;
    // `pending: false` → no panel. ---
    ipcMain.handle('get-changelog', async () => {
        const pending = config.get('pendingChangelog', null);
        let section = { heading: '', lines: [] };
        try {
            const md = await fsp.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
            section = require('../update/changelog.js').parseLatestSection(md);
        } catch (err) {
            log(`get-changelog: CHANGELOG.md read error: ${err.message}`);
        }
        return { pending: typeof pending === 'string' && pending.length > 0, ...section };
    });
    ipcMain.on('dismiss-changelog', () => {
        try { config.set('pendingChangelog', ''); } catch (err) { log(`dismiss-changelog error: ${err.message}`); }
    });
}

module.exports = { registerUpdateIpc };
