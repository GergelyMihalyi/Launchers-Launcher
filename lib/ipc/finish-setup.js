// @ts-check
'use strict';

const { requireDeps } = require('./require-deps.js');

// Body of the `finish-setup` (send) IPC handler: records the final choices of the setup wizard (`renderer/setup-wizard.js`).
// The startup MONITOR is only written (it takes effect on the next start — a bad choice cannot black out the first start),
// the sink is applied immediately. `createFinishSetup(deps)`: deps carry main's local state/modules
// (`launchersLib`, `displays`, `audio`, `prefs`, `mainController`, `log`, `loadLaunchers`, `launchersWithUsage`, `sendToRenderer`).

function createFinishSetup(deps) {
    const {
        launchersLib, launcherCatalog, displays, audio, prefs, mainController,
        log, loadLaunchers, launchersWithUsage, sendToRenderer,
    } = deps;
    requireDeps(deps, ['launchersLib', 'launcherCatalog', 'displays', 'audio', 'prefs', 'mainController', 'log', 'loadLaunchers', 'launchersWithUsage', 'sendToRenderer'], 'createFinishSetup');
    const logFn = log || (() => {});

    return async function applyFinishSetup(data) {
        const d = data || {};
        try {
            // Launcher step: copy the chosen catalog `id`s into `customLaunchers` — BEFORE the other (awaited) steps, so
            // the renderer's wizCommit `getLaunchers()` gets the fresh list.
            if (Array.isArray(d.addLaunchers) && d.addLaunchers.length) {
                const custom = launchersLib.readCustomLaunchers();
                const have = new Set(custom.map((l) => l.id));
                let added = 0;
                // Dual-variant (native + flatpak) entry: the INSTALLED variant; if both are present, the one chosen in the
                // wizard (`launcherVariants[id]`, default: flatpak). Detection is rerun here (the renderer only sends the request).
                const wanted = (d.launcherVariants && typeof d.launcherVariants === 'object') ? d.launcherVariants : {};
                for (const id of d.addLaunchers) {
                    const e = launcherCatalog.find((c) => c.id === id);
                    if (!e || have.has(id)) continue;
                    let spec = { cmd: e.cmd, args: e.args };
                    if (launchersLib.isDualCatalogEntry(e)) {
                        const det = await launchersLib.detectLauncherInstall(e).catch(() => ({ installed: null, nativeCmd: null }));
                        spec = launchersLib.variantSpec(e, launchersLib.pickLauncherVariant(det.installed, wanted[id]), det.nativeCmd);
                    }
                    custom.push({
                        id: e.id, name: e.name, hint: e.hint || '', icon: e.icon || '',
                        cmd: spec.cmd, args: spec.args, custom: true,
                        ...(launchersLib.isAccentColor(e.accent) ? { accent: e.accent } : {}),
                    });
                    added++;
                }
                if (added) {
                    launchersLib.writeCustomLaunchers(custom);
                    loadLaunchers();
                    sendToRenderer('launchers-changed', launchersWithUsage());
                }
            }

            const patch = {};
            if (typeof d.monitor === 'string' && d.monitor) patch.monitor = d.monitor;
            if (typeof d.sink === 'string' && d.sink) patch.sink = d.sink;
            if (Object.keys(patch).length) displays.writeDisplayConfig(patch);

            if (typeof d.sink === 'string' && d.sink) {
                try { await audio.setAudioSink(d.sink); } catch (err) { logFn(`Setup sink error: ${err.message}`); }
            }

            const mc = prefs.setMainController(d.mainController && d.mainController.mac ? d.mainController : null);
            mainController.writeSidecar(mc && mc.mac);

            if (typeof d.theme === 'string' && d.theme) prefs.setTheme(d.theme);
            if (typeof d.language === 'string' && d.language) prefs.setLanguage(d.language);

            prefs.setSetupDone(true);
            logFn('Setup wizard finished');
        } catch (err) {
            logFn(`Setup wizard error: ${err.message}`);
        }
    };
}

/**
 * The wizard's channels: the state query + `finish-setup`.
 * @param {Parameters<typeof createFinishSetup>[0] & { ipcMain: import('../types.js').IpcMainLike }} deps
 */
function registerSetupIpc(deps) {
    const { ipcMain, prefs } = deps;
    requireDeps(deps, ['ipcMain', 'prefs'], 'registerSetupIpc');
    const applyFinishSetup = createFinishSetup(deps);
    ipcMain.handle('get-setup-state', () => ({ done: prefs.getSetupDone() }));
    ipcMain.on('finish-setup', (event, data) => applyFinishSetup(data));
}

module.exports = { createFinishSetup, registerSetupIpc };
