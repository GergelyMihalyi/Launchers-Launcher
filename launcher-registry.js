// @ts-check
/// <reference lib="dom" />
// SHARED, data-only registry of the Games panel's emulator sources — one file for main AND renderer (the controller-id.js pattern):
// main: `require('../launcher-registry.js')` (lib/prefs.js `GAMES_SOURCE_IDS`, lib/recent/usage.js `DERIVED_RECENT_LAUNCHER_IDS`, lib/ipc/games-ipc.js
// network cover descriptor); renderer: `<script src>` (games-panel-sources.js builds `EMULATOR_SOURCES` + the card quick-menu tables from it).
// NOT here (function-heavy; guarded by test/contracts/launcher-tables.test.js): the main-side wiring (`lib/launchers/emulator-sources.js`),
// the launch descriptor (`lib/ipc/launch-ipc.js` EMULATOR_LAUNCHES), the save locations (`lib/saves/save-sources.js`).
// NEW EMULATOR: `npm run new-emulator` — full checklist: docs/dev/launchers/README.md#adding-an-emulator. Order = order of the source chips and panel sections.
//
// Fields:
//   id            — source/launcher id (also the `<id>-game` row type and the favorite-key prefix)
//   name          — readable name (log)
//   chip          — label of the source filter chip / cell badge
//   idField       — the row's stable id field (favorite key: `<id>-game-<row[idField]>`)
//   subheadKey    — i18n key of the list-mode section header
//   launchParams  — `startGameLaunch()` `params` fields from the row: the FIRST raw, the rest normalized with `|| null`
//                   (a missing real id → path-hash substitute in main)
//   networkCover  — if the cover comes from the NETWORK: { keyField: the download key field, withName?: the row name is needed for the URL too }
//   derivedRecent — "recently played" is derived from the emulator's OWN data at read time (not the launch-time `recentGames`)
//   background    — the panel does NOT wait for this list (slow scan): it opens with the other sources, rows appear later
//
// The IPC is SHARED and `source`-parameterized: `list-emulator-games` { source }, `ensure-emulator-covers` { source, ids }, `launch-emulator-game`
// { source, ...params } — main whitelists against the registry ids, a new emulator needs NO new channel.

(function (root) {
    const EMULATOR_REGISTRY = [
        {
            id: 'ryujinx', name: 'Ryujinx', chip: 'RYUJINX', idField: 'id', subheadKey: 'games.ryujinxSubhead',
            launchParams: ['path', 'titleId'],
            networkCover: { keyField: 'titleId' },
        },
        {
            id: 'pcsx2', name: 'PCSX2', chip: 'PCSX2', idField: 'id', subheadKey: 'games.pcsx2Subhead',
            launchParams: ['path', 'serial'],
            networkCover: { keyField: 'serial' }, derivedRecent: true,
        },
        {
            id: 'cemu', name: 'Cemu', chip: 'CEMU', idField: 'id', subheadKey: 'games.cemuSubhead',
            launchParams: ['path', 'titleId'],
        },
        {
            id: 'rpcs3', name: 'RPCS3', chip: 'RPCS3', idField: 'titleId', subheadKey: 'games.rpcs3Subhead',
            launchParams: ['titleId'], derivedRecent: true,
        },
        {
            id: 'ppsspp', name: 'PPSSPP', chip: 'PPSSPP', idField: 'id', subheadKey: 'games.ppssppSubhead',
            launchParams: ['path', 'discId'], derivedRecent: true,
        },
        {
            id: 'dolphin', name: 'Dolphin', chip: 'DOLPHIN', idField: 'id', subheadKey: 'games.dolphinSubhead',
            launchParams: ['path', 'gameId'],
            networkCover: { keyField: 'gameId' },
        },
        {
            id: 'melonds', name: 'melonDS', chip: 'MELONDS', idField: 'id', subheadKey: 'games.melondsSubhead',
            launchParams: ['path', 'archiveEntry', 'gamecode'],
            // a cold scan can take 13 s on NFS — the panel opens without it, rows appear later
            background: true,
        },
        {
            id: 'duckstation', name: 'DuckStation', chip: 'DUCKSTATION', idField: 'id', subheadKey: 'games.duckstationSubhead',
            launchParams: ['path', 'serial'],
            // duckstationThumbnailUrl() builds the URL from the TITLE, not the serial
            networkCover: { keyField: 'serial', withName: true },
            derivedRecent: true,
        },
    ];

    // The non-emulator ("store") sources: the `source` field of `list-games` (Steam + Heroic's 3 stores
    // + Lutris) — the renderer's GAME_SOURCES table adds their launch.
    const STORE_SOURCE_IDS = ['steam', 'gog', 'legendary', 'nile', 'lutris'];

    // Shared source id of the custom ROM-folder sources — ONE chip ("OTHER") for the games of all
    // user-added launchers; the cell badge is the launcher name.
    const CUSTOM_GAMES_SOURCE_ID = 'custom';

    // All source ids of the Games panel (whitelist of `gamesHiddenSources` / `gamesViewMode`).
    const GAMES_SOURCE_IDS = [...STORE_SOURCE_IDS, 'retro', ...EMULATOR_REGISTRY.map((e) => e.id), CUSTOM_GAMES_SOURCE_ID];

    // Launchers whose "recently played" is derived from their OWN data at read time.
    const DERIVED_RECENT_IDS = ['steam', 'retroarch', ...EMULATOR_REGISTRY.filter((e) => e.derivedRecent).map((e) => e.id)];

    // `startGameLaunch()` `params` from a row (see `launchParams` above).
    function launchParamsFor(entry, row) {
        /** @type {Record<string, any>} */
        const params = {};
        entry.launchParams.forEach((field, i) => {
            params[field] = i === 0 ? row[field] : (row[field] || null);
        });
        return params;
    }

    root.EMULATOR_REGISTRY = EMULATOR_REGISTRY;
    root.CUSTOM_GAMES_SOURCE_ID = CUSTOM_GAMES_SOURCE_ID;
    root.launchParamsFor = launchParamsFor;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            EMULATOR_REGISTRY, STORE_SOURCE_IDS, GAMES_SOURCE_IDS, DERIVED_RECENT_IDS, CUSTOM_GAMES_SOURCE_ID, launchParamsFor,
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
