'use strict';

// lib/games/game-metadata.js — offline metadata for the game details.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, writeFile } = require('../helpers/fs.js');
const { createGameMetadata, parseLegendaryLibrary } = require('../../lib/games/game-metadata.js');

const LIB = JSON.stringify({
    library: [
        { app_name: 'a1', title: 'Brotato', developer: 'Blobfish Games', extra: { about: { description: 'A potato.\r\nMore lines.' }, storeUrl: 'https://store/x' } },
        { app_name: 'a2', title: 'Barony', developer: '', extra: { about: { description: 'Barony' } } }, // the description is just the title
        { app_name: 'a3', title: 'Long', developer: 'D', extra: { about: { description: 'x'.repeat(2000) } } },
        { title: 'without appname' },
    ],
});

test('parseLegendaryLibrary — developer/description/store; a title-repeating description and an empty entry are dropped; the long one is truncated', () => {
    const map = parseLegendaryLibrary(LIB);
    assert.deepEqual(map.get('a1'), { developer: 'Blobfish Games', description: 'A potato.\nMore lines.', storeUrl: 'https://store/x' });
    assert.equal(map.has('a2'), false);
    assert.ok(map.get('a3').description.length <= 700);
    assert.ok(map.get('a3').description.endsWith('…'));
    assert.equal(parseLegendaryLibrary('not json').size, 0);
});

test('get — heroic: from the legendary file; steam: the hero image of the librarycache; missing / unknown kind → null', async () => {
    const heroic = tmpDir('gl-meta-heroic-');
    writeFile(heroic, 'store_cache/legendary_library.json', LIB);
    const steam = tmpDir('gl-meta-steam-');
    writeFile(steam, 'appcache/librarycache/620/library_hero.jpg', 'x');
    const meta = createGameMetadata({ defaultSteamRoot: () => steam, heroicConfigRoot: () => heroic });
    assert.equal((await meta.get('heroic', { appName: 'a1' })).developer, 'Blobfish Games');
    assert.equal(await meta.get('heroic', { appName: 'missing' }), null);
    assert.deepEqual(await meta.get('steam', { appid: '620' }), { hero: path.join(steam, 'appcache/librarycache/620/library_hero.jpg') });
    assert.equal(await meta.get('steam', { appid: '730' }), null); // no hero image
    assert.equal(await meta.get('steam', { appid: '../x' }), null); // numeric appid only
    assert.equal(await meta.get('pcsx2', { path: '/x' }), null);
    const missing = createGameMetadata({ defaultSteamRoot: () => steam, heroicConfigRoot: () => '/no/such' });
    assert.equal(await missing.get('heroic', { appName: 'a1' }), null);
});

test('get — the legendary file is re-read by mtime', async () => {
    const heroic = tmpDir('gl-meta-reread-');
    const file = path.join(heroic, 'store_cache', 'legendary_library.json');
    writeFile(heroic, 'store_cache/legendary_library.json', LIB);
    const meta = createGameMetadata({ defaultSteamRoot: () => '/x', heroicConfigRoot: () => heroic });
    assert.equal((await meta.get('heroic', { appName: 'a1' })).developer, 'Blobfish Games');
    fs.writeFileSync(file, JSON.stringify({ library: [{ app_name: 'a1', title: 'T', developer: 'New developer' }] }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal((await meta.get('heroic', { appName: 'a1' })).developer, 'New developer');
});
