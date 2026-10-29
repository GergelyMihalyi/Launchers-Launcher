'use strict';

// lib/recent/usage.js — the `usage`/`recentGames` bookkeeping + decorating the launcher payload.
// The `createUsage()` factory gets an injectable `config` + fetch thunks; here we test it with an
// in-memory fake config (no disk, no real library).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsage, DERIVED_RECENT_TTL_MS, MAX_SESSION_MS, mergeRecentGameLists } = require('../../lib/recent/usage.js');

function fakeConfig(initial = {}) {
    const store = JSON.parse(JSON.stringify(initial));
    return {
        store,
        get: (key, fallback) => (key in store ? store[key] : fallback),
        set: (key, val) => { store[key] = val; },
        patch: (key, partial) => {
            store[key] = { ...(store[key] && typeof store[key] === 'object' ? store[key] : {}), ...partial };
        },
    };
}

test('decorateLaunchers — usage/running/recentGames for every launcher', () => {
    const config = fakeConfig({
        usage: { steam: { count: 3, lastLaunchedAt: '2026-01-01T00:00:00.000Z' } },
        recentGames: { heroic: [{ key: 'heroic-game-x', name: 'X' }] },
    });
    const u = createUsage({ config, fetchSteamRecent: () => [{ key: 's1' }], fetchRetroarchRecent: () => [] });
    const out = u.decorateLaunchers(
        [{ id: 'steam' }, { id: 'heroic' }, { id: 'retroarch' }],
        new Set(['heroic']),
    );
    assert.deepEqual(out[0].usage, { count: 3, lastLaunchedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(out[0].running, false);
    assert.deepEqual(out[0].recentGames, [{ key: 's1' }]);      // steam: derived
    assert.equal(out[1].running, true);
    assert.deepEqual(out[1].recentGames, [{ key: 'heroic-game-x', name: 'X' }]); // heroic: stored
    assert.equal(out[2].usage, null);
    assert.deepEqual(out[2].recentGames, []);                   // retroarch: derived (empty)
});

test('decorateLaunchers — pcsx2 is a derived source too (like steam/retroarch)', () => {
    const config = fakeConfig({});
    const u = createUsage({
        config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            pcsx2: () => [{ key: 'pcsx2-game-SCUS-97472' }],
        },
    });
    const out = u.decorateLaunchers([{ id: 'pcsx2' }], new Set());
    assert.deepEqual(out[0].recentGames, [{ key: 'pcsx2-game-SCUS-97472' }]);
});

test('decorateLaunchers — rpcs3 is a derived source too (like steam/retroarch/pcsx2)', () => {
    const config = fakeConfig({});
    const u = createUsage({
        config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            rpcs3: () => [{ key: 'rpcs3-game-BCES00510' }],
        },
    });
    const out = u.decorateLaunchers([{ id: 'rpcs3' }], new Set());
    assert.deepEqual(out[0].recentGames, [{ key: 'rpcs3-game-BCES00510' }]);
});

test('decorateLaunchers — duckstation is a derived source too (like steam/retroarch/pcsx2/rpcs3/ppsspp)', () => {
    const config = fakeConfig({});
    const u = createUsage({
        config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            duckstation: () => [{ key: 'duckstation-game-SLUS-00821' }],
        },
    });
    const out = u.decorateLaunchers([{ id: 'duckstation' }], new Set());
    assert.deepEqual(out[0].recentGames, [{ key: 'duckstation-game-SLUS-00821' }]);
});

test('recordUsage — increment + timestamp, another id untouched', () => {
    const config = fakeConfig({ usage: { heroic: { count: 5, lastLaunchedAt: 'x' } } });
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });
    u.recordUsage('steam');
    u.recordUsage('steam');
    assert.equal(config.store.usage.steam.count, 2);
    assert.equal(config.store.usage.heroic.count, 5);
});

test('recordUsage — preserves the playtime fields (spread ...prev)', () => {
    const config = fakeConfig({ usage: { steam: { count: 1, lastLaunchedAt: 'x', totalMs: 999, lastSessionMs: 111 } } });
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });
    u.recordUsage('steam');
    assert.equal(config.store.usage.steam.count, 2);
    assert.equal(config.store.usage.steam.totalMs, 999);
    assert.equal(config.store.usage.steam.lastSessionMs, 111);
});

test('recordUsageDuration — additive totalMs + lastSessionMs, count/lastLaunchedAt untouched', () => {
    const config = fakeConfig({ usage: { steam: { count: 3, lastLaunchedAt: 'ts' } } });
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });
    assert.equal(u.recordUsageDuration('steam', 60000), 60000);
    assert.equal(u.recordUsageDuration('steam', 90000), 150000); // the new total
    assert.equal(config.store.usage.steam.totalMs, 150000);
    assert.equal(config.store.usage.steam.lastSessionMs, 90000);
    assert.equal(config.store.usage.steam.count, 3);
    assert.equal(config.store.usage.steam.lastLaunchedAt, 'ts');
});

test('recordUsageDuration — sanity guard: 0 / negative / > 24 h / NaN dropped', () => {
    const config = fakeConfig({});
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });
    assert.equal(u.recordUsageDuration('a', 0), null);
    u.recordUsageDuration('a', -5);
    u.recordUsageDuration('a', MAX_SESSION_MS + 1);
    u.recordUsageDuration('a', NaN);
    u.recordUsageDuration('', 1000);
    assert.equal(config.store.usage, undefined);
});

test('recordRecentGame — ANY launcherId WRITES, EXCEPT steam/retroarch/pcsx2 (those are derived at read time)', () => {
    const config = fakeConfig({});
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });

    assert.equal(u.recordRecentGame({ launcherId: 'steam', key: 'steam-game-1' }), false);
    assert.equal(u.recordRecentGame({ launcherId: 'retroarch', key: 'retroarch-game' }), false);
    assert.equal(u.recordRecentGame({ launcherId: 'pcsx2', key: 'pcsx2-game-SCUS-97472' }), false);
    assert.equal(u.recordRecentGame({ launcherId: 'rpcs3', key: 'rpcs3-game-BCES00510' }), false);
    assert.equal(u.recordRecentGame({ launcherId: 'duckstation', key: 'duckstation-game-SLUS-00821' }), false);
    assert.equal(u.recordRecentGame(null), false);
    assert.equal(u.recordRecentGame({ launcherId: 'heroic' }), false); // no key
    assert.equal(config.store.recentGames, undefined);

    const ok = u.recordRecentGame({
        launcherId: 'heroic', key: 'heroic-game-x', name: 'X', kind: 'heroic', params: { appName: 'x', runner: 'gog' },
    });
    assert.equal(ok, true);
    assert.equal(config.store.recentGames.heroic[0].key, 'heroic-game-x');
    assert.equal(config.store.recentGames.heroic[0].cover, null);

    // Ryujinx — a launcherId other than Heroic also writes,
    // under its own `recentGames.<launcherId>` key.
    const ok2 = u.recordRecentGame({
        launcherId: 'ryujinx', key: 'ryujinx-game-y', name: 'Y', kind: 'ryujinx', params: { path: '/roms/y.xci', titleId: null },
    });
    assert.equal(ok2, true);
    assert.equal(config.store.recentGames.ryujinx[0].key, 'ryujinx-game-y');
});

test('globalRecentGames — merge steam+retro+heroic, key-dedup, sorted by lastLaunchedAt', () => {
    const config = fakeConfig({
        recentGames: {
            heroic: [
                { key: 'heroic-game-h1', name: 'H1', lastLaunchedAt: '2026-03-10T12:00:00.000Z' },
                { key: 'heroic-game-h2', name: 'H2', lastLaunchedAt: '2026-01-01T00:00:00.000Z' },
            ],
        },
    });
    const u = createUsage({
        config,
        fetchSteamRecent: () => [
            { key: 'steam-game-1', name: 'S1', lastLaunchedAt: '2026-03-11T00:00:00.000Z' },
            { key: 'heroic-game-h1', name: 'dup', lastLaunchedAt: '2020-01-01T00:00:00.000Z' }, // dedup: heroic came first
        ],
        fetchRetroarchRecent: () => [
            { key: 'retroarch:NES:Metroid', name: 'Metroid', lastLaunchedAt: '2026-03-09T00:00:00.000Z' },
        ],
    });
    const out = u.globalRecentGames(3);
    assert.deepEqual(out.map((g) => g.key), ['steam-game-1', 'heroic-game-h1', 'retroarch:NES:Metroid']);
    assert.equal(out.length, 3);
});

test('globalRecentGames — the pcsx2 derived source is mixed in too', () => {
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => [{ key: 's', name: 'S', lastLaunchedAt: '2026-01-01T00:00:00.000Z' }],
        fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            pcsx2: () => [{ key: 'pcsx2-game-SCUS-97472', name: 'SotC', lastLaunchedAt: '2026-02-01T00:00:00.000Z' }],
        },
    });
    assert.deepEqual(u.globalRecentGames(5).map((g) => g.key), ['pcsx2-game-SCUS-97472', 's']);
});

test('globalRecentGames — the rpcs3 derived source is mixed in too', () => {
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => [{ key: 's', name: 'S', lastLaunchedAt: '2026-01-01T00:00:00.000Z' }],
        fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            rpcs3: () => [{ key: 'rpcs3-game-BCES00510', name: 'GoW3', lastLaunchedAt: '2026-09-14T14:39:19.000Z' }],
        },
    });
    assert.deepEqual(u.globalRecentGames(5).map((g) => g.key), ['rpcs3-game-BCES00510', 's']);
});

test('globalRecentGames — the duckstation derived source is mixed in too', () => {
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => [{ key: 's', name: 'S', lastLaunchedAt: '2026-01-01T00:00:00.000Z' }],
        fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            duckstation: () => [
                { key: 'duckstation-game-SLUS-00821', name: 'SFA3', lastLaunchedAt: '2026-09-14T14:39:19.000Z' },
            ],
        },
    });
    assert.deepEqual(u.globalRecentGames(5).map((g) => g.key), ['duckstation-game-SLUS-00821', 's']);
});

test('globalRecentGames — mixes in EVERY stored (non-derived) recentGames source (heroic AND ryujinx AND cemu, not just heroic)', () => {
    const u = createUsage({
        config: fakeConfig({
            recentGames: {
                heroic: [{ key: 'heroic-game-h1', name: 'H1', lastLaunchedAt: '2026-01-01T00:00:00.000Z' }],
                ryujinx: [{ key: 'ryujinx-game-r1', name: 'R1', lastLaunchedAt: '2026-02-01T00:00:00.000Z' }],
                cemu: [{ key: 'cemu-game-c1', name: 'C1', lastLaunchedAt: '2026-03-01T00:00:00.000Z' }],
            },
        }),
        fetchSteamRecent: () => [],
        fetchRetroarchRecent: () => [],
    });
    assert.deepEqual(
        u.globalRecentGames(5).map((g) => g.key),
        ['cemu-game-c1', 'ryujinx-game-r1', 'heroic-game-h1'],
    );
});

test('mergeRecentGameLists — the extracted core of globalRecentGames, can be called on its own (for the main.js Lutris merge)', () => {
    const lists = [
        [{ key: 'a', name: 'A', lastLaunchedAt: '2026-01-01T00:00:00.000Z' }],
        [
            { key: 'b', name: 'B', lastLaunchedAt: '2026-02-01T00:00:00.000Z' },
            { key: 'a', name: 'dup', lastLaunchedAt: '2020-01-01T00:00:00.000Z' }, // dedup: the first "a" wins
        ],
    ];
    assert.deepEqual(mergeRecentGameLists(lists, 5).map((g) => g.key), ['b', 'a']);
    assert.equal(mergeRecentGameLists(lists, 1).length, 1);
});

test('globalRecentGames — an entry without lastLaunchedAt goes to the end of the list', () => {
    const u = createUsage({
        config: fakeConfig({ recentGames: { heroic: [{ key: 'h', name: 'H' }] } }),
        fetchSteamRecent: () => [{ key: 's', name: 'S', lastLaunchedAt: '2026-01-01T00:00:00.000Z' }],
        fetchRetroarchRecent: () => [],
    });
    assert.deepEqual(u.globalRecentGames(5).map((g) => g.key), ['s', 'h']);
});

test('toggleFavoriteGame — pin (to the front) + unpin, getFavoriteGames filters out the key-less', () => {
    const config = fakeConfig({ favoriteGames: [{ key: 'a', name: 'A' }, { bad: 1 }] });
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });

    assert.deepEqual(u.getFavoriteGames().map((f) => f.key), ['a']); // the one without a key is filtered out

    const r1 = u.toggleFavoriteGame({ key: 'steam-game-620', name: 'Portal 2', cover: '/c.png', kind: 'steam', params: { appid: '620' } });
    assert.equal(r1.favorited, true);
    assert.deepEqual(r1.list.map((f) => f.key), ['steam-game-620', 'a']); // the new one to the front
    assert.equal(config.store.favoriteGames[0].cover, '/c.png');

    const r2 = u.toggleFavoriteGame({ key: 'steam-game-620' });
    assert.equal(r2.favorited, false);
    assert.deepEqual(r2.list.map((f) => f.key), ['a']);
});

test('toggleFavoriteGame — no key → no-op', () => {
    const config = fakeConfig({});
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });
    assert.deepEqual(u.toggleFavoriteGame({ name: 'x' }), { favorited: false, list: [] });
    assert.equal(config.store.favoriteGames, undefined);
});

test('derivedRecentGames — TTL cache: the second time it does not call fetch again', () => {
    let steamCalls = 0;
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => { steamCalls++; return [{ key: `s${steamCalls}` }]; },
        fetchRetroarchRecent: () => [],
    });
    assert.deepEqual(u.derivedRecentGames('steam'), [{ key: 's1' }]);
    assert.deepEqual(u.derivedRecentGames('steam'), [{ key: 's1' }]); // cache
    assert.equal(steamCalls, 1);

    u.invalidateDerivedRecent();
    assert.deepEqual(u.derivedRecentGames('steam'), [{ key: 's2' }]); // fresh fetch
    assert.equal(steamCalls, 2);
});

test('derivedRecentGames — fetch error -> empty list, does not throw', () => {
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => { throw new Error('no Steam'); },
        fetchRetroarchRecent: () => { throw new Error('no RetroArch'); },
        emulatorFetchers: {
            pcsx2: () => { throw new Error('no PCSX2'); },
            rpcs3: () => { throw new Error('no RPCS3'); },
            duckstation: () => { throw new Error('no DuckStation'); },
        },
    });
    assert.deepEqual(u.derivedRecentGames('steam'), []);
    assert.deepEqual(u.derivedRecentGames('retroarch'), []);
    assert.deepEqual(u.derivedRecentGames('pcsx2'), []);
    assert.deepEqual(u.derivedRecentGames('rpcs3'), []);
    assert.deepEqual(u.derivedRecentGames('duckstation'), []);
});

test('DERIVED_RECENT_TTL_MS — a positive number (exported)', () => {
    assert.ok(typeof DERIVED_RECENT_TTL_MS === 'number' && DERIVED_RECENT_TTL_MS > 0);
});

test('invalidateDerivedRecent(launcherId) — clears ONLY the given source, NOT the others', () => {
    let steamCalls = 0;
    let retroCalls = 0;
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => { steamCalls++; return [{ key: `s${steamCalls}` }]; },
        fetchRetroarchRecent: () => { retroCalls++; return [{ key: `r${retroCalls}` }]; },
    });
    u.derivedRecentGames('steam');
    u.derivedRecentGames('retroarch');
    assert.equal(steamCalls, 1);
    assert.equal(retroCalls, 1);

    u.invalidateDerivedRecent('steam');
    u.derivedRecentGames('steam');
    u.derivedRecentGames('retroarch');
    assert.equal(steamCalls, 2, 'the steam source got a fresh fetch');
    assert.equal(retroCalls, 1, 'the retroarch source was NOT queried again — it is still in the TTL window');
});

test('invalidateDerivedRecent — the appId conventions of spawnGame are merged correctly for the derived source', () => {
    let pcsx2Calls = 0;
    let retroCalls = 0;
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => [],
        fetchRetroarchRecent: () => { retroCalls++; return []; },
        emulatorFetchers: {
            pcsx2: () => { pcsx2Calls++; return []; },
        },
    });
    u.derivedRecentGames('pcsx2');
    u.derivedRecentGames('retroarch');
    assert.equal(pcsx2Calls, 1);
    assert.equal(retroCalls, 1);

    // Game-level appId (`<launcherId>-game-<id>`) -> merged into the matching source.
    u.invalidateDerivedRecent('pcsx2-game-42');
    u.derivedRecentGames('pcsx2');
    u.derivedRecentGames('retroarch');
    assert.equal(pcsx2Calls, 2);
    assert.equal(retroCalls, 1, 'retroarch stayed untouched');

    // RetroArch's special 'retroarch-game' literal -> 'retroarch' source.
    u.invalidateDerivedRecent('retroarch-game');
    u.derivedRecentGames('retroarch');
    assert.equal(retroCalls, 2);
});

test('invalidateDerivedRecent — a non-derived/unknown appId (e.g. Heroic/Ryujinx) invalidates NOTHING', () => {
    let steamCalls = 0;
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => { steamCalls++; return []; },
        fetchRetroarchRecent: () => [],
    });
    u.derivedRecentGames('steam');
    assert.equal(steamCalls, 1);

    u.invalidateDerivedRecent('heroic-game-SomeGame');
    u.invalidateDerivedRecent(null);
    u.derivedRecentGames('steam');
    assert.equal(steamCalls, 1, 'none of the non-derived appIds affects the steam cache');
});

test('invalidateDerivedRecent() — without an argument (backward compatible) clears ALL 6 sources', () => {
    let steamCalls = 0;
    let retroCalls = 0;
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => { steamCalls++; return []; },
        fetchRetroarchRecent: () => { retroCalls++; return []; },
    });
    u.derivedRecentGames('steam');
    u.derivedRecentGames('retroarch');
    u.invalidateDerivedRecent();
    u.derivedRecentGames('steam');
    u.derivedRecentGames('retroarch');
    assert.equal(steamCalls, 2);
    assert.equal(retroCalls, 2);
});

// Stale-while-revalidate background refresh.
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
// The background refresh timer may be late during the parallel full test run — instead of a fixed
// wait we wait for the condition (with an upper bound), so the test is not timing-dependent.
async function waitFor(cond, timeoutMs = 2000) {
    const until = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > until) throw new Error('waitFor: timeout');
        await tick(5);
    }
}

test('derivedRecentGames — backgroundSources: does NOT call a sync fetch, returns the old list, then refreshes in the background + signals once', async () => {
    let ppCalls = 0;
    let dsCalls = 0;
    let changed = 0;
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => [{ key: 'steam' }],
        fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            ppsspp: () => { ppCalls++; return [{ key: 'pp' }]; },
            duckstation: async () => { dsCalls++; return [{ key: 'ds' }]; }, // a Promise is fine
        },
        backgroundSources: ['ppsspp', 'duckstation'],
        onDerivedChanged: () => { changed++; },
    });
    assert.deepEqual(u.derivedRecentGames('ppsspp'), []); // no data yet, does not block
    assert.deepEqual(u.derivedRecentGames('duckstation'), []);
    assert.deepEqual(u.derivedRecentGames('steam'), [{ key: 'steam' }]); // non-background source: synchronous
    assert.equal(ppCalls, 0);
    await waitFor(() => changed >= 1);
    assert.equal(ppCalls, 1);
    assert.equal(dsCalls, 1);
    assert.equal(changed, 1, 'the two changes are a single signal');
    assert.deepEqual(u.derivedRecentGames('ppsspp'), [{ key: 'pp' }]);
    assert.deepEqual(u.derivedRecentGames('duckstation'), [{ key: 'ds' }]);
    assert.equal(ppCalls, 1, 'fresh cache → no new fetch');
});

test('derivedRecentGames — backgroundSources: a repeated call during the pending period does not reschedule, an unchanged list does not signal', async () => {
    let calls = 0;
    let changed = 0;
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => [],
        fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            pcsx2: () => { calls++; return [{ key: 'p' }]; },
        },
        backgroundSources: ['pcsx2'],
        onDerivedChanged: () => { changed++; },
    });
    u.derivedRecentGames('pcsx2');
    u.derivedRecentGames('pcsx2');
    u.globalRecentGames();
    await waitFor(() => changed >= 1);
    assert.equal(calls, 1);
    assert.equal(changed, 1);
    u.invalidateDerivedRecent('pcsx2');
    assert.deepEqual(u.derivedRecentGames('pcsx2'), [{ key: 'p' }]); // stale value at once
    await waitFor(() => calls >= 2);
    await tick(20); // let the running refresh round finish (so a possible false signal would show)
    assert.equal(calls, 2);
    assert.equal(changed, 1, 'the same list → no new signal');
});

test('derivedRecentGames — backgroundSources: fetch error → empty list, does not throw', async () => {
    const u = createUsage({
        config: fakeConfig({}),
        fetchSteamRecent: () => [],
        fetchRetroarchRecent: () => [],
        emulatorFetchers: {
            rpcs3: () => { throw new Error('no RPCS3'); },
        },
        backgroundSources: ['rpcs3'],
    });
    assert.deepEqual(u.derivedRecentGames('rpcs3'), []);
    await tick(20);
    assert.deepEqual(u.derivedRecentGames('rpcs3'), []);
});

// A favorite coming from the renderer goes into the config filtered by type + size.
test('toggleFavoriteGame — non-string / too long key: no-op; params keeps only primitive values', () => {
    const u = createUsage({ config: fakeConfig({}), fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });
    assert.equal(u.toggleFavoriteGame({ key: { evil: true } }).favorited, false);
    assert.equal(u.toggleFavoriteGame({ key: 'x'.repeat(301) }).favorited, false);
    const r = u.toggleFavoriteGame({
        key: 'melonds-game-A2SE', name: 42, cover: ['not a string'], kind: 'melonds',
        params: { path: '/r/a.nds', gamecode: 'A2SE', archiveEntry: null, n: 1, nested: { x: 1 }, fn: [1] },
    });
    assert.equal(r.favorited, true);
    assert.deepEqual(r.list[0], {
        key: 'melonds-game-A2SE', name: 'melonds-game-A2SE', cover: null, kind: 'melonds',
        params: { path: '/r/a.nds', gamecode: 'A2SE', archiveEntry: null, n: 1 },
    });
});

test('todayPlaytimeMs — session lengths accumulate onto today; a record with an old date starts from 0', () => {
    const config = fakeConfig({});
    const u = createUsage({ config, fetchSteamRecent: () => [], fetchRetroarchRecent: () => [] });
    assert.equal(u.todayPlaytimeMs(), 0);
    u.recordUsageDuration('steam', 60000);
    u.recordUsageDuration('pcsx2', 30000);
    assert.equal(u.todayPlaytimeMs(), 90000);
    assert.equal(u.recordUsageDuration('steam', 0), null); // an invalid length does not count
    assert.equal(u.todayPlaytimeMs(), 90000);
    config.store.playtimeToday = { date: '2000-01-01', ms: 999999 }; // yesterday's record
    assert.equal(u.todayPlaytimeMs(), 0);
    u.recordUsageDuration('steam', 1000);
    assert.equal(u.todayPlaytimeMs(), 1000);
});
