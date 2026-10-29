// @ts-check
'use strict';

// PURE merging of the "Installed application" list of the "+ Add launcher" wizard. Discovery (flatpak list, `.desktop`, icon index) is
// done by the caller, this only builds the rows — so it is testable without deps.

const path = require('path');
const { nativeCmdsOf, checkLauncherPayload } = require('../launcher-list.js');
const { flatpakRunAppId } = require('../flatpak.js');

/**
 * The installed flatpak apps + the native `.desktop` entries, by name. Per row the absolute path of the resolved icon file (the
 * renderer loads it as `file://` for the preview and sends it back as `iconFile` when adding). Only native rows the `add-launcher`
 * gate (`checkLauncherPayload`) would accept, and that are not flatpak commands, make the list. `known` = a program already added /
 * in the catalog (the UI marks it).
 * @param {Object} src
 * @param {Array<{ appId: string, name: string }>} src.flatpaks
 * @param {Array<{ id: string, name: string, cmd: string, args: string[], icon?: string }>} src.natives
 * @param {Array<any>} src.catalog the launcher catalog
 * @param {Array<any>} src.launchers the added launchers (raw list)
 * @param {(name: string|undefined) => (string|null)} src.resolveIcon icon name/path → icon file (or null)
 */
function buildInstalledAppItems({ flatpaks, natives, catalog, launchers, resolveIcon }) {
    const knownAppIds = new Set();
    const knownCmds = new Set();
    for (const e of catalog) {
        if (e.flathubId) knownAppIds.add(e.flathubId);
        for (const c of nativeCmdsOf(e)) knownCmds.add(path.basename(c));
    }
    for (const l of launchers) {
        const a = l.cmd === 'flatpak' ? flatpakRunAppId(l.args) : null;
        if (a) knownAppIds.add(a);
        else if (l.cmd) knownCmds.add(path.basename(l.cmd));
    }
    return [
        ...flatpaks.map((a) => ({
            key: `flatpak:${a.appId}`, kind: 'flatpak', name: a.name, appId: a.appId,
            cmd: 'flatpak', args: ['run', a.appId],
            icon: resolveIcon(a.appId),
            known: knownAppIds.has(a.appId),
        })),
        ...natives
            .filter((a) => {
                const check = checkLauncherPayload({ id: 'probe', name: a.name, cmd: a.cmd, args: a.args }, catalog);
                return check.ok && check.kind !== 'flatpak';
            })
            .map((a) => ({
                key: `desktop:${a.id}`, kind: 'native', name: a.name, desktopId: a.id,
                cmd: a.cmd, args: a.args,
                icon: resolveIcon(a.icon),
                known: knownCmds.has(path.basename(a.cmd)),
            })),
    ].sort((x, y) => x.name.localeCompare(y.name));
}

module.exports = { buildInstalledAppItems };
