// @ts-check
'use strict';

const { requireDeps } = require('./require-deps.js');
const { str, oneOf, PATH_MAX } = require('../validate.js');

// The native ↔ flatpak VARIANT of the added launchers + the manually set native path. Channels: `set-launcher-variant`,
// `set-launcher-path`, `find-launcher-executables`; plus the startup `repairLauncherVariants()` (called from `whenReady`). The
// launcher-list state belongs to the caller (`getLaunchersRaw`/`reloadLaunchers`, as in launcher-manage-ipc); adding a not yet
// added launcher natively goes through launcher-manage's `saveLauncherEntry` (injected).

/**
 * @param {object} deps
 * @param {object} deps.launchersLib `lib/launcher-list.js`
 * @param {Array<object>} deps.launcherCatalog
 * @param {((msg: string) => void) & { warn?: (msg: string) => void }} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {() => Array<object>} deps.getLaunchersRaw
 * @param {() => void} deps.reloadLaunchers
 * @param {() => any} deps.launchersPayload
 * @param {(entry: object) => void} deps.saveLauncherEntry launcher-manage's adder (reload + launchers-changed)
 */
function createLauncherVariantHandlers(deps) {
    const {
        launchersLib, launcherCatalog, log, sendToRenderer,
        getLaunchersRaw, reloadLaunchers, launchersPayload, saveLauncherEntry,
    } = deps;
    requireDeps(deps, ['launchersLib', 'launcherCatalog', 'log', 'sendToRenderer', 'getLaunchersRaw', 'reloadLaunchers', 'launchersPayload', 'saveLauncherEntry'], 'createLauncherVariantHandlers');
    // The tests' fake `log` is a plain function; in production the `createLogger` `.warn` marks the line.
    const warn = (msg) => (typeof log.warn === 'function' ? log.warn(msg) : log(msg));

    // Rewrites the cmd/args of an added dual-variant catalog launcher to the other variant (id/name/icon/accent/order
    // stay). The user's choice (Launchers subview □) OR the startup self-repair (`repairLauncherVariants`). True if it wrote.
    function rewriteVariant(id, variant, nativeCmd) {
        const entry = launcherCatalog.find((e) => e.id === id);
        if (!launchersLib.isDualCatalogEntry(entry) || (variant !== 'native' && variant !== 'flatpak')) return false;
        const custom = launchersLib.readCustomLaunchers();
        const idx = custom.findIndex((l) => l.id === id);
        if (idx < 0) return false;
        const cur = launchersLib.launcherVariantOf(custom[idx], entry);
        if (!cur || cur === variant) return false;
        custom[idx] = { ...custom[idx], ...launchersLib.variantSpec(entry, variant, nativeCmd) };
        launchersLib.writeCustomLaunchers(custom);
        return true;
    }

    async function setLauncherVariant(payload) {
        const id = str((payload || {}).id);
        const variant = oneOf((payload || {}).variant, ['native', 'flatpak']);
        try {
            const entry = launcherCatalog.find((e) => e.id === id);
            const nativeCmd = variant === 'native' && entry
                ? (await launchersLib.detectLauncherInstall(entry)).nativeCmd : null;
            if (rewriteVariant(id, variant, nativeCmd)) {
                log(`set-launcher-variant: ${id} → ${variant}`);
                reloadLaunchers();
            } else {
                log(`set-launcher-variant: no change / invalid: ${JSON.stringify(payload)}`);
            }
        } catch (err) {
            log(`set-launcher-variant error: ${err.message}`);
        }
        sendToRenderer('launchers-changed', launchersPayload());
    }

    // --- Manually set native launcher ---

    // Program candidates in the folder chosen by the user (`{ ok, guess, items: [{ path, name }] }`). Without `id`
    // (the custom-command browser of the "+ Add launcher" wizard) there is no ranking by name — all executables of the
    // folder (`guess: true`).
    function findExecutables(payload) {
        const { id, dir } = payload || {};
        const entry = id == null ? { id: '', name: '' } : launcherCatalog.find((e) => e.id === id);
        if (!entry || typeof dir !== 'string' || !dir) return { ok: false, guess: false, items: [] };
        return { ok: true, ...launchersLib.findLauncherExecutables(dir, entry) };
    }

    // Directly rewrites the cmd/args of an added launcher (to set / clear the manual path — `rewriteVariant` only
    // writes VARIANT switches, not native → native (another binary)).
    function writeSpec(id, spec) {
        const custom = launchersLib.readCustomLaunchers();
        const idx = custom.findIndex((l) => l.id === id);
        if (idx < 0) return false;
        custom[idx] = { ...custom[idx], ...spec };
        launchersLib.writeCustomLaunchers(custom);
        return true;
    }

    // `{ id, path, apply }` — `path` = the executable (null/'' = clear the manual path). `apply` (default: yes): the
    // added launcher switches to it immediately, a not yet added one is added natively; the wizard only saves it with
    // `apply: false` (`finish-setup` adds it). On clear, a launcher using the manual path falls back to the detected
    // variant (flatpak first).
    async function setLauncherPath(payload) {
        const { apply = true } = payload || {};
        const id = str((payload || {}).id);
        // null/'' = clear the manual path; non-string → rejected (not interpreted as clear)
        const rawPath = (payload || {}).path;
        if (rawPath != null && rawPath !== '' && !str(rawPath, PATH_MAX)) return { ok: false, reason: 'invalid path' };
        const filePath = rawPath || null;
        const entry = launcherCatalog.find((e) => e.id === id);
        if (!launchersLib.isDualCatalogEntry(entry)) return { ok: false, reason: 'unknown launcher' };
        try {
            const prev = launchersLib.readLauncherPaths()[id] || null;
            if (!filePath) {
                launchersLib.writeLauncherPath(id, null);
                log(`launcher-path: manual path of ${id} cleared`);
                const active = launchersLib.readCustomLaunchers().find((l) => l.id === id);
                if (apply && active && prev && active.cmd === prev) {
                    const det = await launchersLib.detectLauncherInstall(entry);
                    if (det.installed) {
                        const variant = det.installed === 'native' ? 'native' : 'flatpak';
                        writeSpec(id, launchersLib.variantSpec(entry, variant, det.nativeCmd));
                    } else {
                        warn(`launcher-path: ${id} — the manual path was cleared, but no other variant is installed either`);
                    }
                }
            } else {
                const check = launchersLib.checkLauncherExecutable(filePath);
                if (!check.ok) {
                    warn(`launcher-path rejected (${check.reason}): ${filePath}`);
                    return { ok: false, reason: check.reason };
                }
                launchersLib.writeLauncherPath(id, filePath);
                log(`launcher-path: ${id} → ${filePath}`);
                if (apply) {
                    const spec = launchersLib.variantSpec(entry, 'native', filePath);
                    if (!writeSpec(id, spec)) {
                        saveLauncherEntry({ ...entry, ...spec }); // reload + launchers-changed there
                        return { ok: true };
                    }
                }
            }
            reloadLaunchers();
        } catch (err) {
            log(`launcher-path error: ${err.message}`);
            return { ok: false, reason: err.message };
        }
        sendToRenderer('launchers-changed', launchersPayload());
        return { ok: true };
    }

    // Startup self-repair: if an added dual-variant launcher's variant is not on the machine but the other one is
    // (e.g. native `steam` in the config, but only the flatpak Steam is installed) → rewrite it. Only detects the
    // active dual-variant entries.
    async function repairLauncherVariants() {
        try {
            const raw = getLaunchersRaw();
            const duals = launcherCatalog.filter((e) => launchersLib.isDualCatalogEntry(e)
                && raw.some((l) => l.id === e.id));
            if (!duals.length) return [];
            const checks = await Promise.allSettled(duals.map((e) => launchersLib.detectLauncherInstall(e)));
            /** @type {Record<string, any>} */
            const installedById = {};
            /** @type {Record<string, string|null>} */
            const nativeById = {};
            duals.forEach((e, i) => {
                const r = checks[i];
                if (r.status === 'fulfilled') { installedById[e.id] = r.value.installed; nativeById[e.id] = r.value.nativeCmd; }
            });
            const plan = launchersLib.planVariantRepairs(raw, launcherCatalog, installedById);
            const done = plan.filter((p) => rewriteVariant(p.id, p.to, nativeById[p.id]));
            if (done.length) {
                for (const p of done) warn(`[launcher] ${p.id}: the ${p.from} variant is not installed → ${p.to}`);
                reloadLaunchers();
                sendToRenderer('launchers-changed', launchersPayload());
            }
            return done;
        } catch (err) {
            log(`launcher variant self-repair error: ${err.message}`);
            return [];
        }
    }

    return { setLauncherVariant, repairLauncherVariants, findExecutables, setLauncherPath };
}

/**
 * @param {Parameters<typeof createLauncherVariantHandlers>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerLauncherVariantIpc(deps) {
    const { ipcMain } = deps;
    requireDeps(deps, ['ipcMain'], 'registerLauncherVariantIpc');
    const h = createLauncherVariantHandlers(deps);
    ipcMain.handle('find-launcher-executables', (event, payload) => h.findExecutables(payload));
    ipcMain.handle('set-launcher-path', (event, payload) => h.setLauncherPath(payload));
    ipcMain.on('set-launcher-variant', (event, payload) => { h.setLauncherVariant(payload).catch(() => {}); });
    return h;
}

module.exports = { createLauncherVariantHandlers, registerLauncherVariantIpc };
