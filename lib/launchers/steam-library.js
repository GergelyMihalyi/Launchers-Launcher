// @ts-check
'use strict';

// Steam library discovery — pure parsers (regex, no I/O) + a thin merging function that reads the filesystem.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createTtlCache, GAMES_CACHE_TTL_MS } = require('../ttl-cache.js');
const { buildRecentEntries } = require('../recent/recent-games.js');
const { flatpakRunAppId } = require('../flatpak.js');
const { appVariant } = require('../xdg.js');

const STEAM_FLATPAK_ID = 'com.valvesoftware.Steam';

// "Is this launcher Steam?" — ONE definition: id `'steam'` OR native `cmd: 'steam'` OR flatpak `com.valvesoftware.Steam`
// (with any id — e.g. added from the flatpak app browser).
function isSteamLauncher(l) {
    return !!l && (l.id === 'steam' || l.cmd === 'steam'
        || (l.cmd === 'flatpak' && flatpakRunAppId(l.args) === STEAM_FLATPAK_ID));
}

// The "path" keys of libraryfolders.vdf can be extracted globally with one regex — the keys in the "apps" sub-block are appid:size
// pairs (not "path"), so the full braced VDF tree need not be built with a tree parser.
function parseLibraryFolders(vdfText) {
    const paths = [];
    const re = /"path"\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(String(vdfText)))) paths.push(m[1]);
    return paths;
}

// appmanifest_<id>.acf -> { appid, name, stateFlags, lastPlayed } or null if the required fields (appid/name) are missing.
// `LastPlayed` is a Unix timestamp (s), 0 if never played — Steam updates it on launch, so "recently played" comes from here,
// whether the game was started from our Games panel or from Steam Big Picture.
function parseAppManifest(acfText) {
    const text = String(acfText);
    const appid = text.match(/"appid"\s*"(\d+)"/);
    const name = text.match(/"name"\s*"([^"]*)"/);
    const stateFlags = text.match(/"StateFlags"\s*"(\d+)"/);
    const lastPlayed = text.match(/"LastPlayed"\s*"(\d+)"/);
    if (!appid || !name) return null;
    return {
        appid: appid[1],
        name: name[1],
        stateFlags: stateFlags ? parseInt(stateFlags[1], 10) : 0,
        lastPlayed: lastPlayed ? parseInt(lastPlayed[1], 10) : 0,
    };
}

// Bit 0x4 of the StateFlags bitmask = "Fully Installed". Real manifests on the machine also have 6 (=4|2, "update required" +
// installed) for installed games — a strict "=== 4" would skip them, hence the bitmask test.
function isInstalled(manifest) {
    return !!(manifest && (manifest.stateFlags & 4));
}

// Known Valve runtime/compat-tool packages that technically show up as "installed apps" in the steamapps folder (with their own
// appmanifest_*.acf) but are not launchable games. Name-pattern based, best-effort filter — the exact "app type" would only come from
// the binary appinfo.vdb cache.
const TOOL_NAME_PATTERN = /^(Steam Linux Runtime|Proton\b|Steamworks Common Redistributables|SteamVR)/i;

function isLikelyTool(name) {
    return TOOL_NAME_PATTERN.test(String(name));
}

// --- Cover discovery ---
// Steam loads the grid images into the client cache; the layout depends on version/install, two patterns coexist on the machine:
//   - older, flat:          appcache/librarycache/<appid>/library_600x900.jpg
//   - newer, hash subfolder: appcache/librarycache/<appid>/<sha1>/library_capsule.jpg (300x450 portrait)
// Landscape fallback: <appid>/<sha1>/library_header.jpg or <appid>/header.jpg (460x215).
// No image -> null (the grid shows the launcher icon / title), never throws.

function steamLibraryCacheDir(steamRoot) {
    return path.join(steamRoot, 'appcache', 'librarycache');
}

function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    } catch (err) {
        return false;
    }
}

// Looks for one of `names` in the direct subfolders of `dir` (name order = preference), deterministically (sorted by subfolder name).
function findInSubdirs(dir, names) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return null;
    }
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const name of names) {
        for (const d of subdirs) {
            const p = path.join(dir, d, name);
            if (isFile(p)) return p;
        }
    }
    return null;
}

function resolveSteamCover(cacheDir, appid) {
    const appDir = path.join(cacheDir, String(appid));
    const portrait = [
        path.join(appDir, 'library_600x900.jpg'),
        path.join(cacheDir, `${appid}_library_600x900.jpg`),
    ];
    for (const p of portrait) if (isFile(p)) return p;

    const sub = findInSubdirs(appDir, ['library_capsule.jpg', 'library_header.jpg']);
    if (sub) return sub;

    const header = path.join(appDir, 'header.jpg');
    return isFile(header) ? header : null;
}

// Starting from the steamapps/libraryfolders.vdf of steamRoot (e.g. ~/.steam/steam), walks every library folder, reads the
// appmanifest_*.acf files and returns the installed, non-tool games sorted by name. Missing/unreadable file → empty array (best
// effort, Steam not installed -> not an error).
function findInstalledGames(steamRoot) {
    const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
    let libraryPaths = [];
    try {
        libraryPaths = parseLibraryFolders(fs.readFileSync(vdfPath, 'utf8'));
    } catch (err) {
        // no libraryfolders.vdf (Steam not installed / never run) -> empty list
    }
    if (!libraryPaths.length) libraryPaths = [steamRoot];

    const cacheDir = steamLibraryCacheDir(steamRoot);
    const games = [];
    const seenIds = new Set();
    for (const libPath of libraryPaths) {
        const steamappsDir = path.join(libPath, 'steamapps');
        let files;
        try {
            files = fs.readdirSync(steamappsDir).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
        } catch (err) {
            continue;
        }
        for (const file of files) {
            let manifest;
            try {
                manifest = parseAppManifest(fs.readFileSync(path.join(steamappsDir, file), 'utf8'));
            } catch (err) {
                continue;
            }
            if (!manifest || seenIds.has(manifest.appid)) continue;
            if (!isInstalled(manifest) || isLikelyTool(manifest.name)) continue;
            seenIds.add(manifest.appid);
            games.push({
                appid: manifest.appid,
                name: manifest.name,
                cover: resolveSteamCover(cacheDir, manifest.appid),
                lastPlayed: manifest.lastPlayed || 0,
            });
        }
    }
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu'));
    return games;
}

// The most recently played (at most `max`) installed Steam games, as `recentGames` entries, for the quick-launch bar. Steam updates
// `LastPlayed`, so games started from Big Picture are caught too; `LastPlayed == 0` is skipped. Calls `findInstalledGamesCached()`
// (the `list-games` IPC reads the same cache → the expensive disk scan runs ONCE for close calls).
function findRecentlyPlayed(steamRoot, max = 3) {
    return buildRecentEntries(findInstalledGamesCached(steamRoot), {
        timeMs: (g) => g.lastPlayed * 1000,
        max,
        key: (g) => `steam-game-${g.appid}`,
        kind: 'steam',
        params: (g) => ({ appid: g.appid }),
    });
}

// Native OR flatpak Steam root. First `~/.steam/steam` (native), if missing → `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`
// (flatpak). Neither → the native path (callers return an empty list). `homeDir` is injectable for tests. The variant of the added
// Steam launcher (lib/xdg.js `appVariant`) takes precedence — with both installed we read the chosen client's library.
function defaultSteamRoot(homeDir = os.homedir()) {
    const native = path.join(homeDir, '.steam', 'steam');
    const flatpak = path.join(homeDir, '.var', 'app', STEAM_FLATPAK_ID, '.local', 'share', 'Steam');
    const variant = appVariant(STEAM_FLATPAK_ID);
    if (variant === 'native') return native;
    if (variant === 'flatpak') return flatpak;
    try { if (fs.existsSync(native)) return native; } catch (err) { /* fallthrough */ }
    try { if (fs.existsSync(flatpak)) return flatpak; } catch (err) { /* fallthrough */ }
    return native;
}

// Is the Steam client running, based on `~/.steam/steam.pid`. The most reliable signal available: the existence of `steam.pipe` alone
// does not mean a live listener, while the `.pid` can be tested (`process.kill(pid, 0)`, ESRCH = no such process). Best effort: if the
// PID has been reused by another process, it may be a false positive.
function isSteamRunning(homeDir) {
    return steamClientPid(homeDir) !== null;
}

// PID of the running Steam client's main process from `~/.steam/steam.pid` if it is alive (`process.kill(pid, 0)`), otherwise null —
// for the "launcher already running" detection (`lib/launch/running.js`). Best effort (theoretical PID reuse).
// ONLY the native Steam: the flatpak Steam's `steam.pid` is a number in the sandbox's OWN PID namespace (in production the running
// flatpak Steam never showed as running this way) — `running.js` detects that one with `flatpak ps`.
function steamClientPid(homeDir) {
    const candidates = [path.join(homeDir, '.steam', 'steam.pid')];
    for (const p of candidates) {
        try {
            const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
            if (!pid) continue;
            process.kill(pid, 0);
            return pid;
        } catch (err) { /* next candidate */ }
    }
    return null;
}

// TTL-cached variant for the `list-games` IPC — the raw `findInstalledGames` stays pure for tests.
const findInstalledGamesCached = createTtlCache(findInstalledGames, GAMES_CACHE_TTL_MS);

module.exports = {
    parseLibraryFolders,
    parseAppManifest,
    isInstalled,
    isLikelyTool,
    findInstalledGames,
    findInstalledGamesCached,
    findRecentlyPlayed,
    steamLibraryCacheDir,
    resolveSteamCover,
    defaultSteamRoot,
    isSteamRunning,
    steamClientPid,
    isSteamLauncher,
    STEAM_FLATPAK_ID,
};
