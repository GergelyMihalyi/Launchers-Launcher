'use strict';

// lib/launchers/steam-library.js — Steam library discovery.
// parseLibraryFolders/parseAppManifest get sample files (anonymized content copied from the
// machine), findInstalledGames walks a fake Steam install built in a temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');
const {
    parseLibraryFolders, parseAppManifest, isInstalled, isLikelyTool, findInstalledGames, findRecentlyPlayed,
    resolveSteamCover, isSteamRunning, steamClientPid, defaultSteamRoot, findInstalledGamesCached,
} = require('../../lib/launchers/steam-library.js');

test('defaultSteamRoot — native first, flatpak fallback, neither → native path (launcher-model-v2 D)', () => {
    const home = tmpDir('gl-steamroot-');
    const native = path.join(home, '.steam', 'steam');
    const flatpak = path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam');
    // neither → native path
    assert.equal(defaultSteamRoot(home), native);
    // flatpak only
    fs.mkdirSync(flatpak, { recursive: true });
    assert.equal(defaultSteamRoot(home), flatpak);
    // native too → it wins
    fs.mkdirSync(native, { recursive: true });
    assert.equal(defaultSteamRoot(home), native);
});

test('defaultSteamRoot — the variant of the added Steam (lib/xdg.js) takes precedence, with both installed too', () => {
    const { setAppVariants } = require('../../lib/xdg.js');
    const home = tmpDir('gl-steam-variant-');
    const native = path.join(home, '.steam', 'steam');
    const flatpak = path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam');
    fs.mkdirSync(native, { recursive: true });
    fs.mkdirSync(flatpak, { recursive: true });
    try {
        assert.equal(defaultSteamRoot(home), native); // unknown variant → the old native precedence
        setAppVariants({ 'com.valvesoftware.Steam': 'flatpak' });
        assert.equal(defaultSteamRoot(home), flatpak);
        setAppVariants({ 'com.valvesoftware.Steam': 'native' });
        assert.equal(defaultSteamRoot(home), native);
    } finally {
        setAppVariants({});
    }
});

const SAMPLE_LIBRARYFOLDERS = `"libraryfolders"
{
	"0"
	{
		"path"		"/home/user/.local/share/Steam"
		"label"		""
		"contentid"		"123456789"
		"apps"
		{
			"228980"		"1005286036"
			"1091500"		"66366228927"
		}
	}
	"1"
	{
		"path"		"/mnt/games/SteamLibrary"
		"label"		"external"
		"apps"
		{
			"377160"		"12345"
		}
	}
}
`;

function acf({ appid, name, stateFlags, lastPlayed }) {
    const lp = lastPlayed === undefined ? '' : `\t"LastPlayed"\t\t"${lastPlayed}"\n`;
    return `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"Universe"\t\t"1"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"${stateFlags}"\n${lp}\t"installdir"\t\t"${name}"\n}\n`;
}

test('parseLibraryFolders — extracts every "path" key, not just the first', () => {
    assert.deepEqual(parseLibraryFolders(SAMPLE_LIBRARYFOLDERS), [
        '/home/user/.local/share/Steam',
        '/mnt/games/SteamLibrary',
    ]);
});

test('parseLibraryFolders — an empty array for missing/empty input', () => {
    assert.deepEqual(parseLibraryFolders(''), []);
});

test('parseAppManifest — extracting appid/name/StateFlags/LastPlayed', () => {
    const m = parseAppManifest(acf({ appid: '1091500', name: 'Cyberpunk 2077', stateFlags: '4', lastPlayed: '1788717276' }));
    assert.deepEqual(m, { appid: '1091500', name: 'Cyberpunk 2077', stateFlags: 4, lastPlayed: 1788717276 });
});

test('parseAppManifest — missing LastPlayed -> 0', () => {
    const m = parseAppManifest(acf({ appid: '400', name: 'Portal', stateFlags: '4' }));
    assert.equal(m.lastPlayed, 0);
});

test('parseAppManifest — null for a missing appid/name', () => {
    assert.equal(parseAppManifest('"AppState"\n{\n\t"StateFlags"\t\t"4"\n}\n'), null);
});

test('isInstalled — bit 4 decides, a bitmask combination (e.g. 6) counts as installed too', () => {
    assert.equal(isInstalled({ stateFlags: 4 }), true);
    // Combination seen on a real machine: 6 = 4|2 ("update required" + installed).
    assert.equal(isInstalled({ stateFlags: 6 }), true);
    assert.equal(isInstalled({ stateFlags: 2 }), false); // only "update required", not installed
    assert.equal(isInstalled(null), false);
});

test('isLikelyTool — recognizes Valve runtime/compat packages, not a real game', () => {
    assert.equal(isLikelyTool('Steam Linux Runtime 1.0 (scout)'), true);
    assert.equal(isLikelyTool('Proton Experimental'), true);
    assert.equal(isLikelyTool('Proton Hotfix'), true);
    assert.equal(isLikelyTool('Steamworks Common Redistributables'), true);
    assert.equal(isLikelyTool('Cyberpunk 2077'), false);
    assert.equal(isLikelyTool('Protontricks-like Adventure'), false); // the "Proton" prefix must not be too greedy
});

test('findInstalledGames — walks the library folders, filters out non-installed and tool entries', () => {
    const root = tmpDir('gl-steam-');
    const mainLib = path.join(root, 'steam');
    const externalLib = tmpDir('gl-steam-ext-');

    fs.mkdirSync(path.join(mainLib, 'steamapps'), { recursive: true });
    fs.writeFileSync(
        path.join(mainLib, 'steamapps', 'libraryfolders.vdf'),
        SAMPLE_LIBRARYFOLDERS
            .replace('/home/user/.local/share/Steam', mainLib)
            .replace('/mnt/games/SteamLibrary', externalLib),
    );
    fs.writeFileSync(
        path.join(mainLib, 'steamapps', 'appmanifest_1091500.acf'),
        acf({ appid: '1091500', name: 'Cyberpunk 2077', stateFlags: '4' }),
    );
    fs.writeFileSync(
        path.join(mainLib, 'steamapps', 'appmanifest_1070560.acf'),
        acf({ appid: '1070560', name: 'Steam Linux Runtime 1.0 (scout)', stateFlags: '4' }),
    );
    fs.writeFileSync(
        path.join(mainLib, 'steamapps', 'appmanifest_612640.acf'),
        acf({ appid: '612640', name: 'Not Installed Yet', stateFlags: '0' }),
    );

    fs.mkdirSync(path.join(externalLib, 'steamapps'), { recursive: true });
    fs.writeFileSync(
        path.join(externalLib, 'steamapps', 'appmanifest_377160.acf'),
        acf({ appid: '377160', name: 'Fallout 4', stateFlags: '4' }),
    );

    const games = findInstalledGames(mainLib);
    assert.deepEqual(games, [
        { appid: '1091500', name: 'Cyberpunk 2077', cover: null, lastPlayed: 0 },
        { appid: '377160', name: 'Fallout 4', cover: null, lastPlayed: 0 },
    ]);
});

test('findRecentlyPlayed — LastPlayed desc, LastPlayed==0 skipped, recentGames shape', () => {
    const root = tmpDir('gl-steam-recent-');
    const lib = path.join(root, 'steam');
    fs.mkdirSync(path.join(lib, 'steamapps'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'steamapps', 'libraryfolders.vdf'),
        SAMPLE_LIBRARYFOLDERS.replace('/home/user/.local/share/Steam', lib).replace('/mnt/games/SteamLibrary', lib));
    fs.writeFileSync(path.join(lib, 'steamapps', 'appmanifest_10.acf'),
        acf({ appid: '10', name: 'Old', stateFlags: '4', lastPlayed: '1000' }));
    fs.writeFileSync(path.join(lib, 'steamapps', 'appmanifest_20.acf'),
        acf({ appid: '20', name: 'New', stateFlags: '4', lastPlayed: '2000' }));
    fs.writeFileSync(path.join(lib, 'steamapps', 'appmanifest_30.acf'),
        acf({ appid: '30', name: 'Sose', stateFlags: '4', lastPlayed: '0' }));

    const recent = findRecentlyPlayed(lib, 3);
    assert.deepEqual(recent.map((r) => r.key), ['steam-game-20', 'steam-game-10']);
    assert.deepEqual(recent[0], {
        key: 'steam-game-20', name: 'New', cover: null, kind: 'steam',
        params: { appid: '20' }, lastLaunchedAt: new Date(2000 * 1000).toISOString(),
    });
    assert.deepEqual(findRecentlyPlayed(lib, 1).map((r) => r.key), ['steam-game-20']);
});

test('findRecentlyPlayed — shares the SAME cache as findInstalledGamesCached (no double scanning)', () => {
    const root = tmpDir('gl-steam-recent-');
    const lib = path.join(root, 'steam');
    fs.mkdirSync(path.join(lib, 'steamapps'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'steamapps', 'libraryfolders.vdf'),
        SAMPLE_LIBRARYFOLDERS.replace('/home/user/.local/share/Steam', lib).replace('/mnt/games/SteamLibrary', lib));
    fs.writeFileSync(path.join(lib, 'steamapps', 'appmanifest_10.acf'),
        acf({ appid: '10', name: 'Old', stateFlags: '4', lastPlayed: '1000' }));

    // The `list-games` IPC (Games panel) warms the cache with the same argument (steamRoot)
    // that findRecentlyPlayed uses.
    assert.equal(findInstalledGamesCached(lib).length, 1);

    // The app manifest disappears — a fresh (uncached) scan would return an empty list from now on.
    fs.rmSync(path.join(lib, 'steamapps', 'appmanifest_10.acf'));
    const stillCached = findRecentlyPlayed(lib, 3);
    assert.equal(stillCached.length, 1, 'findRecentlyPlayed reads from the SHARED cache, does not rescan');

    findInstalledGamesCached.invalidate();
    assert.equal(findRecentlyPlayed(lib, 3).length, 0, 'after invalidate() the result is fresh (empty)');
});

test('resolveSteamCover — flat 600x900, hash-subfolder capsule, header fallback, finally null', () => {
    const cacheDir = tmpDir('gl-steam-cover-');

    // 1) older, flat layout: <appid>/library_600x900.jpg
    fs.mkdirSync(path.join(cacheDir, '10'));
    fs.writeFileSync(path.join(cacheDir, '10', 'library_600x900.jpg'), 'x');
    assert.equal(resolveSteamCover(cacheDir, '10'), path.join(cacheDir, '10', 'library_600x900.jpg'));

    // 2) newer, hash-subfolder layout: <appid>/<hash>/library_capsule.jpg
    fs.mkdirSync(path.join(cacheDir, '20', 'abc123'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '20', 'abc123', 'library_capsule.jpg'), 'x');
    assert.equal(resolveSteamCover(cacheDir, '20'), path.join(cacheDir, '20', 'abc123', 'library_capsule.jpg'));

    // 3) only a landscape header (no portrait, no capsule)
    fs.mkdirSync(path.join(cacheDir, '30'));
    fs.writeFileSync(path.join(cacheDir, '30', 'header.jpg'), 'x');
    assert.equal(resolveSteamCover(cacheDir, '30'), path.join(cacheDir, '30', 'header.jpg'));

    // 4) nothing -> null
    assert.equal(resolveSteamCover(cacheDir, '40'), null);
});

test('findInstalledGames — an empty array for a missing libraryfolders.vdf (Steam not installed)', () => {
    const root = tmpDir('gl-steam-missing-');
    assert.deepEqual(findInstalledGames(root), []);
});

test('isSteamRunning — true for a live PID (with that of the test process itself, without mocking)', () => {
    const home = tmpDir('gl-steam-pid-');
    fs.mkdirSync(path.join(home, '.steam'), { recursive: true });
    fs.writeFileSync(path.join(home, '.steam', 'steam.pid'), String(process.pid));
    assert.equal(isSteamRunning(home), true);
});

test('isSteamRunning — false for a nonexistent PID', () => {
    const home = tmpDir('gl-steam-pid-dead-');
    fs.mkdirSync(path.join(home, '.steam'), { recursive: true });
    // On a real machine this PID is almost surely not running - but if it happens to be, the test
    // still behaves correctly (the point is that it does not throw).
    fs.writeFileSync(path.join(home, '.steam', 'steam.pid'), '999999999');
    assert.equal(isSteamRunning(home), false);
});

test('isSteamRunning — false for a missing steam.pid (not an error)', () => {
    const home = tmpDir('gl-steam-pid-missing-');
    assert.equal(isSteamRunning(home), false);
});

test('steamClientPid — gives the number for a live PID, null for a dead/missing one', () => {
    const live = tmpDir('gl-steam-cpid-');
    fs.mkdirSync(path.join(live, '.steam'), { recursive: true });
    fs.writeFileSync(path.join(live, '.steam', 'steam.pid'), String(process.pid));
    assert.equal(steamClientPid(live), process.pid);

    const dead = tmpDir('gl-steam-cpid-dead-');
    fs.mkdirSync(path.join(dead, '.steam'), { recursive: true });
    fs.writeFileSync(path.join(dead, '.steam', 'steam.pid'), '999999999');
    assert.equal(steamClientPid(dead), null);

    const missing = tmpDir('gl-steam-cpid-missing-');
    assert.equal(steamClientPid(missing), null);
});

test('steamClientPid — does NOT read the steam.pid of the flatpak sandbox (namespace-internal PID, meaningless on the host)', () => {
    const home = tmpDir('gl-steam-cpid-flatpak-');
    const dir = path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'steam.pid'), String(process.pid)); // live pid — still does not count
    assert.equal(steamClientPid(home), null);
});
