'use strict';

// lib/launchers/heroic-library.js — Heroic (GOG/Epic/Amazon) library discovery.
// The sample JSONs follow a shortened structure copied from a real Heroic
// config found on the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');
const crypto = require('crypto');
const {
    parseGogInstalled, parseGogLibrary, parseLegendaryInstalled, parseLegendaryLibrary,
    libraryEntriesByName, resolveHeroicCover, findInstalledGames,
} = require('../../lib/launchers/heroic-library.js');

test('parseGogInstalled — skips the DLC entries', () => {
    const data = {
        installed: [
            { appName: '1669367757', is_dlc: false },
            { appName: '1947927225', is_dlc: false },
            { appName: 'some-dlc', is_dlc: true },
        ],
    };
    assert.deepEqual(parseGogInstalled(data), ['1669367757', '1947927225']);
});

test('parseGogInstalled — an empty list for a missing "installed" array', () => {
    assert.deepEqual(parseGogInstalled({}), []);
    assert.deepEqual(parseGogInstalled(null), []);
});

test('parseGogLibrary — appName -> title map, non-installed/DLC entries (e.g. gog-redist) may be included, used only for resolution', () => {
    const titles = parseGogLibrary({
        games: [
            { app_name: 'gog-redist', title: 'Galaxy Common Redistributables', is_installed: true },
            { app_name: '1669367757', title: 'The First Templar - Special Edition', is_installed: false },
        ],
    });
    assert.equal(titles.get('1669367757'), 'The First Templar - Special Edition');
    assert.equal(titles.get('gog-redist'), 'Galaxy Common Redistributables');
});

test('parseLegendaryInstalled — skips the "__timestamp" key, the other keys are the appName', () => {
    const data = { abc123: { platform: 'Windows' }, def456: { platform: 'Windows' }, __timestamp: 123 };
    assert.deepEqual(parseLegendaryInstalled(data).sort(), ['abc123', 'def456']);
});

test('parseLegendaryLibrary — appName -> title map', () => {
    const titles = parseLegendaryLibrary({ library: [{ app_name: 'abc123', title: 'Brotato' }] });
    assert.equal(titles.get('abc123'), 'Brotato');
});

test('findInstalledGames — ignores the "is_installed" field of the cache, only the install-info decides', () => {
    const root = tmpDir('gl-heroic-');
    fs.mkdirSync(path.join(root, 'gog_store'), { recursive: true });
    fs.mkdirSync(path.join(root, 'store_cache'), { recursive: true });

    // GOG: per installed.json only "1669367757" is installed, BUT in the library
    // cache "gog-redist" is also is_installed:true (stale data) — it must not
    // end up in the result.
    fs.writeFileSync(path.join(root, 'gog_store', 'installed.json'), JSON.stringify({
        installed: [{ appName: '1669367757', is_dlc: false }],
    }));
    fs.writeFileSync(path.join(root, 'store_cache', 'gog_library.json'), JSON.stringify({
        games: [
            { app_name: 'gog-redist', title: 'Galaxy Common Redistributables', is_installed: true },
            { app_name: '1669367757', title: 'The First Templar - Special Edition', is_installed: false },
        ],
    }));

    // Epic: per install_info only "e8bbb84be" is installed, the library cache has
    // several "is_installed:true" candidate entries (stale) — those must not get in either.
    fs.writeFileSync(path.join(root, 'store_cache', 'legendary_install_info.json'), JSON.stringify({
        e8bbb84be: { platform: 'Windows' },
        __timestamp: 123,
    }));
    fs.writeFileSync(path.join(root, 'store_cache', 'legendary_library.json'), JSON.stringify({
        library: [
            { app_name: 'e8bbb84be', title: 'Brotato', is_installed: true },
            { app_name: 'c98c4cd6d', title: 'Barony', is_installed: true },
        ],
    }));

    // Amazon (nile): the store was never used on this "machine" -> no file either.

    const games = findInstalledGames(root);
    assert.deepEqual(games, [
        { appName: 'e8bbb84be', name: 'Brotato', runner: 'legendary', cover: null },
        { appName: '1669367757', name: 'The First Templar - Special Edition', runner: 'gog', cover: null },
    ]);
});

test('resolveHeroicCover — sha256(art_square) precedence, art_cover fallback, finally null', () => {
    const dir = tmpDir('gl-heroic-cover-');
    const sq = 'https://images.gog.com/square.jpg';
    const cv = 'https://images.gog.com/cover.jpg';
    const digest = (u) => crypto.createHash('sha256').update(u).digest('hex');

    // art_square cached -> returns it
    fs.writeFileSync(path.join(dir, digest(sq)), 'x');
    assert.equal(resolveHeroicCover(dir, { art_square: sq, art_cover: cv }), path.join(dir, digest(sq)));

    // only art_cover cached -> fallback
    fs.writeFileSync(path.join(dir, digest(cv)), 'x');
    assert.equal(resolveHeroicCover(dir, { art_cover: cv }), path.join(dir, digest(cv)));

    // no matching file / no entry -> null
    assert.equal(resolveHeroicCover(dir, { art_square: 'https://x/none.jpg' }), null);
    assert.equal(resolveHeroicCover(dir, null), null);
});

test('libraryEntriesByName — app_name -> raw entry map (gog "games" / legendary "library")', () => {
    const gog = libraryEntriesByName({ games: [{ app_name: 'a', title: 'A', art_square: 'u' }] }, 'games');
    assert.equal(gog.get('a').art_square, 'u');
    const epic = libraryEntriesByName({ library: [{ app_name: 'b', art_cover: 'v' }] }, 'library');
    assert.equal(epic.get('b').art_cover, 'v');
    assert.equal(libraryEntriesByName(null, 'games').size, 0);
});

test('findInstalledGames — neither store is used (empty Heroic config) -> empty array', () => {
    const root = tmpDir('gl-heroic-empty-');
    assert.deepEqual(findInstalledGames(root), []);
});
