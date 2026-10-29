'use strict';

// lib/prefs.js — reader/writer of the `theme` + `feedback` config keys (on top of lib/config.js).
// XDG_CONFIG_HOME is pointed at a temp directory BEFORE the `require` (like config.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, useTempConfigHome, writeRawConfigKey } = require('./helpers/fs.js');

const { reset } = useTempConfigHome('gl-prefs-');
const config = require('../lib/config.js');
const prefs = require('../lib/prefs.js');

test('getTheme — neon is returned for a missing key', () => {
    reset();
    assert.deepEqual(prefs.getTheme(), { theme: 'neon' });
});

test('setTheme — saves and returns a valid id; unknown -> neon', () => {
    reset();
    assert.deepEqual(prefs.setTheme('nintendo'), { theme: 'nintendo' });
    assert.deepEqual(prefs.getTheme(), { theme: 'nintendo' });
    assert.deepEqual(prefs.setTheme('no-such-theme'), { theme: 'neon' });
    assert.deepEqual(prefs.getTheme(), { theme: 'neon' });
});

test('getTheme — a saved value outside the manifest falls back to neon too', () => {
    reset();
    config.set('theme', { theme: 'some-old-theme' });
    assert.deepEqual(prefs.getTheme(), { theme: 'neon' });
});

test('THEME_IDS — from the manifest, contains neon', () => {
    assert.ok(prefs.THEME_IDS.includes('neon'));
    assert.ok(prefs.THEME_IDS.length >= 5);
});

test('getFeedback — missing key: sound/rumble/motion ON, contrast OFF', () => {
    reset();
    assert.deepEqual(prefs.getFeedback(),
        { sound: true, rumble: true, motion: true, contrast: false, slowRepeat: false, screenReader: false });
});

test('setFeedback — field merge, boolean only; the other fields stay', () => {
    reset();
    assert.deepEqual(prefs.setFeedback({ sound: false }),
        { sound: false, rumble: true, motion: true, contrast: false, slowRepeat: false, screenReader: false });
    assert.deepEqual(prefs.setFeedback({ contrast: true, slowRepeat: false, screenReader: false }),
        { sound: false, rumble: true, motion: true, contrast: true, slowRepeat: false, screenReader: false });
    // a non-boolean value does not overwrite
    assert.deepEqual(prefs.setFeedback({ sound: 'igen' }),
        { sound: false, rumble: true, motion: true, contrast: true, slowRepeat: false, screenReader: false });
});

test('getRecentGamesUi — missing key: all 3 bars ON', () => {
    reset();
    assert.deepEqual(prefs.getRecentGamesUi(),
        { continueBar: true, gamesPanelRecent: true, launcherRecent: true });
});

test('setRecentGamesUi — field merge, boolean only; the other fields stay', () => {
    reset();
    assert.deepEqual(prefs.setRecentGamesUi({ continueBar: false }),
        { continueBar: false, gamesPanelRecent: true, launcherRecent: true });
    assert.deepEqual(prefs.setRecentGamesUi({ launcherRecent: false }),
        { continueBar: false, gamesPanelRecent: true, launcherRecent: false });
    // a non-boolean value does not overwrite
    assert.deepEqual(prefs.setRecentGamesUi({ gamesPanelRecent: 'igen' }),
        { continueBar: false, gamesPanelRecent: true, launcherRecent: false });
});

test('getMainController — missing key / invalid MAC -> null', () => {
    reset();
    assert.equal(prefs.getMainController(), null);
    config.set('mainController', { mac: 'not-a-mac', name: 'x' });
    assert.equal(prefs.getMainController(), null);
});

test('setMainController — saves a valid MAC (uppercased), null deletes it', () => {
    reset();
    const saved = prefs.setMainController({ mac: 'a0:ab:51:12:34:56', name: 'DualSense', type: 'dualsense' });
    assert.deepEqual(saved, { mac: 'A0:AB:51:12:34:56', name: 'DualSense', type: 'dualsense' });
    assert.deepEqual(prefs.getMainController(), { mac: 'A0:AB:51:12:34:56', name: 'DualSense', type: 'dualsense' });
    assert.equal(prefs.setMainController(null), null);
    assert.equal(prefs.getMainController(), null);
    // invalid input -> null (no throw)
    assert.equal(prefs.setMainController({ mac: 'xyz' }), null);
});

test('getTvMode — missing key: all three lists empty', () => {
    reset();
    assert.deepEqual(prefs.getTvMode(), { closeFlatpak: [], closeNative: [], preCommands: [] });
});

test('setTvMode — field merge, array only; the other fields stay', () => {
    reset();
    assert.deepEqual(
        prefs.setTvMode({ closeNative: ['firefox'] }),
        { closeFlatpak: [], closeNative: ['firefox'], preCommands: [] },
    );
    assert.deepEqual(
        prefs.setTvMode({ preCommands: ['x down'] }),
        { closeFlatpak: [], closeNative: ['firefox'], preCommands: ['x down'] },
    );
    // a non-array value does not overwrite
    assert.deepEqual(
        prefs.setTvMode({ closeNative: 'firefox' }),
        { closeFlatpak: [], closeNative: ['firefox'], preCommands: ['x down'] },
    );
});

test('getTvMode — a saved value of the wrong type -> empty lists (does not throw)', () => {
    reset();
    config.set('tvMode', { closeFlatpak: 'not-an-array', closeNative: null });
    assert.deepEqual(prefs.getTvMode(), { closeFlatpak: [], closeNative: [], preCommands: [] });
});

test('getLanguage / setLanguage — whitelist, default hu', () => {
    reset();
    assert.equal(prefs.getLanguage(), 'hu');
    assert.equal(prefs.setLanguage('en'), 'en');
    assert.equal(prefs.getLanguage(), 'en');
    // unknown -> hu
    assert.equal(prefs.setLanguage('de'), 'hu');
    assert.equal(prefs.getLanguage(), 'hu');
    // a config broken by hand
    writeRawConfigKey(config.CONFIG_FILE, 'language', 42);
    assert.equal(prefs.getLanguage(), 'hu');
});

test('getUiScale / setUiScale — whitelist, default normal', () => {
    reset();
    assert.equal(prefs.getUiScale(), 'normal');
    assert.equal(prefs.setUiScale('large'), 'large');
    assert.equal(prefs.getUiScale(), 'large');
    assert.equal(prefs.setUiScale('huge'), 'normal'); // unknown -> normal
    assert.equal(prefs.getUiScale(), 'normal');
    writeRawConfigKey(config.CONFIG_FILE, 'uiScale', ['array']);
    assert.equal(prefs.getUiScale(), 'normal');
});

test('getBackground / setBackground — per-theme map, none default, builtin whitelist, custom path', () => {
    reset();
    assert.deepEqual(prefs.getBackground('neon'), { type: 'none' });
    assert.deepEqual(prefs.getBackgroundMap(), {});

    const builtinId = prefs.backgroundManifest[0].id;
    assert.deepEqual(prefs.setBackground('neon', { type: 'builtin', id: builtinId }), { type: 'builtin', id: builtinId });
    assert.deepEqual(prefs.getBackground('neon'), { type: 'builtin', id: builtinId });
    // other theme untouched
    assert.deepEqual(prefs.getBackground('nord'), { type: 'none' });

    // separate per theme
    prefs.setBackground('nord', { type: 'custom', path: '/home/x/Pictures/a.jpg' });
    assert.deepEqual(prefs.getBackground('nord'), { type: 'custom', path: '/home/x/Pictures/a.jpg' });
    assert.deepEqual(prefs.getBackground('neon'), { type: 'builtin', id: builtinId });
    assert.deepEqual(prefs.getBackgroundMap(), {
        neon: { type: 'builtin', id: builtinId },
        nord: { type: 'custom', path: '/home/x/Pictures/a.jpg' },
    });

    // unknown builtin id / empty path / wrong type -> none (and deletes the key)
    assert.deepEqual(prefs.setBackground('neon', { type: 'builtin', id: 'no-such' }), { type: 'none' });
    assert.deepEqual(prefs.getBackground('neon'), { type: 'none' });
    assert.deepEqual(prefs.getBackgroundMap(), { nord: { type: 'custom', path: '/home/x/Pictures/a.jpg' } });

    // explicit 'none' -> deletes the theme's key
    assert.deepEqual(prefs.setBackground('nord', { type: 'none' }), { type: 'none' });
    assert.deepEqual(prefs.getBackgroundMap(), {});

    // a saved value broken by hand -> empty map (no throw)
    writeRawConfigKey(config.CONFIG_FILE, 'background', ['array']);
    assert.deepEqual(prefs.getBackgroundMap(), {});
    assert.deepEqual(prefs.getBackground('neon'), { type: 'none' });
});

test('listBuiltinBackgrounds — the data/backgrounds.json manifest', () => {
    assert.ok(Array.isArray(prefs.listBuiltinBackgrounds()));
    assert.ok(prefs.listBuiltinBackgrounds().length > 0);
});

test('listCustomBackgrounds — missing ~/Pictures/launchers-launcher/ folder: empty list, does not throw', () => {
    const homeDir = tmpDir('gl-prefs-home-');
    assert.deepEqual(prefs.listCustomBackgrounds(homeDir), []);
});

test('listCustomBackgrounds — returns only files with an image extension, in name order, with an absolute path', () => {
    const homeDir = tmpDir('gl-prefs-home-');
    const dir = path.join(homeDir, 'Pictures', 'launchers-launcher');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'b.png'), '');
    fs.writeFileSync(path.join(dir, 'a.JPG'), ''); // case-insensitive extension
    fs.writeFileSync(path.join(dir, 'c.webp'), '');
    fs.writeFileSync(path.join(dir, 'readme.txt'), ''); // not an image -> skipped
    assert.deepEqual(prefs.listCustomBackgrounds(homeDir), [
        { name: 'a.JPG', path: path.join(dir, 'a.JPG') },
        { name: 'b.png', path: path.join(dir, 'b.png') },
        { name: 'c.webp', path: path.join(dir, 'c.webp') },
    ]);
});

test('listCustomBackgrounds — a non-ENOENT error (e.g. a file in place of the folder) is rethrown', () => {
    const homeDir = tmpDir('gl-prefs-home-');
    fs.mkdirSync(path.join(homeDir, 'Pictures'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'Pictures', 'launchers-launcher'), ''); // a file, not a folder
    assert.throws(() => prefs.listCustomBackgrounds(homeDir));
});

test('getControllerAutostart — true for a missing key (default behavior)', () => {
    reset();
    assert.equal(prefs.getControllerAutostart(), true);
});

test('setControllerAutostart — sets it to false and back', () => {
    reset();
    assert.equal(prefs.setControllerAutostart(false), false);
    assert.equal(prefs.getControllerAutostart(), false);
    assert.equal(prefs.setControllerAutostart(true), true);
    assert.equal(prefs.getControllerAutostart(), true);
});

test('getAlwaysOnTop — true for a missing key (default behavior)', () => {
    reset();
    assert.equal(prefs.getAlwaysOnTop(), true);
});

test('setAlwaysOnTop — sets it to false and back', () => {
    reset();
    assert.equal(prefs.setAlwaysOnTop(false), false);
    assert.equal(prefs.getAlwaysOnTop(), false);
    assert.equal(prefs.setAlwaysOnTop(true), true);
    assert.equal(prefs.getAlwaysOnTop(), true);
});

test('getStartWithSystem — false for a missing key (opt-in default behavior)', () => {
    reset();
    assert.equal(prefs.getStartWithSystem(), false);
});

test('setStartWithSystem — sets it to true and back', () => {
    reset();
    assert.equal(prefs.setStartWithSystem(true), true);
    assert.equal(prefs.getStartWithSystem(), true);
    assert.equal(prefs.setStartWithSystem(false), false);
    assert.equal(prefs.getStartWithSystem(), false);
});

test('getCoverDownload — true for a missing key (default behavior)', () => {
    reset();
    assert.equal(prefs.getCoverDownload(), true);
});

test('setCoverDownload — sets it to false and back', () => {
    reset();
    assert.equal(prefs.setCoverDownload(false), false);
    assert.equal(prefs.getCoverDownload(), false);
    assert.equal(prefs.setCoverDownload(true), true);
    assert.equal(prefs.getCoverDownload(), true);
});

test('getGamesHiddenSources — an empty array for a missing key', () => {
    reset();
    assert.deepEqual(prefs.getGamesHiddenSources(), []);
});

test('setGamesHiddenSources — takes over only known source ids, deduped', () => {
    reset();
    assert.deepEqual(prefs.setGamesHiddenSources(['steam', 'retro', 'steam']), ['steam', 'retro']);
    assert.deepEqual(prefs.getGamesHiddenSources(), ['steam', 'retro']);
    assert.deepEqual(prefs.setGamesHiddenSources(['steam', 'unknown-source']), ['steam']);
    assert.deepEqual(prefs.getGamesHiddenSources(), ['steam']);
});

test('setGamesHiddenSources — an empty array for non-array input (does not throw)', () => {
    reset();
    assert.deepEqual(prefs.setGamesHiddenSources('steam'), []);
    assert.deepEqual(prefs.setGamesHiddenSources(null), []);
});

// gamesViewMode — grid/list display of the "Games" panel per source (Settings →
// Launchers → "Game view").

test('getGamesViewMode — an empty map for a missing key', () => {
    reset();
    assert.deepEqual(prefs.getGamesViewMode(), {});
});

test('resolveGamesViewMode — for a missing/invalid entry list for "all", grid for every other source', () => {
    assert.equal(prefs.resolveGamesViewMode({}, 'all'), 'list');
    assert.equal(prefs.resolveGamesViewMode({}, 'ryujinx'), 'grid');
    assert.equal(prefs.resolveGamesViewMode({ all: 'oops' }, 'all'), 'list');
    assert.equal(prefs.resolveGamesViewMode({ all: 'grid', ryujinx: 'list' }, 'all'), 'grid');
    assert.equal(prefs.resolveGamesViewMode({ all: 'grid', ryujinx: 'list' }, 'ryujinx'), 'list');
});

test('setGamesViewMode — saves a valid id+mode pair, keeps the existing deviations', () => {
    reset();
    assert.deepEqual(prefs.setGamesViewMode('all', 'grid'), { all: 'grid' });
    assert.deepEqual(prefs.setGamesViewMode('ryujinx', 'list'), { all: 'grid', ryujinx: 'list' });
    assert.deepEqual(prefs.getGamesViewMode(), { all: 'grid', ryujinx: 'list' });
});

test('setGamesViewMode — an unknown id OR invalid mode does not write, returns the current map', () => {
    reset();
    prefs.setGamesViewMode('all', 'grid');
    assert.deepEqual(prefs.setGamesViewMode('unknown-source', 'grid'), { all: 'grid' });
    assert.deepEqual(prefs.setGamesViewMode('ryujinx', 'nagyitva'), { all: 'grid' });
    assert.deepEqual(prefs.getGamesViewMode(), { all: 'grid' });
});

test('numeric selectors — for a missing key the value hardwired before the switch', () => {
    reset();
    assert.equal(prefs.getIdleTimeout(), 3);
    assert.equal(prefs.getVolumeStep(), 5);
    assert.equal(prefs.getVolumeMax(), 100);
    assert.equal(prefs.getTvExitHold(), 5);
});

test('numeric selectors — whitelist: a valid value is saved, unknown / string → default', () => {
    reset();
    assert.equal(prefs.setIdleTimeout(0), 0);
    assert.equal(prefs.getIdleTimeout(), 0);
    assert.equal(prefs.setIdleTimeout(7), 3);
    assert.equal(prefs.setVolumeStep(10), 10);
    assert.equal(prefs.setVolumeStep('10'), 5);
    assert.equal(prefs.setVolumeMax(70), 70);
    assert.equal(prefs.getVolumeMax(), 70);
    assert.equal(prefs.setTvExitHold(8), 8);
    // TV-mode exit has no "off" value (it is the only controller exit path).
    assert.equal(prefs.setTvExitHold(0), 5);
    assert.ok(!prefs.TV_EXIT_HOLDS.includes(0));
});

// --- brightness / night mode + idle sleep / disconnect ---

test('brightness / night mode / idle sleep / disconnect — all 0 (off) by default', () => {
    reset();
    assert.equal(prefs.getScreenDim(), 0);
    assert.equal(prefs.getNightMode(), 0);
    assert.equal(prefs.getAutoSuspend(), 0);
    assert.equal(prefs.getIdleDisconnect(), 0);
});

test('brightness / night mode / idle sleep / disconnect — whitelist', () => {
    reset();
    assert.equal(prefs.setScreenDim(40), 40);
    assert.equal(prefs.getScreenDim(), 40);
    assert.equal(prefs.setScreenDim(100), 0); // full blackout cannot be chosen
    assert.equal(prefs.setNightMode(2), 2);
    assert.equal(prefs.setNightMode(3), 0);
    assert.equal(prefs.setAutoSuspend(120), 120);
    assert.equal(prefs.setAutoSuspend(5), 0);
    assert.equal(prefs.setIdleDisconnect(20), 20);
    assert.equal(prefs.setIdleDisconnect('20'), 0);
});

test('getDoNotDisturb — true for a missing key; set false/true', () => {
    reset();
    assert.equal(prefs.getDoNotDisturb(), true);
    assert.equal(prefs.setDoNotDisturb(false), false);
    assert.equal(prefs.getDoNotDisturb(), false);
    assert.equal(prefs.setDoNotDisturb(true), true);
});

// gamesSortMode — sorting of the "Games" panel per source (R3).

test('get/setGamesSortMode — a valid id+mode saved, an invalid one does not write', () => {
    reset();
    assert.deepEqual(prefs.getGamesSortMode(), {});
    assert.deepEqual(prefs.setGamesSortMode('all', 'recent'), { all: 'recent' });
    assert.deepEqual(prefs.setGamesSortMode('ryujinx', 'playtime'), { all: 'recent', ryujinx: 'playtime' });
    assert.deepEqual(prefs.setGamesSortMode('unknown', 'name'), { all: 'recent', ryujinx: 'playtime' });
    assert.deepEqual(prefs.setGamesSortMode('all', 'veletlen'), { all: 'recent', ryujinx: 'playtime' });
});

// hiddenGames — games hidden one by one.

test('get/setHiddenGames — string keys only, without duplicates; bad input an empty list', () => {
    reset();
    assert.deepEqual(prefs.getHiddenGames(), []);
    assert.deepEqual(prefs.setHiddenGames(['steam-game-1', 'steam-game-1', 5, '', 'retroarch:snes:Zelda']), ['steam-game-1', 'retroarch:snes:Zelda']);
    assert.deepEqual(prefs.getHiddenGames(), ['steam-game-1', 'retroarch:snes:Zelda']);
    assert.deepEqual(prefs.setHiddenGames('not-an-array'), []);
    assert.equal(prefs.cleanHiddenGames(['x'.repeat(601)]).length, 0);
});

// seenTips — the first-use tips.

test('get/setSeenTips — short string identifiers, without duplicates; bad input an empty list', () => {
    reset();
    assert.deepEqual(prefs.getSeenTips(), []);
    assert.deepEqual(prefs.setSeenTips(['home', 'home', 5, '', 'gamesPanel', 'x'.repeat(41)]), ['home', 'gamesPanel']);
    assert.deepEqual(prefs.getSeenTips(), ['home', 'gamesPanel']);
    assert.deepEqual(prefs.setSeenTips([]), []);
    assert.deepEqual(prefs.setSeenTips('not-an-array'), []);
});

// gameLaunchOptions — per-game launch options (lib/launch/launch-options.js).

test('set/getGameLaunchOption — interpretable text saved (normalized), empty deletes, forbidden rejected', () => {
    reset();
    assert.equal(prefs.getGameLaunchOption('pcsx2-game-g1'), '');
    assert.deepEqual(prefs.setGameLaunchOption('pcsx2-game-g1', '  MANGOHUD=1 --x  '), { ok: true, text: 'MANGOHUD=1 --x' });
    assert.equal(prefs.getGameLaunchOption('pcsx2-game-g1'), 'MANGOHUD=1 --x');
    assert.equal(prefs.setGameLaunchOption('pcsx2-game-g1', 'LD_PRELOAD=/x').ok, false);
    assert.equal(prefs.getGameLaunchOption('pcsx2-game-g1'), 'MANGOHUD=1 --x'); // the forbidden one did not overwrite
    assert.equal(prefs.setGameLaunchOption('', '--x').ok, false);
    assert.deepEqual(prefs.setGameLaunchOption('pcsx2-game-g1', ''), { ok: true, text: '' });
    assert.deepEqual(prefs.getGameLaunchOptions(), {});
});

test('playtimeReminder — whitelisted hour counts, default 0 (off)', () => {
    reset();
    assert.equal(prefs.getPlaytimeReminder(), 0);
    assert.equal(prefs.setPlaytimeReminder(3), 3);
    assert.equal(prefs.getPlaytimeReminder(), 3);
    assert.equal(prefs.setPlaytimeReminder(9), 0); // not allowed → default
});
