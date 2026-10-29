'use strict';

// lib/recent/recent-games-merge.js — merging the "recently played" list of Lutris (an async CLI
// source) with the synchronous globalRecentGames() of usage.js, the `recentGames.lutris`
// mirroring and the active RPCS3 config root. Every dependency is fake (in-memory config, fake Lutris
// library); the merge uses the REAL `mergeRecentGameLists` (the sorting/dedup contract).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecentGamesMerge } = require('../../lib/recent/recent-games-merge.js');
const { mergeRecentGameLists } = require('../../lib/recent/usage.js');

const iso = (ms) => new Date(ms).toISOString();

function fakeConfig(initial = {}) {
    const store = structuredClone(initial);
    return {
        store,
        get: (key, fallback) => (key in store ? structuredClone(store[key]) : fallback),
        patch: (key, partial) => { store[key] = { ...(store[key] || {}), ...partial }; },
    };
}

function makeMerge(over = {}) {
    const calls = { sent: [], log: [], lutrisQueries: [] };
    const launchers = over.launchers || [{ id: 'lutris', name: 'Lutris', cmd: 'lutris', args: [] }];
    const lutrisGames = over.lutrisGames || [];
    const config = over.config || fakeConfig();
    const merge = createRecentGamesMerge({
        getLaunchers: () => launchers,
        lutrisLibrary: {
            findInstalledGamesCached: over.findInstalledGamesCached || (async (entry) => {
                calls.lutrisQueries.push(entry);
                return lutrisGames;
            }),
            // The shape of the real lutris-library `findRecentlyPlayed`: lastPlayed desc, cut to max.
            findRecentlyPlayed: (games, max) => games
                .filter((g) => g.lastPlayed > 0)
                .sort((a, b) => b.lastPlayed - a.lastPlayed)
                .slice(0, max)
                .map((g) => ({ key: `lutris-game-${g.id}`, name: g.name, kind: 'lutris', lastLaunchedAt: iso(g.lastPlayed) })),
        },
        rpcs3Library: {
            rpcs3ConfigRoot: () => '/home/x/.config/rpcs3',
            rpcs3FlatpakConfigRoot: () => '/home/x/.var/app/net.rpcs3.RPCS3/config/rpcs3',
        },
        usage: { globalRecentGames: over.globalRecentGames || (() => []) },
        mergeRecentGameLists,
        config,
        log: (m) => calls.log.push(m),
        sendToRenderer: (ch, payload) => calls.sent.push({ ch, payload }),
        launchersPayload: () => ['payload'],
    });
    return { merge, calls, config };
}

test('lutrisLauncherEntry — the added lutris launcher, otherwise null', () => {
    assert.equal(makeMerge().merge.lutrisLauncherEntry().id, 'lutris');
    assert.equal(makeMerge({ launchers: [{ id: 'steam', cmd: 'steam', args: [] }] }).merge.lutrisLauncherEntry(), null);
});

test('activeRpcs3ConfigRoot — flatpak launcher -> flatpak root; native OR not added -> ~/.config/rpcs3', () => {
    const flatpak = makeMerge({ launchers: [{ id: 'rpcs3', cmd: 'flatpak', args: ['run', 'net.rpcs3.RPCS3'] }] });
    assert.equal(flatpak.merge.activeRpcs3ConfigRoot(), '/home/x/.var/app/net.rpcs3.RPCS3/config/rpcs3');
    const native = makeMerge({ launchers: [{ id: 'rpcs3', cmd: 'rpcs3', args: [] }] });
    assert.equal(native.merge.activeRpcs3ConfigRoot(), '/home/x/.config/rpcs3');
    assert.equal(makeMerge({ launchers: [] }).merge.activeRpcs3ConfigRoot(), '/home/x/.config/rpcs3');
});

test('lutrisRecentGames — queries with the added launcher, gives the top N by lastPlayed', async () => {
    const { merge, calls } = makeMerge({
        lutrisGames: [
            { id: 1, name: 'Old', lastPlayed: 1000 },
            { id: 2, name: 'New', lastPlayed: 3000 },
            { id: 3, name: 'Sosem', lastPlayed: 0 },
        ],
    });
    const list = await merge.lutrisRecentGames(3);
    assert.deepEqual(list.map((g) => g.name), ['New', 'Old']);
    assert.equal(calls.lutrisQueries[0].id, 'lutris');
});

test('combinedRecentGames — the global list + Lutris merged chronologically, cut to max', async () => {
    const { merge } = makeMerge({
        globalRecentGames: (max) => [
            { key: 'steam-game-10', name: 'Steam A', lastLaunchedAt: iso(4000) },
            { key: 'heroic-game-x', name: 'Heroic B', lastLaunchedAt: iso(2000) },
        ].slice(0, max),
        lutrisGames: [
            { id: 7, name: 'Lutris C', lastPlayed: 3000 },
            { id: 8, name: 'Lutris D', lastPlayed: 1000 },
        ],
    });
    assert.deepEqual((await merge.combinedRecentGames(3)).map((g) => g.name), ['Steam A', 'Lutris C', 'Heroic B']);
    assert.deepEqual((await merge.combinedRecentGames(10)).map((g) => g.name), ['Steam A', 'Lutris C', 'Heroic B', 'Lutris D']);
});

test('refreshLutrisRecentMirror — on a change writes into recentGames.lutris (the other keys stay) + running-changed', async () => {
    const config = fakeConfig({ recentGames: { heroic: [{ key: 'h' }] } });
    const { merge, calls } = makeMerge({ config, lutrisGames: [{ id: 7, name: 'Lutris C', lastPlayed: 3000 }] });
    await merge.refreshLutrisRecentMirror();
    assert.deepEqual(config.store.recentGames.lutris.map((g) => g.key), ['lutris-game-7']);
    assert.deepEqual(config.store.recentGames.heroic, [{ key: 'h' }]);
    assert.deepEqual(calls.sent, [{ ch: 'running-changed', payload: ['payload'] }]);
});

test('refreshLutrisRecentMirror — for an unchanged list it does NOT write and does NOT push ("don\'t make noise")', async () => {
    const config = fakeConfig();
    const { merge, calls } = makeMerge({ config, lutrisGames: [{ id: 7, name: 'Lutris C', lastPlayed: 3000 }] });
    await merge.refreshLutrisRecentMirror();
    await merge.refreshLutrisRecentMirror();
    assert.equal(calls.sent.length, 1, 'the second run with an identical result must not push');

    // Empty Lutris list + a key never written: the empty array equals the missing one -> no write.
    const empty = makeMerge({ config: fakeConfig() });
    await empty.merge.refreshLutrisRecentMirror();
    assert.equal(empty.calls.sent.length, 0);
    assert.equal(empty.config.store.recentGames, undefined);
});

test('refreshLutrisRecentMirror — one run at a time; error -> logs, does not throw, the lock is released', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let queries = 0;
    const { merge, calls } = makeMerge({
        findInstalledGamesCached: async () => {
            queries += 1;
            if (queries === 1) { await gate; return [{ id: 1, name: 'A', lastPlayed: 1000 }]; }
            throw new Error('lutris CLI failed');
        },
    });
    const first = merge.refreshLutrisRecentMirror();
    await merge.refreshLutrisRecentMirror(); // while running: returns at once, does not ask
    assert.equal(queries, 1);
    release();
    await first;

    await merge.refreshLutrisRecentMirror(); // the lock was released; this run gets an error
    assert.equal(queries, 2);
    assert.match(calls.log.join('\n'), /Lutris recent mirroring error: lutris CLI failed/);
    assert.equal(calls.sent.length, 1, 'only the first (successful) run pushed');
});
