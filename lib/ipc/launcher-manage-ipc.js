// @ts-check
'use strict';

// Bodies of the launcher-list maintenance IPC handlers: list query (`get-launchers`), order + accent color, the catalog, the
// installed-app list of the "+ Add launcher" wizard, the icon list, add/remove (catalog id OR a full object) and the in-app flatpak
// install. The native ↔ flatpak variant + the manual path live in `launcher-variant-ipc.js`. The module does not know Electron; the
// caller passes `repoRoot`. The `launchers`/`launchersRaw` state belongs to `main.js`: a `getLaunchersRaw()` getter + `setLaunchers(list)`
// setter + `reloadLaunchers()` callback come in. Background: docs/dev/launching.md#launch-handlers-and-argument-builders

const fs = require('fs');
const path = require('path');
const defaultDesktopEntries = require('../apps/desktop-entries.js');
const defaultAppIcons = require('../apps/app-icons.js');
const { buildInstalledAppItems } = require('../apps/installed-apps.js');
const { requireDeps } = require('./require-deps.js');
const { LAUNCHER_REMOVE_UNDO_MS } = require('../timings.js');

/**
 * @param {object} deps
 * @param {object} deps.launchersLib
 * @param {object} deps.flatpak `lib/flatpak.js` (list/run/error line + the install timeouts)
 * @param {Array<object>} deps.launcherCatalog
 * @param {object} deps.config
 * @param {((msg: string) => void) & { warn?: (msg: string) => void }} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {string} deps.repoRoot
 * @param {() => Array<object>} deps.getLaunchersRaw
 * @param {(list: Array<object>) => void} deps.setLaunchers
 * @param {() => void} deps.reloadLaunchers
 * @param {() => any} deps.launchersPayload
 * @param {{ listDesktopApps: () => Promise<any[]> }} [deps.desktopEntries] `lib/apps/desktop-entries.js` (tests: fake)
 * @param {typeof defaultAppIcons} [deps.appIcons] `lib/apps/app-icons.js` (tests: fake roots)
 * @param {number} [deps.undoMs] the undo window (default: `LAUNCHER_REMOVE_UNDO_MS`; tests: short)
 */
function createLauncherManageHandlers(deps) {
    const {
        launchersLib, flatpak, launcherCatalog, config, log, sendToRenderer, repoRoot,
        getLaunchersRaw, setLaunchers, reloadLaunchers, launchersPayload,
        desktopEntries = defaultDesktopEntries, appIcons = defaultAppIcons,
        undoMs = LAUNCHER_REMOVE_UNDO_MS,
    } = deps;
    requireDeps(deps, ['launchersLib', 'flatpak', 'launcherCatalog', 'config', 'log', 'sendToRenderer', 'repoRoot', 'getLaunchersRaw', 'setLaunchers', 'reloadLaunchers', 'launchersPayload'], 'createLauncherManageHandlers');
    // The tests' fake `log` is a plain function; in production the `createLogger` `.warn` marks the line.
    const warn = (msg) => (typeof log.warn === 'function' ? log.warn(msg) : log(msg));

    function setLauncherOrder(ids) {
        try {
            const launchersRaw = getLaunchersRaw();
            const known = new Set(launchersRaw.map((l) => l.id));
            const seen = new Set();
            const valid = (Array.isArray(ids) ? ids : []).filter((id) => {
                if (!known.has(id) || seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            launchersLib.writeLauncherOrder(valid);
            setLaunchers(launchersLib.orderLaunchers(valid, launchersRaw));
        } catch (err) {
            log(`Launcher order save error: ${err.message}`);
        }
        sendToRenderer('launchers-changed', launchersPayload());
    }

    // Per-launcher accent override. `{ id, accent }` — `accent` is `#rrggbb` OR null/'' (clear → back to the default).
    function setLauncherAccent(payload) {
        const { id, accent } = payload || {};
        if (!id || !getLaunchersRaw().some((l) => l.id === id)) {
            log(`set-launcher-accent: unknown launcher id: ${id}`);
            return;
        }
        try {
            const map = { ...(config.get('launcherAccents', {}) || {}) };
            if (launchersLib.isAccentColor(accent)) map[id] = accent;
            else delete map[id];
            config.set('launcherAccents', map);
            reloadLaunchers();
        } catch (err) {
            log(`set-launcher-accent save error: ${err.message}`);
        }
        sendToRenderer('launchers-changed', launchersPayload());
    }

    // The "Installed application" list of the "+ Add launcher" wizard: installed flatpak apps (`flatpak list`) + native
    // `.desktop` entries (lib/apps/desktop-entries.js) — discovery here, merging in the pure `buildInstalledAppItems` of
    // lib/apps/installed-apps.js. `{ ok, items }` (the query-wrapper pattern).
    async function listInstalledApps() {
        try {
            const [flatpaks, natives, index] = await Promise.all([
                flatpak.listInstalledFlatpakApps().catch(() => []),
                desktopEntries.listDesktopApps().catch(() => []),
                appIcons.buildIconIndex().catch(() => new Map()),
            ]);
            const items = buildInstalledAppItems({
                flatpaks, natives, catalog: launcherCatalog, launchers: getLaunchersRaw(),
                resolveIcon: (name) => appIcons.resolveIconFile(name, index),
            });
            return { ok: true, items };
        } catch (err) {
            log(`list-installed-apps error: ${err.message}`);
            return { ok: false, items: [] };
        }
    }

    // For a dual-variant entry `nativeCmd` is the binary FOUND (from the candidate list — the renderer adds the native
    // variant with it), `nativeCmds` the full candidate list (to recognize the added launcher's variant).
    async function listLauncherCatalog() {
        const activeIds = new Set(getLaunchersRaw().map((l) => l.id));
        const manualPaths = launchersLib.readLauncherPaths();
        const checks = await Promise.allSettled(launcherCatalog.map((e) => launchersLib.detectLauncherInstall(e)));
        return launcherCatalog.map((e, i) => {
            const res = checks[i].status === 'fulfilled' ? checks[i].value : null;
            const nativeCmds = launchersLib.nativeCmdsOf(e);
            return {
                ...e,
                ...(nativeCmds.length ? { nativeCmd: (res && res.nativeCmd) || nativeCmds[0], nativeCmds } : {}),
                active: activeIds.has(e.id),
                installed: res ? res.installed : null,
                manualPath: manualPaths[e.id] || null,
            };
        });
    }

    // Files of the assets/icons/ folder for the icon picker. Relative path (like the `icon` field of
    // data/launcher-catalog.json). Best effort — empty list on error.
    function listIcons() {
        try {
            return fs.readdirSync(path.join(repoRoot, 'assets', 'icons'))
                .filter((f) => /\.(png|svg)$/i.test(f))
                .sort()
                .map((f) => `assets/icons/${f}`);
        } catch (err) {
            log(`list-icons error: ${err.message}`);
            return [];
        }
    }

    // Appends a launcher entry (catalog `id` OR a full object) to `customLaunchers` + `reloadLaunchers()` +
    // `launchers-changed`. Called by the `add-launcher` IPC AND the success branch of `installFlatpak`. Catalog id → sync
    // save. Object payload → `checkLauncherPayload` (security: the renderer must not add an arbitrary command, see the comment
    // in `lib/launcher-list.js`); the "Custom command" (`custom`) branch only saves if the command exists — that is async, so
    // it returns a Promise then. On rejection an `app-error` toast.
    function addLauncher(payload) {
        if (typeof payload === 'string') {
            const entry = launcherCatalog.find((e) => e.id === payload) || null;
            if (!entry) {
                log(`add-launcher: unknown catalog id: ${JSON.stringify(payload)}`);
                return undefined;
            }
            saveLauncherEntry(entry);
            return undefined;
        }
        const check = launchersLib.checkLauncherPayload(payload, launcherCatalog);
        if (!check.ok) {
            rejectAddLauncher(payload, check.reason, 'err.launcherRejected');
            return undefined;
        }
        // The wizard sends the installed app's icon file (`iconFile`) — it is copied into the launcher's own icon
        // folder (lib/apps/app-icons.js), the entry gets the `file://` URL.
        if (payload.iconFile && !check.entry.icon) {
            const imported = appIcons.importLauncherIcon(payload.iconFile, check.entry.id);
            if (imported.ok) check.entry.icon = imported.url;
            else log(`add-launcher: icon import skipped (${imported.reason}): ${payload.iconFile}`);
        }
        if (check.kind === 'flatpak') {
            // Manually added / browsed flatpak launcher — if the appid is in the catalog, take its nicer metadata AND the
            // catalog id (instead of the wizard's `flatpak-<appid>` id — so the catalog row counts as "added", the
            // native ↔ flatpak switch works, and no second card is created for the same app).
            const match = launchersLib.matchCatalogEntry(check.entry, launcherCatalog);
            // The catalog's built-in icon takes precedence over the imported one (which is deleted then).
            const icon = (match && match.icon) || check.entry.icon;
            saveLauncherEntry(match ? { ...match, id: match.id, args: check.entry.args, icon } : check.entry);
            if (icon !== check.entry.icon) appIcons.removeUserIcon(check.entry.icon);
            return undefined;
        }
        if (check.kind === 'native') {
            // Native binary of a catalog program (e.g. from the wizard's "Installed application" list, with a
            // `custom-<name>` id) → the catalog entry's id + metadata, like the flatpak branch.
            const cat = launcherCatalog.find((c) => launchersLib.nativeCmdsOf(c).includes(check.entry.cmd));
            if (cat && cat.id !== check.entry.id) {
                const icon = cat.icon || check.entry.icon;
                saveLauncherEntry({ ...cat, id: cat.id, cmd: check.entry.cmd, args: check.entry.args, icon });
                if (icon !== check.entry.icon) appIcons.removeUserIcon(check.entry.icon);
                return undefined;
            }
            saveLauncherEntry(check.entry);
            return undefined;
        }
        return launchersLib.commandExists(check.entry.cmd).then((exists) => {
            if (!exists) {
                appIcons.removeUserIcon(check.entry.icon);
                rejectAddLauncher(payload, `the command was not found: ${check.entry.cmd}`, 'err.launcherNotFound');
                return;
            }
            warn(`add-launcher: custom command added: ${check.entry.cmd} ${check.entry.args.join(' ')}`);
            saveLauncherEntry(check.entry);
        });
    }

    function rejectAddLauncher(payload, reason, errorKey) {
        warn(`add-launcher rejected (${reason}): ${JSON.stringify(payload)}`);
        sendToRenderer('app-error', {
            appId: 'add-launcher', error: `Cannot add the launcher: ${reason}`, errorKey,
            params: { cmd: String((payload && payload.cmd) || '') },
        });
    }

    function saveLauncherEntry(entry) {
        try {
            const custom = launchersLib.readCustomLaunchers();
            if (!custom.some((l) => l.id === entry.id)) {
                custom.push({
                    id: entry.id, name: entry.name, hint: entry.hint || '', icon: entry.icon || '',
                    cmd: entry.cmd, args: entry.args, custom: true,
                    ...(launchersLib.isAccentColor(entry.accent) ? { accent: entry.accent } : {}),
                });
                launchersLib.writeCustomLaunchers(custom);
            }
            reloadLaunchers();
        } catch (err) {
            log(`add-launcher save error: ${err.message}`);
        }
        sendToRenderer('launchers-changed', launchersPayload());
    }

    // In-app flatpak install: the "Install" button of a not-installed catalog entry. First the `flathub --user`
    // remote is added (`--if-not-exists`, idempotent), then `flatpak install --user`. The % lines go out on the
    // `flatpak-install-progress` push, success → auto add + `flatpak-install-done`. One install at a time.
    let flatpakInstallInFlight = false;

    async function installFlatpak(payload) {
        const { id } = payload || {};
        const entry = launcherCatalog.find((e) => e.id === id);
        if (!entry || !entry.flathubId) {
            sendToRenderer('flatpak-install-done', { ok: false, id, error: 'unknown catalog entry' });
            return;
        }
        if (flatpakInstallInFlight) {
            sendToRenderer('flatpak-install-done', { ok: false, id, error: 'an installation is already running' });
            return;
        }
        flatpakInstallInFlight = true;
        log(`flatpak install: ${entry.flathubId}`);
        try {
            // 1) flathub --user remote (idempotent)
            await flatpak.runFlatpak(['remote-add', '--user', '--if-not-exists',
                'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'], null, flatpak.FLATPAK_REMOTE_TIMEOUT_MS);

            // 2) install — the % lines go to the progress push
            let lastPct = 0;
            const res = await flatpak.runFlatpak(
                ['install', '--user', '--noninteractive', 'flathub', entry.flathubId],
                (s) => {
                    const m = s.match(/(\d{1,3})\s*%/g);
                    if (!m) return;
                    const pct = parseInt(m[m.length - 1], 10);
                    if (Number.isFinite(pct) && pct > lastPct && pct <= 100) {
                        lastPct = pct;
                        sendToRenderer('flatpak-install-progress', { id, pct });
                    }
                }, flatpak.FLATPAK_INSTALL_TIMEOUT_MS);

            if (res.code === 0) {
                log(`flatpak install OK: ${entry.flathubId}`);
                addLauncher(id);
                sendToRenderer('flatpak-install-done', { ok: true, id });
            } else {
                const err = res.timedOut ? 'timeout' : (flatpak.flatpakErrorLine(res.out) || `exit code ${res.code}`);
                log(`flatpak install FAILED (${res.code}): ${entry.flathubId} — ${err}`);
                sendToRenderer('flatpak-install-done', { ok: false, id, error: err });
            }
        } catch (err) {
            log(`flatpak install exception: ${err.message}`);
            sendToRenderer('flatpak-install-done', { ok: false, id, error: err.message });
        } finally {
            flatpakInstallInFlight = false;
        }
    }

    // Every launcher is removable (no fixed built-ins). "Trash" of the last removed launcher: the renderer's △ toast
    // brings it back via `undo-remove-launcher` within `undoMs` — the entry, its place in the order and its custom ROM
    // sources together. Deleting the imported icon WAITS until the trash is emptied (otherwise the restored card would
    // have no icon). One item at a time: a newer removal finalizes the previous one. (If the launcher exits within the
    // 30 s, the imported icon may be orphaned in the icon folder — harmless.)
    /** @type {{ entry: any, orderIndex: number, sources: any[], timer: any } | null} */
    let trash = null;

    function purgeTrash() {
        if (!trash) return;
        clearTimeout(trash.timer);
        const t = trash;
        trash = null;
        // If it was re-added with the same icon meanwhile (e.g. from the wizard), do not delete it.
        if (!launchersLib.readCustomLaunchers().some((l) => l.icon === t.entry.icon)) {
            appIcons.removeUserIcon(t.entry.icon);
        }
    }

    function removeLauncher(id) {
        try {
            const all = launchersLib.readCustomLaunchers();
            const removed = all.find((l) => l.id === id);
            const custom = all.filter((l) => l.id !== id);
            launchersLib.writeCustomLaunchers(custom);
            // Also purge it from the order so no orphan id is left.
            const fullOrder = launchersLib.readLauncherOrder();
            const order = fullOrder.filter((oid) => oid !== id);
            launchersLib.writeLauncherOrder(order);
            // The custom ROM source assigned to the launcher is not left orphaned either.
            const sources = config.get('customGameSources', []);
            const ownSources = Array.isArray(sources) ? sources.filter((s) => s && s.launcherId === id) : [];
            if (ownSources.length) {
                config.set('customGameSources', sources.filter((s) => !s || s.launcherId !== id));
            }
            if (removed) {
                purgeTrash();
                trash = {
                    entry: removed,
                    orderIndex: fullOrder.indexOf(id),
                    sources: ownSources,
                    timer: setTimeout(purgeTrash, undoMs),
                };
                if (trash.timer && typeof trash.timer.unref === 'function') trash.timer.unref();
            }
            reloadLaunchers();
        } catch (err) {
            log(`remove-launcher error: ${err.message}`);
        }
        sendToRenderer('launchers-changed', launchersPayload());
    }

    // `id` = the launcher to restore (the renderer's toast knows it) — only restores the trash content, does NOT
    // add an arbitrary object (so it does not bypass the `checkLauncherPayload` gate: the entry already passed it
    // once). `true` = restored.
    function undoRemoveLauncher(id) {
        if (!trash || trash.entry.id !== id) {
            log(`undo-remove-launcher: no removal to undo (${id})`);
            return false;
        }
        const t = trash;
        clearTimeout(t.timer);
        trash = null;
        try {
            const all = launchersLib.readCustomLaunchers();
            if (!all.some((l) => l.id === id)) launchersLib.writeCustomLaunchers([...all, t.entry]);
            const order = launchersLib.readLauncherOrder().filter((oid) => oid !== id);
            if (t.orderIndex >= 0) {
                order.splice(Math.min(t.orderIndex, order.length), 0, id);
                launchersLib.writeLauncherOrder(order);
            }
            if (t.sources.length) {
                const sources = config.get('customGameSources', []);
                const rest = Array.isArray(sources) ? sources.filter((s) => !s || s.launcherId !== id) : [];
                config.set('customGameSources', [...rest, ...t.sources]);
            }
            reloadLaunchers();
        } catch (err) {
            log(`undo-remove-launcher error: ${err.message}`);
        }
        sendToRenderer('launchers-changed', launchersPayload());
        return true;
    }

    return {
        setLauncherOrder, setLauncherAccent, listInstalledApps, listLauncherCatalog,
        listIcons, addLauncher, installFlatpak, removeLauncher, undoRemoveLauncher, saveLauncherEntry,
    };
}

/**
 * @param {Parameters<typeof createLauncherManageHandlers>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerLauncherManageIpc(deps) {
    const { ipcMain, launchersPayload } = deps;
    requireDeps(deps, ['ipcMain', 'launchersPayload'], 'registerLauncherManageIpc');
    const h = createLauncherManageHandlers(deps);
    ipcMain.handle('get-launchers', () => launchersPayload());
    ipcMain.on('set-launcher-order', (event, ids) => h.setLauncherOrder(ids));
    ipcMain.on('set-launcher-accent', (event, payload) => h.setLauncherAccent(payload));
    ipcMain.handle('list-installed-apps', () => h.listInstalledApps());
    ipcMain.handle('list-launcher-catalog', () => h.listLauncherCatalog());
    ipcMain.handle('list-icons', () => h.listIcons());
    ipcMain.on('add-launcher', (event, payload) => h.addLauncher(payload));
    ipcMain.on('install-flatpak', (event, payload) => h.installFlatpak(payload));
    ipcMain.on('remove-launcher', (event, id) => h.removeLauncher(id));
    ipcMain.on('undo-remove-launcher', (event, id) => h.undoRemoveLauncher(id));
    return h;
}

module.exports = { createLauncherManageHandlers, registerLauncherManageIpc };
