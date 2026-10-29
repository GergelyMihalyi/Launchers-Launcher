// @ts-check
'use strict';

// RPCS3 (PS3 emulator) installed-game discovery.
// No own folder walk: RPCS3's `games.yml` (`<TITLE_ID>: <path>`) already is the authoritative installed list.
// Title + cover come from the `PARAM.SFO` + `ICON0.PNG` of the registered path (disc-based: `<path>/PS3_GAME/…`, HDD/PKG: `<path>/…` —
// the latter not tested on the machine); `ICON0.PNG` is a ready PNG, `cover` points to it directly.
// "Recently played" + playtime: from the `[LastPlayed]`/`[Playtime]` sections of `GuiConfigs/persistent_settings.dat` (a `.dat`
// extension, but plain-text Qt IniFormat), at READ time. Details: docs/dev/launchers/rpcs3.md

const fs = require('fs');
const path = require('path');
const os = require('os');
const { flatpakConfigRoot } = require('../xdg.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { buildRecentEntries } = require('../recent/recent-games.js');

const RPCS3_FLATPAK_ID = 'net.rpcs3.RPCS3';

// The native (AppImage) config root is `~/.config/rpcs3`; the flatpak variant's follows the usual `flatpakConfigRoot` pattern. The caller
// decides which one to pass, by the `cmd` of the actually added RPCS3 launcher — this module only describes the TWO possible roots.
function rpcs3ConfigRoot(homeDir = os.homedir()) {
    return path.join(homeDir, '.config', 'rpcs3');
}

function rpcs3FlatpakConfigRoot() {
    return flatpakConfigRoot(RPCS3_FLATPAK_ID, 'rpcs3');
}

// `games.yml` — one `<TITLE_ID>: <path>` per line (the Qt YAML writer's simple, single-level mapping — no nesting/lists, no full YAML
// parser needed). The path is the rest of the line after the first ": " (Windows paths could contain ": " after a drive letter, but on
// this Linux kiosk machine it is always a plain UNIX path).
function parseGamesYaml(text) {
    const map = new Map();
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
        const m = /^([A-Za-z0-9]{4,16}):\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        map.set(m[1], m[2]);
    }
    return map;
}

function readGamesYaml(configRoot) {
    try {
        return parseGamesYaml(fs.readFileSync(path.join(configRoot, 'games.yml'), 'utf8'));
    } catch (err) {
        return new Map();
    }
}

// Minimal PARAM.SFO parser (the shared binary metadata format of PS3/PSP/Vita) — lives in `lib/launchers/shared/param-sfo.js` (shared
// with `lib/launchers/ppsspp-library.js`); only re-exported here (callers + `test/launchers/rpcs3-library.test.js` import `parseParamSfo`
// from this module).
const { parseParamSfo } = require('./shared/param-sfo.js');

// The two layouts of PARAM.SFO / ICON0.PNG — returns the first existing path.
function firstExisting(paths) {
    for (const p of paths) {
        try {
            if (fs.statSync(p).isFile()) return p;
        } catch (err) { /* try the next one */ }
    }
    return null;
}

function resolveParamSfoPath(gameDir) {
    return firstExisting([
        path.join(gameDir, 'PS3_GAME', 'PARAM.SFO'),
        path.join(gameDir, 'PARAM.SFO'),
    ]);
}

function resolveIconPath(gameDir) {
    return firstExisting([
        path.join(gameDir, 'PS3_GAME', 'ICON0.PNG'),
        path.join(gameDir, 'ICON0.PNG'),
    ]);
}

// The `[LastPlayed]` / `[Playtime]` sections of `GuiConfigs/persistent_settings.dat` (plain-text Qt IniFormat). The `LastPlayed` value is
// local time without a time zone (`"YYYY-MM-DDTHH:MM:SS"`) — `Date.parse` reads it as local time, which is enough for sorting/comparison
// (only the order matters, not absolute UTC accuracy).
function parsePersistentSettings(text) {
    const lastPlayed = new Map();
    const playtimeMs = new Map();
    let section = null;
    for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const sec = /^\[(.+)\]$/.exec(line);
        if (sec) { section = sec[1]; continue; }
        const kv = /^([A-Za-z0-9]{4,16})=(.+)$/.exec(line);
        if (!kv || !section) continue;
        const [, titleId, value] = kv;
        if (section === 'LastPlayed') {
            const ms = Date.parse(value);
            if (Number.isFinite(ms)) lastPlayed.set(titleId, ms);
        } else if (section === 'Playtime') {
            const ms = Number(value);
            if (Number.isFinite(ms)) playtimeMs.set(titleId, ms);
        }
    }
    return { lastPlayed, playtimeMs };
}

function readPersistentSettings(configRoot) {
    try {
        const text = fs.readFileSync(path.join(configRoot, 'GuiConfigs', 'persistent_settings.dat'), 'utf8');
        return parsePersistentSettings(text);
    } catch (err) {
        return { lastPlayed: new Map(), playtimeMs: new Map() };
    }
}

// The games registered in `games.yml`, enriched with PARAM.SFO/ICON0.PNG + playtime/last-played data from `persistent_settings.dat`. The
// `games.yml` KEY (the TITLE_ID) is the stable id — no path-hash substitute needed, there is always a value.
function findInstalledGames(configRoot) {
    const registry = readGamesYaml(configRoot);
    const { lastPlayed, playtimeMs } = readPersistentSettings(configRoot);

    const games = [];
    for (const [titleId, gameDir] of registry) {
        const sfoPath = resolveParamSfoPath(gameDir);
        let sfo = {};
        if (sfoPath) {
            try { sfo = parseParamSfo(fs.readFileSync(sfoPath)); } catch (err) { sfo = {}; }
        }
        const name = (typeof sfo.TITLE === 'string' && sfo.TITLE.trim()) ? sfo.TITLE.trim() : titleId;
        games.push({
            id: titleId,
            name,
            titleId,
            path: gameDir,
            cover: resolveIconPath(gameDir),
            lastPlayedAt: lastPlayed.has(titleId) ? lastPlayed.get(titleId) : null,
            playtimeMs: playtimeMs.has(titleId) ? playtimeMs.get(titleId) : 0,
        });
    }
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}

// TTL-cached variant for the `list-rpcs3-games` IPC (the raw `findInstalledGames` stays pure for tests).
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

// "Recently played": calls `findInstalledGamesCached()` (NOT the raw `findInstalledGames`) with a single `configRoot` argument — the same
// `createTtlCache` key as the `list-rpcs3-games` IPC, so the expensive scan runs once.
// ⚠️ `lastLaunchedAt` must be an ISO 8601 STRING, not a raw ms number (`mergeRecentGameLists` calls `Date.parse` on it, and with NaN the
// item would vanish from the Continue lists) — guaranteed by `buildRecentEntries`.
function findRecentlyPlayed(configRoot, max = 3) {
    return buildRecentEntries(findInstalledGamesCached(configRoot), {
        timeMs: (g) => g.lastPlayedAt,
        max,
        key: (g) => `rpcs3-game-${g.titleId}`,
        kind: 'rpcs3',
        params: (g) => ({ titleId: g.titleId }),
    });
}

module.exports = {
    RPCS3_FLATPAK_ID,
    rpcs3ConfigRoot,
    rpcs3FlatpakConfigRoot,
    parseGamesYaml,
    parseParamSfo,
    parsePersistentSettings,
    readPersistentSettings,
    resolveParamSfoPath,
    resolveIconPath,
    findInstalledGames,
    findInstalledGamesCached,
    findRecentlyPlayed,
};
