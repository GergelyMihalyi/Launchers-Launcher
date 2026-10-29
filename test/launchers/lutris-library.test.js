'use strict';

// lib/launchers/lutris-library.js — Lutris library discovery.
// The output of the `lutris --list-games --installed --json` CLI is tested on the pure parsers
// with a fixture string (the format actually queried on the machine) — `findInstalledGames`
// (execFileAsync) is only covered on the error branch (nonexistent command -> empty list, no throw),
// like the non-flatpak branch of `isLauncherInstalled` (test/launcher-list.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');
const {
    lutrisListSpec, parseLutrisTimestamp, parseLutrisGamesJson,
    findInstalledGames, findRecentlyPlayed,
} = require('../../lib/launchers/lutris-library.js');

test('lutrisListSpec — native launcher: with its own cmd, --list-games --installed --json', () => {
    assert.deepEqual(
        lutrisListSpec({ id: 'lutris', cmd: 'lutris', args: [] }),
        { cmd: 'lutris', args: ['--list-games', '--installed', '--json'] },
    );
});

test('lutrisListSpec — no launcher (null) -> "lutris" fallback cmd', () => {
    assert.deepEqual(
        lutrisListSpec(null),
        { cmd: 'lutris', args: ['--list-games', '--installed', '--json'] },
    );
});

test('lutrisListSpec — flatpak launcher: flatpak run <appid> --list-games ...', () => {
    assert.deepEqual(
        lutrisListSpec({ id: 'lutris', cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'] }),
        { cmd: 'flatpak', args: ['run', 'net.lutris.Lutris', '--list-games', '--installed', '--json'] },
    );
});

test('parseLutrisTimestamp — "YYYY-MM-DD HH:MM:SS" -> ms epoch; missing/bad -> 0', () => {
    assert.ok(parseLutrisTimestamp('2026-09-13 10:49:26') > 0);
    assert.equal(parseLutrisTimestamp(null), 0);
    assert.equal(parseLutrisTimestamp(undefined), 0);
    assert.equal(parseLutrisTimestamp(''), 0);
    assert.equal(parseLutrisTimestamp('not-a-date'), 0);
});

test('parseLutrisGamesJson — the real output format measured on the machine, cover only for an existing file', () => {
    const tmp = tmpDir('gl-lutris-');
    const coverPath = path.join(tmp, 'hearthstone.jpg');
    fs.writeFileSync(coverPath, 'x');
    const missingCover = path.join(tmp, 'battlenet.jpg'); // not created

    const json = JSON.stringify([
        {
            id: 1, slug: 'battlenet', name: 'Battle.net', runner: 'wine', platform: 'Windows',
            year: 1996, directory: '/home/user/Games/battlenet', playtime: null,
            playtimeSeconds: null, lastplayed: null, coverPath: missingCover,
        },
        {
            id: 2, slug: 'hearthstone', name: 'Hearthstone', runner: 'wine', platform: 'Windows',
            year: 2014, directory: '/home/user/Games/battlenet',
            playtime: '1 day, 3:42:22.274124', playtimeSeconds: 99742.274124,
            lastplayed: '2026-09-13 10:49:26', coverPath,
        },
    ]);

    const games = parseLutrisGamesJson(json);
    assert.equal(games.length, 2);
    assert.deepEqual(games[0], { id: 1, slug: 'battlenet', name: 'Battle.net', lastLaunchedAt: 0, cover: null });
    assert.equal(games[1].id, 2);
    assert.equal(games[1].name, 'Hearthstone');
    assert.ok(games[1].lastLaunchedAt > 0);
    assert.equal(games[1].cover, coverPath);
});

test('parseLutrisGamesJson — invalid/non-array JSON -> empty list, does not throw', () => {
    assert.deepEqual(parseLutrisGamesJson('not json'), []);
    assert.deepEqual(parseLutrisGamesJson('{"not":"array"}'), []);
    assert.deepEqual(parseLutrisGamesJson('[{"id":1}]'), []); // no name -> filtered out
});

test('findInstalledGames — no added launcher (null) -> empty list, no exec call', async () => {
    assert.deepEqual(await findInstalledGames(null), []);
});

test('findInstalledGames — nonexistent command -> empty list, does not throw', async () => {
    const games = await findInstalledGames({ id: 'lutris', cmd: 'gl-lutris-nemletezik-xyz', args: [] });
    assert.deepEqual(games, []);
});

test('findRecentlyPlayed — sorted by lastLaunchedAt, 0 skipped, cut to max', () => {
    const games = [
        { id: 1, name: 'A', lastLaunchedAt: 0, cover: null },
        { id: 2, name: 'B', lastLaunchedAt: 2000, cover: '/c/b.jpg' },
        { id: 3, name: 'C', lastLaunchedAt: 3000, cover: null },
        { id: 4, name: 'D', lastLaunchedAt: 1000, cover: null },
    ];
    const recent = findRecentlyPlayed(games, 2);
    assert.equal(recent.length, 2);
    assert.deepEqual(recent[0], {
        key: 'lutris-game-3', name: 'C', cover: null, kind: 'lutris', params: { id: 3 },
        lastLaunchedAt: new Date(3000).toISOString(),
    });
    assert.equal(recent[1].key, 'lutris-game-2');
    assert.equal(recent[1].cover, '/c/b.jpg');
});
