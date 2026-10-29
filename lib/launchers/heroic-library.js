// @ts-check
'use strict';

// Heroic library discovery. For every store (GOG / Epic-legendary / Amazon-nile) Heroic maintains two files: an "install info" file
// (the authoritative list of ACTUALLY installed apps) and a "library" cache (title, cover URL of every KNOWN app).
// ⚠️ The `is_installed` field of the library cache is STALE (verified on the machine) — always take the FACT of installation from the
// install-info file, use the library cache only to resolve title/image. Background: docs/dev/launchers/heroic.md

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appConfigRoot } = require('../xdg.js');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');

function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return null;
    }
}

// gog_store/installed.json -> the actually installed GOG appNames (without DLCs).
function parseGogInstalled(data) {
    const list = (data && Array.isArray(data.installed)) ? data.installed : [];
    return list.filter((e) => !e.is_dlc).map((e) => e.appName);
}

// store_cache/gog_library.json -> { appName: title } resolver map.
function parseGogLibrary(data) {
    const games = (data && Array.isArray(data.games)) ? data.games : [];
    const titles = new Map();
    for (const g of games) titles.set(g.app_name, g.title);
    return titles;
}

// store_cache/legendary_install_info.json -> the actually installed Epic appNames
// (the top of the file also has a "__timestamp" field, which must be skipped).
function parseLegendaryInstalled(data) {
    return Object.keys(data || {}).filter((k) => k !== '__timestamp');
}

// store_cache/legendary_library.json -> { appName: title } resolver map.
function parseLegendaryLibrary(data) {
    const list = (data && Array.isArray(data.library)) ? data.library : [];
    const titles = new Map();
    for (const g of list) titles.set(g.app_name, g.title);
    return titles;
}

// Amazon (nile) follows the same two-file pattern as legendary (Epic).
const parseNileInstalled = parseLegendaryInstalled;
const parseNileLibrary = parseLegendaryLibrary;

// The flatpak app ID appears in code ONLY here (test/contracts/flatpak-ids.test.js).
const HEROIC_FLATPAK_ID = 'com.heroicgameslauncher.hgl';

function heroicConfigRoot() {
    return appConfigRoot(HEROIC_FLATPAK_ID, 'heroic'); // native: ~/.config/heroic
}

// --- Cover discovery ---
// Heroic downloads the REMOTE `art_square` / `art_cover` URLs of store_cache/*_library.json into the config's images-cache/ folder,
// file name = `sha256(<url>)` hex (found in the app.asar's `getImageFromCache`: `createHash("sha256").update(realUrl)`).
// `art_square` is the portrait ("box art"); if it is not cached (common for Epic), `art_cover` is the fallback. No cache file -> null,
// never throws.

function heroicImagesCacheDir(heroicRoot) {
    return path.join(heroicRoot, 'images-cache');
}

// listKey: 'games' (GOG) or 'library' (legendary/nile) -> Map<app_name, raw entry>.
function libraryEntriesByName(data, listKey) {
    const list = (data && Array.isArray(data[listKey])) ? data[listKey] : [];
    const m = new Map();
    for (const g of list) if (g && g.app_name) m.set(g.app_name, g);
    return m;
}

function resolveHeroicCover(imagesCacheDir, entry) {
    if (!entry) return null;
    for (const url of [entry.art_square, entry.art_cover]) {
        if (!url || typeof url !== 'string') continue;
        const digest = crypto.createHash('sha256').update(url).digest('hex');
        const p = path.join(imagesCacheDir, digest);
        try {
            if (fs.statSync(p).isFile()) return p;
        } catch (err) {
            // not downloaded -> next candidate
        }
    }
    return null;
}

// Merging the three store sources — a missing file (the store was never used on this machine, e.g. nile/Amazon here) is skipped as
// best effort, not an error.
function findInstalledGames(heroicRoot) {
    const games = [];
    const imagesDir = heroicImagesCacheDir(heroicRoot);

    const gogInstalled = readJsonSafe(path.join(heroicRoot, 'gog_store', 'installed.json'));
    if (gogInstalled) {
        const lib = readJsonSafe(path.join(heroicRoot, 'store_cache', 'gog_library.json'));
        const titles = parseGogLibrary(lib);
        const entries = libraryEntriesByName(lib, 'games');
        for (const appName of parseGogInstalled(gogInstalled)) {
            games.push({
                appName, name: titles.get(appName) || appName, runner: 'gog',
                cover: resolveHeroicCover(imagesDir, entries.get(appName)),
            });
        }
    }

    const legendaryInstalled = readJsonSafe(path.join(heroicRoot, 'store_cache', 'legendary_install_info.json'));
    if (legendaryInstalled) {
        const lib = readJsonSafe(path.join(heroicRoot, 'store_cache', 'legendary_library.json'));
        const titles = parseLegendaryLibrary(lib);
        const entries = libraryEntriesByName(lib, 'library');
        for (const appName of parseLegendaryInstalled(legendaryInstalled)) {
            games.push({
                appName, name: titles.get(appName) || appName, runner: 'legendary',
                cover: resolveHeroicCover(imagesDir, entries.get(appName)),
            });
        }
    }

    const nileInstalled = readJsonSafe(path.join(heroicRoot, 'store_cache', 'nile_install_info.json'));
    if (nileInstalled) {
        const lib = readJsonSafe(path.join(heroicRoot, 'store_cache', 'nile_library.json'));
        const titles = parseNileLibrary(lib);
        const entries = libraryEntriesByName(lib, 'library');
        for (const appName of parseNileInstalled(nileInstalled)) {
            games.push({
                appName, name: titles.get(appName) || appName, runner: 'nile',
                cover: resolveHeroicCover(imagesDir, entries.get(appName)),
            });
        }
    }

    games.sort((a, b) => a.name.localeCompare(b.name, 'hu'));
    return games;
}

// TTL-cached variant for the `list-games` IPC — the raw `findInstalledGames` stays pure for tests.
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

module.exports = {
    HEROIC_FLATPAK_ID,
    parseGogInstalled,
    parseGogLibrary,
    parseLegendaryInstalled,
    parseLegendaryLibrary,
    parseNileInstalled,
    parseNileLibrary,
    libraryEntriesByName,
    findInstalledGames,
    findInstalledGamesCached,
    heroicImagesCacheDir,
    resolveHeroicCover,
    heroicConfigRoot,
};
