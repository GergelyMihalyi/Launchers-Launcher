'use strict';

// lib/launchers/rpcs3-library.js — RPCS3 (PS3 emulator) installed-game discovery.
// The PARAM.SFO fixtures are made with `buildFakeParamSfo` from `test/helpers/fixtures.js`
// (following the layout of a "God of War III" PARAM.SFO found on the machine); the parser
// itself is covered in `test/launchers/shared/param-sfo.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');
const { buildFakeParamSfo } = require('../helpers/fixtures.js');
const {
    parseGamesYaml, parsePersistentSettings, resolveParamSfoPath,
    resolveIconPath, findInstalledGames, findInstalledGamesCached, findRecentlyPlayed,
} = require('../../lib/launchers/rpcs3-library.js');

test('parseGamesYaml — <TITLE_ID>: <path> pairs, other lines skipped', () => {
    const yml = 'BCES00510: /mnt/games/ps3/Some.Game.PS3/\nNPUB90123: /home/user/ps3/game2/\n\n';
    const map = parseGamesYaml(yml);
    assert.equal(map.get('BCES00510'), '/mnt/games/ps3/Some.Game.PS3/');
    assert.equal(map.get('NPUB90123'), '/home/user/ps3/game2/');
    assert.equal(map.size, 2);
});

test('parseGamesYaml — empty/bad content -> empty Map, does not throw', () => {
    assert.equal(parseGamesYaml('').size, 0);
    assert.equal(parseGamesYaml('not a yaml line').size, 0);
    assert.equal(parseGamesYaml(null).size, 0);
});

test('resolveParamSfoPath / resolveIconPath — PS3_GAME/ subfolder with PRECEDENCE, then the root', () => {
    const dir = tmpDir('gl-rpcs3-layout-');
    fs.mkdirSync(path.join(dir, 'PS3_GAME'));
    fs.writeFileSync(path.join(dir, 'PS3_GAME', 'PARAM.SFO'), buildFakeParamSfo({ TITLE: 'Disc Layout' }));
    fs.writeFileSync(path.join(dir, 'PS3_GAME', 'ICON0.PNG'), 'png-bytes');
    assert.equal(resolveParamSfoPath(dir), path.join(dir, 'PS3_GAME', 'PARAM.SFO'));
    assert.equal(resolveIconPath(dir), path.join(dir, 'PS3_GAME', 'ICON0.PNG'));

    // Assumed layout of an HDD/PKG install: directly in the root.
    const dir2 = tmpDir('gl-rpcs3-layout-');
    fs.writeFileSync(path.join(dir2, 'PARAM.SFO'), buildFakeParamSfo({ TITLE: 'HDD Layout' }));
    assert.equal(resolveParamSfoPath(dir2), path.join(dir2, 'PARAM.SFO'));
    assert.equal(resolveIconPath(dir2), null); // no ICON0.PNG -> null, no throw

    assert.equal(resolveParamSfoPath(tmpDir('gl-rpcs3-layout-')), null);
});

test('parsePersistentSettings — [LastPlayed]/[Playtime] section, the format seen on the machine', () => {
    const text = '[LastPlayed]\nBCES00510=2026-09-14T14:39:19\n\n[Playtime]\nBCES00510=142698\n';
    const { lastPlayed, playtimeMs } = parsePersistentSettings(text);
    assert.equal(lastPlayed.get('BCES00510'), Date.parse('2026-09-14T14:39:19'));
    assert.equal(playtimeMs.get('BCES00510'), 142698);
});

test('parsePersistentSettings — empty/bad content -> empty Maps, does not throw', () => {
    const { lastPlayed, playtimeMs } = parsePersistentSettings('');
    assert.equal(lastPlayed.size, 0);
    assert.equal(playtimeMs.size, 0);
    assert.deepEqual(parsePersistentSettings(null).lastPlayed.size, 0);
});

function writeGamesFixture(configRoot, gameDir, titleId, sfoFields, { iconInGameDir = true } = {}) {
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'games.yml'), `${titleId}: ${gameDir}\n`);
    const ps3GameDir = path.join(gameDir, 'PS3_GAME');
    fs.mkdirSync(ps3GameDir, { recursive: true });
    fs.writeFileSync(path.join(ps3GameDir, 'PARAM.SFO'), buildFakeParamSfo(sfoFields));
    if (iconInGameDir) fs.writeFileSync(path.join(ps3GameDir, 'ICON0.PNG'), 'png-bytes');
}

test('findInstalledGames — games.yml + PARAM.SFO title + ICON0.PNG cover + persistent_settings playtime', () => {
    const configRoot = tmpDir('gl-rpcs3-cfg-');
    const gameDir = path.join(tmpDir('gl-rpcs3-lib-'), 'God.Of.War.3');
    writeGamesFixture(configRoot, gameDir, 'BCES00510', { TITLE: 'God of War® III', TITLE_ID: 'BCES00510' });
    fs.mkdirSync(path.join(configRoot, 'GuiConfigs'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'GuiConfigs', 'persistent_settings.dat'),
        '[LastPlayed]\nBCES00510=2026-09-14T14:39:19\n\n[Playtime]\nBCES00510=142698\n');

    const games = findInstalledGames(configRoot);
    assert.equal(games.length, 1);
    const g = games[0];
    assert.equal(g.id, 'BCES00510');
    assert.equal(g.titleId, 'BCES00510');
    assert.equal(g.name, 'God of War® III');
    assert.equal(g.path, gameDir);
    assert.equal(g.cover, path.join(gameDir, 'PS3_GAME', 'ICON0.PNG'));
    assert.equal(g.lastPlayedAt, Date.parse('2026-09-14T14:39:19'));
    assert.equal(g.playtimeMs, 142698);
});

test('findInstalledGames — missing PARAM.SFO/cover -> falls back to TITLE_ID, cover null, does not throw', () => {
    const configRoot = tmpDir('gl-rpcs3-cfg-');
    const gameDir = path.join(tmpDir('gl-rpcs3-lib-'), 'NoMeta');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'games.yml'), `NPUB90000: ${gameDir}\n`);

    const games = findInstalledGames(configRoot);
    assert.equal(games.length, 1);
    assert.equal(games[0].name, 'NPUB90000');
    assert.equal(games[0].cover, null);
    assert.equal(games[0].lastPlayedAt, null);
    assert.equal(games[0].playtimeMs, 0);
});

test('findInstalledGames — missing games.yml -> empty list, does not throw', () => {
    assert.deepEqual(findInstalledGames(tmpDir('gl-rpcs3-cfg-')), []);
});

test('findInstalledGamesCached — exported, a function', () => {
    assert.equal(typeof findInstalledGamesCached, 'function');
});

test('findRecentlyPlayed — descending by lastPlayedAt, cut to max, recentGames shape', () => {
    const configRoot = tmpDir('gl-rpcs3-cfg-');
    const libRoot = tmpDir('gl-rpcs3-lib-');
    const oldDir = path.join(libRoot, 'Old');
    const newDir = path.join(libRoot, 'New');
    const neverDir = path.join(libRoot, 'Never');
    writeGamesFixture(configRoot, oldDir, 'AAAA00001', { TITLE: 'Old Game' });
    fs.appendFileSync(path.join(configRoot, 'games.yml'), `BBBB00002: ${newDir}\n`);
    fs.mkdirSync(path.join(newDir, 'PS3_GAME'), { recursive: true });
    fs.writeFileSync(path.join(newDir, 'PS3_GAME', 'PARAM.SFO'), buildFakeParamSfo({ TITLE: 'New Game' }));
    fs.appendFileSync(path.join(configRoot, 'games.yml'), `CCCC00003: ${neverDir}\n`);
    fs.mkdirSync(neverDir, { recursive: true });

    fs.mkdirSync(path.join(configRoot, 'GuiConfigs'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'GuiConfigs', 'persistent_settings.dat'), [
        '[LastPlayed]',
        'AAAA00001=2026-01-01T10:00:00',
        'BBBB00002=2026-09-14T14:39:19',
        '',
    ].join('\n'));

    const recent = findRecentlyPlayed(configRoot, 5);
    assert.deepEqual(recent.map((r) => r.key), ['rpcs3-game-BBBB00002', 'rpcs3-game-AAAA00001']);
    assert.equal(recent[0].kind, 'rpcs3');
    assert.deepEqual(recent[0].params, { titleId: 'BBBB00002' });
    assert.equal(recent[0].name, 'New Game');
    // Must be an ISO 8601 STRING, NOT the raw ms-epoch number — mergeRecentGameLists() in
    // lib/recent/usage.js calls Date.parse() on it (this was the production bug, see the
    // analogous duckstation-library.js fix).
    assert.equal(Number.isNaN(Date.parse(recent[0].lastLaunchedAt)), false);

    assert.equal(findRecentlyPlayed(configRoot, 1).length, 1);
});
