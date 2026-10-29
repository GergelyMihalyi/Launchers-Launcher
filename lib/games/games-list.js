// @ts-check
'use strict';

// Merging Steam+Heroic+Lutris for the Games panel's root list. A pure function — the actual queries (3 sources, Steam/Heroic sync file
// reads, Lutris async CLI call) stay with the caller; this only does the id building (a different shape per `source` — the renderer uses
// it to decide which `launch-*` IPC to call on X) + the final, locale-aware sort.

function combineGamesList(steamGames, heroicGames, lutrisGames) {
    const steam = (steamGames || []).map((g) => ({
        id: `steam:${g.appid}`, appid: g.appid, name: g.name, source: 'steam', cover: g.cover || null,
    }));
    const heroic = (heroicGames || []).map((g) => ({
        id: `heroic:${g.runner}:${g.appName}`, appName: g.appName, name: g.name, source: g.runner, cover: g.cover || null,
    }));
    const lutris = (lutrisGames || []).map((g) => ({
        id: `lutris:${g.id}`, lutrisId: g.id, name: g.name, source: 'lutris', cover: g.cover || null,
    }));
    return [...steam, ...heroic, ...lutris].sort((a, b) => a.name.localeCompare(b.name, 'hu'));
}

module.exports = { combineGamesList };
