// @ts-check
'use strict';

// Related IPC domains in ONE call (because of the `main.js` line cap): `registerLauncherListIpc` = launcher-manage +
// launcher-variant (variant gets manage's `saveLauncherEntry`); `registerGamesDomainIpc` = games + recent (`loadGames`) +
// game-sources (`invalidateGameSource`). The channels stay in the member modules, the member constructors check the deps.

const { requireDeps } = require('./require-deps.js');
const { registerLauncherManageIpc } = require('./launcher-manage-ipc.js');
const { registerLauncherVariantIpc } = require('./launcher-variant-ipc.js');
const { registerGamesIpc } = require('./games-ipc.js');
const { registerRecentIpc } = require('./recent-ipc.js');
const { registerGameSourcesIpc } = require('./game-sources-ipc.js');

/**
 * @param {Omit<Parameters<typeof registerLauncherManageIpc>[0], never>
 *   & Omit<Parameters<typeof registerLauncherVariantIpc>[0], 'saveLauncherEntry'>} deps
 */
function registerLauncherListIpc(deps) {
    requireDeps(deps, ['ipcMain'], 'registerLauncherListIpc');
    const manage = registerLauncherManageIpc(deps);
    const variants = registerLauncherVariantIpc({ ...deps, saveLauncherEntry: manage.saveLauncherEntry });
    return { manage, variants };
}

/**
 * @param {Parameters<typeof registerGamesIpc>[0]
 *   & Omit<Parameters<typeof registerRecentIpc>[0], 'loadGames'>
 *   & Omit<Parameters<typeof registerGameSourcesIpc>[0], 'invalidateGameSource'>} deps
 */
function registerGamesDomainIpc(deps) {
    requireDeps(deps, ['ipcMain'], 'registerGamesDomainIpc');
    const games = registerGamesIpc(deps);
    const recent = registerRecentIpc({ ...deps, loadGames: games.loadGames });
    const gameSources = registerGameSourcesIpc({ ...deps, invalidateGameSource: games.invalidateGameSource });
    return { games, recent, gameSources };
}

module.exports = { registerLauncherListIpc, registerGamesDomainIpc };
