// @ts-check
'use strict';

// IPC of the Settings → System → Diagnostics + Log subviews: log read/export, logging renderer-side errors, startup
// timeline, version/platform info, command self-test and installing missing system packages. The caller supplies the
// Electron-dependent data (versions, GPU status).

const { readLogTail, exportLog } = require('../log-lines.js');
const { formatClientErrorLine } = require('../client-error-log.js');
const { formatTimeline } = require('../startup-timeline.js');
const { getFormatDrift } = require('../host-deps/format-drift.js');
const { fatalPolicy } = require('../fatal-policy.js');
const defaultSelftest = require('../host-deps/selftest.js');
const { requireDeps } = require('./require-deps.js');

// The Log subview shows this many lines (levels filtered with L2/R2, lib/log-lines.js).
const LOG_VIEW_MAX_LINES = 500;

// The Electron-dependent part of `get-app-info` (the Diagnostics "Version" section). `app` is injected — the module
// does not require Electron (stays testable in a sandbox).
/**
 * @param {{ app: { getVersion: () => string, getGPUFeatureStatus: () => any }, gpuReason?: string|null,
 *   ozone?: string, desktop?: string }} p
 */
function electronAppInfo({ app, gpuReason = null, ozone, desktop }) {
    return {
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        // 'enabled' = hardware GPU compositing; 'disabled_software' / 'unavailable_software' = CPU
        gpu: app.getGPUFeatureStatus().gpu_compositing,
        gpuReason,
        ozone,
        desktop,
    };
}

/**
 * @param {Object} deps
 * @param {import('../types.js').IpcMainLike} deps.ipcMain
 * @param {((msg: string) => void) & { warn: (msg: string) => void, error: (msg: string) => void }} deps.log
 * @param {(label: string, fn: () => Promise<any>) => Promise<{ ok: boolean, items: any[] }>} deps.safeList
 * @param {string} deps.logFile the main log
 * @param {string[]} deps.extraLogs further logs included in the export (watcher, BT trigger)
 * @param {string} deps.exportHeader first line of the export (version, machine)
 * @param {{ mark: (name: string) => boolean, list: () => any[] }} deps.startupTimeline
 * @param {() => Object} deps.appInfo the Electron-dependent part of `get-app-info` (versions, GPU, ozone, DE)
 * @param {(active: boolean) => void} deps.onHostInstall start/end of a package install (the foreground guard pauses
 *   meanwhile — the polkit password dialog has the focus; at the end it brings the launcher back)
 * @param {{ checkCommands: () => Promise<Array<{ cmd: string, ok: boolean }>> }} [deps.selftest]
 * @param {{ installMissingCommands: (o: { log: any }) => Promise<any> }} [deps.hostPackages] default: lazily
 *   `lib/host-deps/host-packages.js`
 */
function registerDiagnosticsIpc(deps) {
    const {
        ipcMain, log, safeList, logFile, extraLogs, exportHeader, startupTimeline, appInfo, onHostInstall,
        selftest = defaultSelftest, hostPackages = null,
    } = deps;
    requireDeps(deps, ['ipcMain', 'log', 'safeList', 'logFile', 'extraLogs', 'exportHeader', 'startupTimeline', 'appInfo', 'onHostInstall'], 'registerDiagnosticsIpc');
    // The last log lines — so on a kiosk machine without a terminal you can still see why something did not start.
    ipcMain.handle('read-log', () => safeList('Log read error',
        () => readLogTail(logFile, { maxLines: LOG_VIEW_MAX_LINES })));

    // The log(s) into one file in the home folder, for a bug report (Log subview □).
    ipcMain.handle('export-log', () => exportLog({ logFile, extraLogs, header: [exportHeader] }));

    // Renderer-side error into the log (renderer/errors.js).
    ipcMain.on('log-client-error', (event, payload) => {
        try {
            log.error(formatClientErrorLine(payload));
        } catch (err) {
            log(`log-client-error processing error: ${err.message}`);
        }
    });

    // Startup timeline: the renderer reports that the cards were drawn.
    ipcMain.on('startup-mark', (event, name) => {
        if (startupTimeline.mark(name) && name === 'launchersRendered') log(formatTimeline(startupTimeline.list()));
    });
    ipcMain.handle('get-startup-timeline', () => startupTimeline.list());

    ipcMain.handle('get-app-info', () => ({
        ...appInfo(),
        // external command outputs flagged as "format suspicious" during the session (lib/host-deps/format-drift.js)
        formatDrift: getFormatDrift(),
        // non-fatal unhandled rejections AFTER startup (lib/fatal-policy.js)
        backgroundErrors: fatalPolicy.stats(),
    }));

    // The command self-test (`[{ cmd, ok }]`, cached, never throws — hence not `safeList`).
    ipcMain.handle('get-selftest', () => selftest.checkCommands());

    // Installs the packages of the missing system commands.
    ipcMain.handle('install-host-packages', async () => {
        onHostInstall(true);
        try {
            const pkgs = hostPackages || require('../host-deps/host-packages.js');
            return await pkgs.installMissingCommands({ log });
        } catch (err) {
            log.error(`[host-packages] exception: ${err.message}`);
            return { ok: false, error: 'install-failed', detail: err.message, packages: [], unmapped: [], missingAfter: [], selftest: [] };
        } finally {
            onHostInstall(false);
        }
    });
}

module.exports = { registerDiagnosticsIpc, electronAppInfo, LOG_VIEW_MAX_LINES };
