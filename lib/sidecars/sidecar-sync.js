// @ts-check
'use strict';

// Startup sidecar resync: aligns the state files written for the shell scripts / the DE with the current config values — for a
// hand-edited config.json, a fresh clone or a file deleted by hand. Every step in its own try/catch: a broken sidecar must not block
// the others (nor the startup). A new sidecar = a new step in the `steps` list.

/**
 * @param {Object} deps
 * @param {typeof import('../prefs.js')} deps.prefs
 * @param {{ writeSidecar: (mac: any) => void }} deps.mainController
 * @param {{ writeSidecar: (cfg: any) => void }} deps.tvModeEnter
 * @param {{ writeSidecar: (enabled: boolean) => void }} deps.autostart
 * @param {{ isAutostartEntryPresent: () => boolean, writeAutostartEntry: (repoRoot: string) => void, removeAutostartEntry: () => void }} deps.xdgAutostart
 * @param {string} deps.repoRoot
 * @param {(msg: string) => void} deps.log
 * @returns {string[]} labels of the failed steps (for tests)
 */
function resyncSidecars({ prefs, mainController, tvModeEnter, autostart, xdgAutostart, repoRoot, log }) {
    /** @type {Array<[string, () => void]>} */
    const steps = [
        // "main controller" → the BT trigger's guard
        ['Main controller sidecar write', () => mainController.writeSidecar((prefs.getMainController() || {}).mac)],
        // `tvMode` → bin/tv-mode-enter.sh (programs to close when entering TV mode)
        ['tvMode sidecar write', () => tvModeEnter.writeSidecar(prefs.getTvMode())],
        // `controllerAutostart` → bin/launchers-launcher-bt-trigger.sh
        ['Auto-start sidecar write', () => autostart.writeSidecar(prefs.getControllerAutostart())],
        // `startWithSystem` → presence of the actual XDG autostart `.desktop`
        ['Start with the system — autostart entry sync', () => {
            const want = prefs.getStartWithSystem();
            if (want === xdgAutostart.isAutostartEntryPresent()) return;
            if (want) xdgAutostart.writeAutostartEntry(repoRoot);
            else xdgAutostart.removeAutostartEntry();
        }],
    ];
    const failed = [];
    for (const [label, run] of steps) {
        try {
            run();
        } catch (err) {
            failed.push(label);
            log(`${label} error: ${err && err.message ? err.message : err}`);
        }
    }
    return failed;
}

module.exports = { resyncSidecars };
