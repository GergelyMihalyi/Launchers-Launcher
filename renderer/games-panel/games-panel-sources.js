// Games panel — source tables: which launchers/emulators show up as sources (`GAME_SOURCES`: Steam/GOG/Epic/Amazon/Lutris; `EMULATOR_SOURCES`:
// the root-list emulators), how a row launches (`launch(row)`), and whether there is something to show from a card quick menu. RetroArch is NOT
// here (per-system summary, see `retroSystemsHtml` in games-panel-render.js). Load order: AFTER carousel.js, BEFORE the other games-panel-*.js.
// The tables + `gameRowKey`/`gameListRowFromApi`/`pickHeroicSource` are exported (test/games-panel/games-panel.test.js); under Node
// `launcher-registry.js` is required from here (the `globalThis.X = require(...)` pattern of controller-status.js).
// Background: docs/dev/games-panel.md#data-flow-and-the-single-source-table
if (typeof EMULATOR_REGISTRY === 'undefined' && typeof module !== 'undefined' && module.exports) {
    const registry = module.require('../../launcher-registry.js');
    globalThis.EMULATOR_REGISTRY = registry.EMULATOR_REGISTRY;
    globalThis.launchParamsFor = registry.launchParamsFor;
    globalThis.CUSTOM_GAMES_SOURCE_ID = registry.CUSTOM_GAMES_SOURCE_ID;
}

// The SINGLE table of game sources (the Steam/Heroic rows of the root view). Adding a new store = 1 standalone row here: `id` = the `source`
// field of `list-games` (Steam or the Heroic "runner"); `label` = the cell badge + the source-filter chip label; `launch` = the
// `{ kind, params }` argument of `startGameLaunch()` for that row. RetroArch is NOT here (not a "game" row but a per-system summary).
const GAME_SOURCES = [
    { id: 'steam', label: 'STEAM', launch: (row) => ({ kind: 'steam', params: { appid: row.appid } }) },
    { id: 'gog', label: 'GOG', launch: (row) => ({ kind: 'heroic', params: { appName: row.appName, runner: 'gog' } }) },
    { id: 'legendary', label: 'EPIC', launch: (row) => ({ kind: 'heroic', params: { appName: row.appName, runner: 'legendary' } }) },
    { id: 'nile', label: 'AMAZON', launch: (row) => ({ kind: 'heroic', params: { appName: row.appName, runner: 'nile' } }) },
    { id: 'lutris', label: 'LUTRIS', launch: (row) => ({ kind: 'lutris', params: { id: row.lutrisId } }) },
];
const GAME_SOURCE_BY_ID = Object.fromEntries(GAME_SOURCES.map((s) => [s.id, s]));

// Table of the emulator launchers that show up as root-list rows WITHOUT a drill-down — DERIVED from `EMULATOR_REGISTRY` of
// `launcher-registry.js` (a new emulator = 1 row in the registry, not here). Fields: `type` (`<id>-game`), `label` (chip/badge),
// `keyPrefix`/`idField` for the favorite key (`${keyPrefix}-${row[idField]}`; `titleId` for RPCS3), `subheadKey` for the header of
// `emulatorGamesHtml()`, `launch(row)` the `{kind,params}` of `startGameLaunch()` (from the registry's `launchParams`). Grid vs. list:
// `gamesViewMode` decides (`row.grid` at render time), not a table field. `networkCover: true` — the covers come FROM THE NETWORK
// (Ryujinx/PCSX2/Dolphin/DuckStation), in windowed batches through `ensureEmulatorCovers({ source, ids })` (games-panel-covers.js);
// Cemu/RPCS3/PPSSPP/melonDS decode locally. `background: true` — the list loads in the background AFTER the panel opens.
/**
 * @typedef {{ id: string, type: string, label: string, keyPrefix: string, idField: string, subheadKey: string,
 *   networkCover?: boolean, background?: boolean, custom?: boolean,
 *   launch: (row: any) => { kind: string, params: Record<string, any> } }} EmulatorSource
 */
/** @type {EmulatorSource[]} */
const EMULATOR_SOURCES = EMULATOR_REGISTRY.map((e) => ({
    id: e.id,
    type: `${e.id}-game`,
    label: e.chip,
    keyPrefix: `${e.id}-game`,
    idField: e.idField,
    subheadKey: e.subheadKey,
    ...(e.networkCover ? { networkCover: true } : {}),
    ...(e.background ? { background: true } : {}),
    launch: (row) => ({ kind: e.id, params: launchParamsFor(e, row) }),
}));
// The custom ROM-folder sources — a row at the end of the table with the SAME shape as the registry emulators (so the chip, the ALL list,
// favorites, the grid/list mode and the section drawing handle it unchanged), with `custom: true`: the list comes from `listCustomGames()`
// (not `list-emulator-games`), the launch goes through `launch-custom-game`, the cell badge is the row's `badge` (the launcher name).
EMULATOR_SOURCES.push({
    id: CUSTOM_GAMES_SOURCE_ID,
    type: 'custom-game',
    label: 'OTHER',
    keyPrefix: 'custom-game',
    idField: 'id',
    subheadKey: 'games.customSubhead',
    custom: true,
    launch: (row) => ({ kind: 'custom', params: { launcherId: row.launcherId, path: row.path } }),
});
const EMULATOR_SOURCE_BY_ID = Object.fromEntries(EMULATOR_SOURCES.map((s) => [s.id, s]));
const EMULATOR_SOURCE_BY_TYPE = Object.fromEntries(EMULATOR_SOURCES.map((s) => [s.type, s]));

// Labels of the source-filter chips: the stores + the emulators (the registry's `chip` field).
const SOURCE_FILTER_LABELS = Object.assign(
    { all: 'MIND', retro: 'RETRO' },
    Object.fromEntries([...GAME_SOURCES, ...EMULATOR_SOURCES].map((s) => [s.id, s.label])),
);

// The "Open games" row of the launcher card's quick menu (renderer/home/card-menu.js) uses this to decide which source filter to open. Most
// launcher ids equal their own source-filter id; RetroArch -> 'retro' (there is no single "list", the system picker opens). Heroic is
// DELIBERATELY not in the table — there is no single 'heroic' source id (GOG/Epic/Amazon are separate chips), `pickHeroicGamesSource()`
// decides. The emulators (launcher id = source id) come from the registry.
const LAUNCHER_ID_TO_GAMES_SOURCE = {
    steam: 'steam', lutris: 'lutris', retroarch: 'retro',
    ...Object.fromEntries(EMULATOR_REGISTRY.map((e) => [e.id, e.id])),
};
// Order of the Heroic "first non-empty store" decision (user decision).
const HEROIC_SOURCE_PRIORITY = ['gog', 'legendary', 'nile'];

// Pure helper: the id of the first non-empty Heroic store among the already resolved `list-games` rows (gameListRowFromApi), in
// HEROIC_SOURCE_PRIORITY order, or `null`.
function pickHeroicSource(gameRows) {
    for (const id of HEROIC_SOURCE_PRIORITY) {
        if (gameRows.some((r) => r.type === 'game' && r.source === id)) return id;
    }
    return null;
}

// Does a source filter have at least one recognized game — for the pre-check of the "Open games" quick-menu row (the panel does not open
// for an empty list). A small per-source IPC call (cheap thanks to the main-side TTL cache); the emulators go through the shared
// `listEmulatorGames({ source })`. The ids of launchers with a custom ROM source (`refreshCustomGameSourceIds`: at startup + when the source
// is saved) are needed for the card menu's row.
let customGameLauncherIds = new Set();

async function refreshCustomGameSourceIds() {
    const res = await window.launcher.getCustomGameSources();
    customGameLauncherIds = new Set((res && res.ok && Array.isArray(res.sources) ? res.sources : []).map((s) => s.launcherId));
}

const LAUNCHER_GAMES_COUNT_CHECK = {
    steam: async () => (await window.launcher.listGames()).items?.some((g) => g.source === 'steam'),
    lutris: async () => (await window.launcher.listGames()).items?.some((g) => g.source === 'lutris'),
    retro: async () => (await window.launcher.listRetroarchSystems()).items?.length > 0,
    ...Object.fromEntries(EMULATOR_REGISTRY.map((e) => [
        e.id, async () => (await window.launcher.listEmulatorGames({ source: e.id })).items?.length > 0,
    ])),
    [CUSTOM_GAMES_SOURCE_ID]: async () => (await window.launcher.listCustomGames()).items?.length > 0,
};

async function pickHeroicGamesSourceAsync() {
    const res = await window.launcher.listGames();
    if (!res || !res.ok) return null;
    return pickHeroicSource((res.items || []).map(gameListRowFromApi));
}

// Entry point of the launcher card's "Open games" row (called by renderer/home/card-menu.js). `true` -> the Games panel opened filtered to
// the launcher's source; `false` -> no matching source OR the source is empty right now (the caller toasts then, the panel does not open).
async function openGamesPanelForLauncher(launcherId) {
    if (launcherId === 'heroic') {
        const source = await pickHeroicGamesSourceAsync();
        if (!source) return false;
        openGamesPanel(source);
        return true;
    }
    const source = LAUNCHER_ID_TO_GAMES_SOURCE[launcherId]
        || (customGameLauncherIds.has(launcherId) ? CUSTOM_GAMES_SOURCE_ID : null);
    const check = source && LAUNCHER_GAMES_COUNT_CHECK[source];
    if (!check || !(await check())) return false;
    openGamesPanel(source);
    return true;
}

// --- Pinning favorite games ---
// The `key` format matches `recentGames`: steam-game-<appid> / heroic-game-<appName> / retroarch:<system>:<label>.
function gameRowKey(row) {
    if (row.source === 'steam') return `steam-game-${row.appid}`;
    if (row.source === 'lutris') return `lutris-game-${row.lutrisId}`;
    if (GAME_SOURCE_BY_ID[row.source]) return `heroic-game-${row.appName}`; // gog / legendary / nile
    return null;
}

// Turns a raw `list-games` entry into the `gamesPanelRows` schema — a separate helper so the field filtering is testable (the id field
// differing per `source` — Steam `appid`, Heroic `appName`, Lutris `lutrisId` — must ALL be carried over, otherwise `launch(row)` of
// `GAME_SOURCES` sends an `undefined` id to the launch IPC; this once broke launching Lutris games).
// The rows of `list-custom-games` → `custom-game` root rows; the badge is the launcher name (games of a launcher no longer added are left
// out). Pure — `launcherList` is the renderer's `launchers`.
function customGameRowsFromApi(items, launcherList) {
    const names = new Map((launcherList || []).map((l) => [l.id, l.name]));
    return (Array.isArray(items) ? items : [])
        .filter((g) => names.has(g.launcherId))
        .map((g) => ({ type: 'custom-game', ...g, badge: String(names.get(g.launcherId)).toUpperCase() }));
}

function gameListRowFromApi(g) {
    return {
        type: 'game', name: g.name, source: g.source, appid: g.appid, appName: g.appName,
        lutrisId: g.lutrisId, cover: g.cover || null,
    };
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        GAME_SOURCES, GAME_SOURCE_BY_ID, EMULATOR_SOURCES, EMULATOR_SOURCE_BY_ID, EMULATOR_SOURCE_BY_TYPE,
        SOURCE_FILTER_LABELS, LAUNCHER_ID_TO_GAMES_SOURCE, LAUNCHER_GAMES_COUNT_CHECK,
        HEROIC_SOURCE_PRIORITY, pickHeroicSource, gameRowKey, gameListRowFromApi, customGameRowsFromApi,
    });
}
