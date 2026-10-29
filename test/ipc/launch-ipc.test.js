'use strict';

// lib/ipc/launch-ipc.js — body of the `launch-*` IPC handlers (launcher + game launch). The `deps` are
// fully injectable (no Electron / path / os), so the payload validation + the
// switchToRunning branch + the cmd/args building are unit-testable.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createLaunchHandlers, steamGameArgs, steamExecSpec, steamLaunchSpec, findSteamLauncher, steamAppId,
    heroicGameArgs, heroicMeta, retroarchGameArgs,
    lutrisGameArgs, lutrisLaunchSpec, lutrisGameId, rpcs3GameArgs, rpcs3LaunchSpec, variantExecSpec,
    emulatorRecentMeta,
} = require('../../lib/ipc/launch-ipc.js');
const { EMULATOR_REGISTRY } = require('../../launcher-registry.js');
const { createEmulatorSources } = require('../../lib/launchers/emulator-sources.js');

// The real descriptor (with the real library modules) — the `launch` fields do not touch ctx.
const emulatorSources = createEmulatorSources({ config: { get: (k, d) => d }, workerScans: {}, activeRpcs3ConfigRoot: () => '/x' });
const registryEntry = (id) => EMULATOR_REGISTRY.find((e) => e.id === id);

// --- Pure argument builders ---

test('steamGameArgs — -gamepadui -tenfoot + rungameid URI', () => {
    assert.deepEqual(steamGameArgs('440'), ['-gamepadui', '-tenfoot', 'steam://rungameid/440']);
});

test('steamLaunchSpec — native vs flatpak Steam (launcher-model-v2 D)', () => {
    assert.deepEqual(steamLaunchSpec({ id: 'steam', cmd: 'steam', args: ['-gamepadui', '-tenfoot'] }, '440'),
        { cmd: 'steam', args: ['-gamepadui', '-tenfoot', 'steam://rungameid/440'] });
    assert.deepEqual(
        steamLaunchSpec({ id: 'steam', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-tenfoot'] }, '440'),
        { cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-gamepadui', '-tenfoot', 'steam://rungameid/440'] });
    // no steam launcher → native fallback
    assert.deepEqual(steamLaunchSpec(null, '440'),
        { cmd: 'steam', args: ['-gamepadui', '-tenfoot', 'steam://rungameid/440'] });
});

test('steamExecSpec — native vs flatpak Steam, with an arbitrary trailing argument list', () => {
    assert.deepEqual(steamExecSpec({ id: 'steam', cmd: 'steam', args: [] }, ['steam://open/bigpicture']),
        { cmd: 'steam', args: ['steam://open/bigpicture'] });
    assert.deepEqual(
        steamExecSpec({ id: 'steam', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam'] }, ['steam://open/bigpicture']),
        { cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam', 'steam://open/bigpicture'] });
    // no steam launcher → native fallback
    assert.deepEqual(steamExecSpec(null, ['steam://open/bigpicture']), { cmd: 'steam', args: ['steam://open/bigpicture'] });
});

test('findSteamLauncher — identifies by id/native cmd/flatpak appid, no match -> undefined', () => {
    assert.equal(findSteamLauncher([{ id: 'heroic' }, { id: 'steam', cmd: 'steam', args: [] }]).id, 'steam');
    assert.equal(findSteamLauncher([{ id: 'x', cmd: 'steam', args: [] }]).cmd, 'steam');
    assert.equal(
        findSteamLauncher([{ id: 'y', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam'] }]).id, 'y');
    assert.equal(findSteamLauncher([{ id: 'heroic' }]), undefined);
    assert.equal(findSteamLauncher([]), undefined);
    assert.equal(findSteamLauncher(null), undefined);
});

test('steamAppId — bare appid OR { appid }', () => {
    assert.equal(steamAppId('440'), '440');
    assert.equal(steamAppId({ appid: '620', name: 'Portal 2' }), '620');
    assert.equal(steamAppId(null), null);
});

test('heroicGameArgs — flatpak run + --no-gui + deep-link', () => {
    assert.deepEqual(heroicGameArgs('1234', 'gog'), [
        'run', 'com.heroicgameslauncher.hgl', '--no-gui', 'heroic://launch?appName=1234&runner=gog',
    ]);
});

test('heroicMeta — the 4th argument of spawnGame (launcherId heroic, key, params)', () => {
    assert.deepEqual(heroicMeta('AbC', 'legendary', 'Hades', '/c.png'), {
        launcherId: 'heroic', key: 'heroic-game-AbC', name: 'Hades', cover: '/c.png', kind: 'heroic',
        params: { appName: 'AbC', runner: 'legendary' },
    });
});

test('retroarchGameArgs — flatpak run RetroArch -L <core> <rom>', () => {
    assert.deepEqual(retroarchGameArgs('/x/snes9x.so', '/roms/a.sfc'), [
        'run', 'org.libretro.RetroArch', '-L', '/x/snes9x.so', '/roms/a.sfc',
    ]);
});

test('lutrisGameArgs — lutris:rungameid/<id> URI', () => {
    assert.deepEqual(lutrisGameArgs(7), ['lutris:rungameid/7']);
});

test('lutrisLaunchSpec — native vs flatpak Lutris (variant selector)', () => {
    assert.deepEqual(lutrisLaunchSpec({ id: 'lutris', cmd: 'lutris', args: [] }, 7),
        { cmd: 'lutris', args: ['lutris:rungameid/7'] });
    assert.deepEqual(lutrisLaunchSpec({ id: 'lutris', cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'] }, 7),
        { cmd: 'flatpak', args: ['run', 'net.lutris.Lutris', 'lutris:rungameid/7'] });
    // no lutris launcher → native fallback
    assert.deepEqual(lutrisLaunchSpec(null, 7), { cmd: 'lutris', args: ['lutris:rungameid/7'] });
});

test('lutrisGameId — bare id OR { id }', () => {
    assert.equal(lutrisGameId(7), 7);
    assert.equal(lutrisGameId({ id: 7, name: 'Hearthstone' }), 7);
    assert.equal(lutrisGameId(null), null);
});

// The params come from the registry's `launchParams`.
test('emulatorRecentMeta — source booked at launch time: launcherId/key/params from the registry, missing identifier → null', () => {
    const launch = {};
    assert.deepEqual(emulatorRecentMeta(registryEntry('ryujinx'), launch, '010093801237C000',
        { path: '/roms/x.xci', titleId: '010093801237C000', name: 'Metroid Dread', cover: '/c.jpg' }, []), {
        launcherId: 'ryujinx', key: 'ryujinx-game-010093801237C000', name: 'Metroid Dread', cover: '/c.jpg', kind: 'ryujinx',
        params: { path: '/roms/x.xci', titleId: '010093801237C000' },
    });
    assert.deepEqual(emulatorRecentMeta(registryEntry('cemu'), launch, 'p:abc', { path: '/mnt/Wiiu/X', name: 'X', cover: null }, []), {
        launcherId: 'cemu', key: 'cemu-game-p:abc', name: 'X', cover: null, kind: 'cemu',
        params: { path: '/mnt/Wiiu/X', titleId: null },
    });
    assert.deepEqual(emulatorRecentMeta(registryEntry('dolphin'), launch, 'p:abc', { path: '/roms/wii/x.rvz', name: 'X', cover: null }, []), {
        launcherId: 'dolphin', key: 'dolphin-game-p:abc', name: 'X', cover: null, kind: 'dolphin',
        params: { path: '/roms/wii/x.rvz', gameId: null },
    });
});

test('emulatorRecentMeta — killable (melonDS): + killable + flatpakId from the args; source with derived recent: no meta', () => {
    const melonds = emulatorSources.melonds.launch;
    const p = { path: '/roms/nds/x.zip', archiveEntry: 'inner.nds', name: 'X', cover: null };
    assert.deepEqual(emulatorRecentMeta(registryEntry('melonds'), melonds, 'p:abc', p, melonds.args(p)), {
        launcherId: 'melonds', key: 'melonds-game-p:abc', name: 'X', cover: null, kind: 'melonds',
        params: { path: '/roms/nds/x.zip', archiveEntry: 'inner.nds', gamecode: null },
        killable: true, flatpakId: 'net.kuribo64.melonDS',
    });
    for (const id of ['pcsx2', 'ppsspp', 'duckstation']) {
        assert.equal(emulatorRecentMeta(registryEntry(id), {}, 'x', { path: '/r' }, []), undefined, id);
    }
});

test('rpcs3GameArgs — %RPCS3_GAMEID%:<titleId> (INTENTIONALLY no --no-gui)', () => {
    assert.deepEqual(rpcs3GameArgs('BCES00510'), ['%RPCS3_GAMEID%:BCES00510']);
});

test('rpcs3LaunchSpec — native (AppImage) vs flatpak RPCS3', () => {
    assert.deepEqual(rpcs3LaunchSpec({ id: 'rpcs3', cmd: 'rpcs3', args: [] }, 'BCES00510'),
        { cmd: 'rpcs3', args: ['%RPCS3_GAMEID%:BCES00510'] });
    assert.deepEqual(rpcs3LaunchSpec({ id: 'rpcs3', cmd: 'flatpak', args: ['run', 'net.rpcs3.RPCS3'] }, 'BCES00510'),
        { cmd: 'flatpak', args: ['run', 'net.rpcs3.RPCS3', '%RPCS3_GAMEID%:BCES00510'] });
    // no rpcs3 launcher → native fallback
    assert.deepEqual(rpcs3LaunchSpec(null, 'BCES00510'),
        { cmd: 'rpcs3', args: ['%RPCS3_GAMEID%:BCES00510'] });
});

// --- Factory: handler branches ---

function makeHandlers(over = {}) {
    const calls = { spawn: [], switch: [], sent: [], log: [] };
    const deps = {
        getLaunchers: over.getLaunchers || (() => [
            { id: 'steam', name: 'Steam', cmd: 'steam', args: ['-gamepadui'] },
            { id: 'heroic', name: 'Heroic', cmd: 'flatpak', args: ['run', 'com.heroicgameslauncher.hgl'] },
        ]),
        spawnGame: (appId, cmd, args, meta) => calls.spawn.push({ appId, cmd, args, meta }),
        switchToRunning: (launcher, pid) => calls.switch.push({ id: launcher.id, pid }),
        isLauncherRunning: over.isLauncherRunning || (async () => ({ running: false, pid: null })),
        corePathForSystem: over.corePathForSystem || ((sys) => (sys === 'SNES' ? '/cores/snes9x.so' : null)),
        isSteamRunning: over.isSteamRunning || (() => false),
        log: (m) => calls.log.push(m),
        sendToRenderer: (ch, payload) => calls.sent.push({ ch, payload }),
        // By default every ROM file "exists" (the fixture paths are not on disk).
        fileExists: over.fileExists || (() => true),
        getCustomGameSources: over.getCustomGameSources || (() => []),
        emulatorSources,
    };
    return { h: createLaunchHandlers(deps), calls };
}

test('launchApp — unknown id: only logs, does not spawn', async () => {
    const { h, calls } = makeHandlers();
    await h.launchApp('no-such');
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.switch.length, 0);
    assert.match(calls.log.join(), /Unknown launcher id/);
});

test('launchApp — not running: spawnGame with the cmd/args of the launcher', async () => {
    const { h, calls } = makeHandlers();
    await h.launchApp('steam');
    assert.deepEqual(calls.spawn, [{ appId: 'steam', cmd: 'steam', args: ['-gamepadui'], meta: undefined }]);
    assert.equal(calls.switch.length, 0);
});

test('launchApp — already running: switchToRunning (no spawn)', async () => {
    const { h, calls } = makeHandlers({ isLauncherRunning: async () => ({ running: true, pid: 4242 }) });
    await h.launchApp('steam');
    assert.deepEqual(calls.switch, [{ id: 'steam', pid: 4242 }]);
    assert.equal(calls.spawn.length, 0);
});

test('launchApp — a failure of the running check does not throw, falls back to spawn', async () => {
    const { h, calls } = makeHandlers({ isLauncherRunning: async () => { throw new Error('pgrep failed'); } });
    await h.launchApp('steam');
    assert.equal(calls.spawn.length, 1);
    assert.match(calls.log.join(), /Running-check error/);
});

test('launchRetroarchGame — missing path: app-error (retroMissingPath), no spawn', () => {
    const { h, calls } = makeHandlers();
    h.launchRetroarchGame({ system: 'SNES' });
    assert.equal(calls.spawn.length, 0);
    assert.deepEqual(calls.sent, [{ ch: 'app-error', payload: { appId: 'retroarch-game', error: 'Missing system or ROM path', errorKey: 'err.retroMissingPath' } }]);
});

test('launchRetroarchGame — no installed core: app-error (retroNoCore)', () => {
    const { h, calls } = makeHandlers();
    h.launchRetroarchGame({ system: 'PSP', path: '/roms/x.iso' });
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.sent[0].payload.errorKey, 'err.retroNoCore');
});

test('launchRetroarchGame — OK: spawnGame flatpak + the resolved core path', () => {
    const { h, calls } = makeHandlers();
    h.launchRetroarchGame({ system: 'SNES', path: '/roms/a.sfc' });
    assert.deepEqual(calls.spawn, [{
        appId: 'retroarch-game', cmd: 'flatpak',
        args: ['run', 'org.libretro.RetroArch', '-L', '/cores/snes9x.so', '/roms/a.sfc'], meta: undefined,
    }]);
});

test('launchSteamGame — missing appid: reject; OK: spawn + appid-based appId', () => {
    const { h, calls } = makeHandlers();
    h.launchSteamGame(null);
    assert.equal(calls.sent[0].payload.errorKey, 'err.steamMissingAppid');
    h.launchSteamGame({ appid: '620' });
    assert.deepEqual(calls.spawn, [{
        appId: 'steam-game-620', cmd: 'steam',
        args: ['-gamepadui', '-tenfoot', 'steam://rungameid/620'], meta: undefined,
    }]);
});

test('launchHeroicGame — missing runner: reject; OK: spawn with meta', () => {
    const { h, calls } = makeHandlers();
    h.launchHeroicGame({ appName: 'X' });
    assert.equal(calls.sent[0].payload.errorKey, 'err.heroicMissingArgs');
    h.launchHeroicGame({ appName: 'X', runner: 'gog', name: 'Game X', cover: '/x.png' });
    assert.equal(calls.spawn[0].appId, 'heroic-game-X');
    assert.deepEqual(calls.spawn[0].meta, {
        launcherId: 'heroic', key: 'heroic-game-X', name: 'Game X', cover: '/x.png', kind: 'heroic',
        params: { appName: 'X', runner: 'gog' },
    });
});

test('launchLutrisGame — missing id: reject', () => {
    const { h, calls } = makeHandlers();
    h.launchLutrisGame(null);
    assert.equal(calls.sent[0].payload.errorKey, 'err.lutrisMissingId');
    assert.equal(calls.spawn.length, 0);
});

test('launchLutrisGame — OK, no added Lutris launcher: native fallback', () => {
    const { h, calls } = makeHandlers();
    h.launchLutrisGame({ id: 7 });
    assert.deepEqual(calls.spawn, [{ appId: 'lutris-game-7', cmd: 'lutris', args: ['lutris:rungameid/7'], meta: undefined }]);
});

test('launchLutrisGame — OK, flatpak Lutris launcher added', () => {
    const { h, calls } = makeHandlers({
        getLaunchers: () => [{ id: 'lutris', name: 'Lutris', cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'] }],
    });
    h.launchLutrisGame(7);
    assert.deepEqual(calls.spawn, [{
        appId: 'lutris-game-7', cmd: 'flatpak', args: ['run', 'net.lutris.Lutris', 'lutris:rungameid/7'], meta: undefined,
    }]);
});

// --- The 7 path-based emulators (the descriptor's `launch` field, lib/launchers/emulator-sources.js) ---
//
// The same 3 cases for each: (1) missing `path` -> app-error, no spawn; (2) OK ->
// spawnGame with the full argument list + the `meta` (launch-time recorded "recently played":
// Ryujinx/Cemu/Dolphin/melonDS) or `undefined` (derived: PCSX2/PPSSPP/DuckStation, from their own
// playtime files); (3) starts WITHOUT a real id (titleId/serial/discId/gameId/gamecode) too,
// with a path-hash substitute id — a saved favorite's `params` carries no `id`, and not every
// format yields an id (non-ISO PS2, .pbp homebrew, .rvz, corrupt NDS header,
// broken cue/bin). New emulator = 1 row here.
const EMULATOR_CASES = [
    {
        kind: 'ryujinx',
        missing: { payload: { titleId: '010093801237C000' }, error: 'Missing Ryujinx ROM path', errorKey: 'err.ryujinxMissingPath' },
        ok: {
            payload: { path: '/roms/switch/metroid.xci', titleId: '010093801237C000', name: 'Metroid Dread', cover: '/c.jpg' },
            appId: 'ryujinx-game-010093801237C000',
            args: ['run', 'io.github.ryubing.Ryujinx', '/roms/switch/metroid.xci'],
            meta: {
                launcherId: 'ryujinx', key: 'ryujinx-game-010093801237C000', name: 'Metroid Dread', cover: '/c.jpg',
                kind: 'ryujinx', params: { path: '/roms/switch/metroid.xci', titleId: '010093801237C000' },
            },
        },
        noId: { payload: { path: '/roms/switch/party.xci', name: 'Super Mario Party Jamboree' }, pathArg: 2 },
    },
    {
        kind: 'pcsx2',
        missing: { payload: { serial: 'SCUS-97472' }, error: 'Missing PCSX2 disc image path', errorKey: 'err.pcsx2MissingPath' },
        ok: {
            payload: { path: '/roms/ps2/Shadow of the Colossus.iso', serial: 'SCUS-97472' },
            appId: 'pcsx2-game-SCUS-97472',
            args: ['run', 'net.pcsx2.PCSX2', '/roms/ps2/Shadow of the Colossus.iso'],
            meta: undefined,
        },
        noId: { payload: { path: '/roms/ps2/Game Two.cue' }, pathArg: 2 },
    },
    {
        kind: 'cemu',
        missing: { payload: { titleId: '0005000010143600' }, error: 'Missing Cemu game path', errorKey: 'err.cemuMissingPath' },
        ok: {
            payload: { path: '/mnt/Wiiu/Zelda', titleId: '0005000010143600', name: 'The Wind Waker HD', cover: '/c.png' },
            appId: 'cemu-game-0005000010143600',
            args: ['run', 'info.cemu.Cemu', '-f', '-g', '/mnt/Wiiu/Zelda'],
            meta: {
                launcherId: 'cemu', key: 'cemu-game-0005000010143600', name: 'The Wind Waker HD', cover: '/c.png',
                kind: 'cemu', params: { path: '/mnt/Wiiu/Zelda', titleId: '0005000010143600' },
            },
        },
        noId: { payload: { path: '/mnt/Wiiu/Unknown Game', name: 'Unknown Game' }, pathArg: 4 },
    },
    {
        kind: 'ppsspp',
        missing: { payload: { discId: 'ULES00789' }, error: 'Missing PPSSPP game path', errorKey: 'err.ppssppMissingPath' },
        ok: {
            payload: { path: '/roms/psp/Dragon Ball Z Shin Budokai 2.iso', discId: 'ULES00789' },
            appId: 'ppsspp-game-ULES00789',
            args: ['run', 'org.ppsspp.PPSSPP', '--fullscreen', '/roms/psp/Dragon Ball Z Shin Budokai 2.iso'],
            meta: undefined,
        },
        noId: { payload: { path: '/roms/psp/Homebrew/EBOOT.PBP' }, pathArg: 3 },
    },
    {
        kind: 'dolphin',
        missing: { payload: { gameId: 'SMNP77' }, error: 'Missing Dolphin disc image path', errorKey: 'err.dolphinMissingPath' },
        ok: {
            payload: { path: '/roms/wii/Mario.wbfs', gameId: 'SMNP77', name: 'New Super Mario Bros: Arcadia', cover: '/c.png' },
            appId: 'dolphin-game-SMNP77',
            args: ['run', 'org.DolphinEmu.dolphin-emu', '-b', '-e', '/roms/wii/Mario.wbfs', '-C', 'Dolphin.Display.Fullscreen=True'],
            meta: {
                launcherId: 'dolphin', key: 'dolphin-game-SMNP77', name: 'New Super Mario Bros: Arcadia', cover: '/c.png',
                kind: 'dolphin', params: { path: '/roms/wii/Mario.wbfs', gameId: 'SMNP77' },
            },
        },
        noId: { payload: { path: '/roms/wii/Unknown Game.rvz', name: 'Unknown Game' }, pathArg: 4 },
    },
    {
        kind: 'melonds',
        missing: { payload: { gamecode: 'A2SE' }, error: 'Missing melonDS ROM path', errorKey: 'err.melondsMissingPath' },
        ok: {
            payload: { path: '/roms/nds/DBZ.nds', gamecode: 'A2SE', name: 'Dragon Ball Z', cover: '/c.png' },
            appId: 'melonds-game-A2SE',
            args: ['run', 'net.kuribo64.melonDS', '--fullscreen', '/roms/nds/DBZ.nds'],
            meta: {
                launcherId: 'melonds', key: 'melonds-game-A2SE', name: 'Dragon Ball Z', cover: '/c.png',
                kind: 'melonds', params: { path: '/roms/nds/DBZ.nds', archiveEntry: null, gamecode: 'A2SE' },
                killable: true, flatpakId: 'net.kuribo64.melonDS', // PS-button forced close, only here
            },
        },
        noId: { payload: { path: '/roms/nds/Unknown Game.nds', name: 'Unknown Game' }, pathArg: 3 },
    },
    {
        kind: 'duckstation',
        missing: { payload: { serial: 'SLUS-00821' }, error: 'Missing DuckStation disc image path', errorKey: 'err.duckstationMissingPath' },
        ok: {
            payload: { path: '/roms/ps1/Street Fighter Alpha 3 (USA).cue', serial: 'SLUS-00821' },
            appId: 'duckstation-game-SLUS-00821',
            args: ['run', 'org.duckstation.DuckStation', '-fullscreen', '-batch', '--', '/roms/ps1/Street Fighter Alpha 3 (USA).cue'],
            meta: undefined,
        },
        noId: { payload: { path: '/roms/ps1/Worms Armageddon.cue' }, pathArg: 5 },
    },
];

for (const c of EMULATOR_CASES) {
    test(`${c.kind} — missing path: app-error (${c.missing.errorKey}), no spawn`, () => {
        const { h, calls } = makeHandlers();
        h.launchEmulatorGame({ source: c.kind, ...c.missing.payload });
        assert.equal(calls.spawn.length, 0);
        assert.deepEqual(calls.sent, [{
            ch: 'app-error',
            payload: { appId: `${c.kind}-game`, error: c.missing.error, errorKey: c.missing.errorKey },
        }]);
    });

    test(`${c.kind} — OK: spawnGame flatpak ${c.ok.meta ? '+ meta' : 'without meta'}, the id from the real identifier`, () => {
        const { h, calls } = makeHandlers();
        h.launchEmulatorGame({ source: c.kind, ...c.ok.payload });
        assert.deepEqual(calls.spawn, [{ appId: c.ok.appId, cmd: 'flatpak', args: c.ok.args, meta: c.ok.meta }]);
    });

    test(`${c.kind} — the ROM file does not exist: app-error (err.fileMissing, with file name), no spawn`, () => {
        const { h, calls } = makeHandlers({ fileExists: () => false });
        h.launchEmulatorGame({ source: c.kind, ...c.ok.payload });
        assert.equal(calls.spawn.length, 0);
        assert.equal(calls.sent.length, 1);
        const { payload } = calls.sent[0];
        assert.equal(payload.errorKey, 'err.fileMissing');
        assert.equal(payload.params.file, c.ok.payload.path.split('/').pop());
        assert.match(payload.error, new RegExp(c.ok.payload.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    test(`${c.kind} — without a real identifier: does not throw, spawn goes with a path-hash id`, () => {
        const { h, calls } = makeHandlers();
        h.launchEmulatorGame({ source: c.kind, ...c.noId.payload });
        assert.equal(calls.spawn.length, 1);
        assert.match(calls.spawn[0].appId, new RegExp(`^${c.kind}-game-p:[0-9a-f]{16}$`));
        assert.equal(calls.spawn[0].args[c.noId.pathArg], c.noId.payload.path);
    });
}

// Native variant: the added launcher's `cmd` is not 'flatpak' →
// the same app args, without the `run <appid>` prefix, with the native binary.
for (const c of EMULATOR_CASES) {
    test(`${c.kind} — native launcher: <native cmd> + app args, without flatpak run`, () => {
        const { h, calls } = makeHandlers({ getLaunchers: () => [{ id: c.kind, name: c.kind, cmd: `${c.kind}-bin`, args: [] }] });
        h.launchEmulatorGame({ source: c.kind, ...c.ok.payload });
        assert.equal(calls.spawn.length, 1);
        assert.equal(calls.spawn[0].cmd, `${c.kind}-bin`);
        assert.deepEqual(calls.spawn[0].args, c.ok.args.slice(2));
        // The killable meta (melonDS) must not refer to a flatpak app when native.
        if (calls.spawn[0].meta && 'flatpakId' in calls.spawn[0].meta) assert.equal(calls.spawn[0].meta.flatpakId, null);
    });
}

test('variantExecSpec — a native launcher drops the `run <appid>` prefix; flatpak/no launcher → unchanged', () => {
    const fa = ['run', 'org.libretro.RetroArch', '-L', '/c.so', '/r.sfc'];
    assert.deepEqual(variantExecSpec({ cmd: 'retroarch', args: [] }, fa), { cmd: 'retroarch', args: ['-L', '/c.so', '/r.sfc'] });
    assert.deepEqual(variantExecSpec({ cmd: 'flatpak', args: ['run', 'org.libretro.RetroArch'] }, fa), { cmd: 'flatpak', args: fa });
    assert.deepEqual(variantExecSpec(undefined, fa), { cmd: 'flatpak', args: fa });
});

test('launchRetroarchGame / launchHeroicGame — with a native launcher it calls the native binary', () => {
    const { h, calls } = makeHandlers({
        getLaunchers: () => [
            { id: 'retroarch', name: 'RetroArch', cmd: 'retroarch', args: [] },
            { id: 'heroic', name: 'Heroic', cmd: 'heroic', args: [] },
        ],
    });
    h.launchRetroarchGame({ system: 'SNES', path: '/roms/snes/x.sfc' });
    h.launchHeroicGame({ appName: 'abc', runner: 'legendary' });
    assert.deepEqual(calls.spawn[0], { appId: 'retroarch-game', cmd: 'retroarch', args: ['-L', '/cores/snes9x.so', '/roms/snes/x.sfc'], meta: undefined });
    assert.equal(calls.spawn[1].cmd, 'heroic');
    assert.deepEqual(calls.spawn[1].args, ['--no-gui', 'heroic://launch?appName=abc&runner=legendary']);
});

// ROM opened from a zip archive: `-a <inner file name>` AFTER `--fullscreen`, BEFORE the path.
test('melonds — OK, from a zip archive (archiveEntry): -a <inner file name> among the spawn args', () => {
    const { h, calls } = makeHandlers();
    h.launchEmulatorGame({
        source: 'melonds', path: '/roms/nds/Collection.zip', archiveEntry: 'Dragon Ball Z.nds', gamecode: 'A2SE', name: 'Dragon Ball Z',
    });
    assert.deepEqual(calls.spawn[0].args, [
        'run', 'net.kuribo64.melonDS', '--fullscreen', '-a', 'Dragon Ball Z.nds', '/roms/nds/Collection.zip',
    ]);
});

test('launchRpcs3Game — missing titleId: app-error (rpcs3MissingTitleId), no spawn', () => {
    const { h, calls } = makeHandlers();
    h.launchRpcs3Game({});
    assert.equal(calls.spawn.length, 0);
    assert.deepEqual(calls.sent, [{
        ch: 'app-error',
        payload: { appId: 'rpcs3-game', error: 'Missing RPCS3 title ID', errorKey: 'err.rpcs3MissingTitleId' },
    }]);
});

// For RPCS3 "recently played" is derived from `persistent_settings.dat` (like
// Steam/PCSX2) — no `meta`/`recordRecentGame` call.
test('launchRpcs3Game — OK, no added RPCS3 launcher: native fallback, no meta', () => {
    const { h, calls } = makeHandlers();
    h.launchRpcs3Game({ titleId: 'BCES00510' });
    assert.deepEqual(calls.spawn, [{
        appId: 'rpcs3-game-BCES00510', cmd: 'rpcs3',
        args: ['%RPCS3_GAMEID%:BCES00510'], meta: undefined,
    }]);
});

test('launchRpcs3Game — OK, flatpak RPCS3 launcher added', () => {
    const { h, calls } = makeHandlers({
        getLaunchers: () => [{ id: 'rpcs3', name: 'RPCS3', cmd: 'flatpak', args: ['run', 'net.rpcs3.RPCS3'] }],
    });
    h.launchRpcs3Game({ titleId: 'BCES00510' });
    assert.deepEqual(calls.spawn, [{
        appId: 'rpcs3-game-BCES00510', cmd: 'flatpak',
        args: ['run', 'net.rpcs3.RPCS3', '%RPCS3_GAMEID%:BCES00510'], meta: undefined,
    }]);
});

// The shared `launch-emulator-game` IPC: `source` whitelisted.
test('launchEmulatorGame — unknown / missing source: app-error (err.unknownGameSource), no spawn', () => {
    for (const source of ['nope', undefined, '__proto__', 'steam']) {
        const { h, calls } = makeHandlers();
        h.launchEmulatorGame({ source, path: '/x.iso' });
        assert.equal(calls.spawn.length, 0, `${source}: must not launch`);
        assert.equal(calls.sent[0].payload.errorKey, 'err.unknownGameSource');
    }
    const { h, calls } = makeHandlers();
    h.launchEmulatorGame(null);
    assert.equal(calls.spawn.length, 0);
});

test('launchEmulatorGame — source: rpcs3 → the title-ID based RPCS3 handler', () => {
    const { h, calls } = makeHandlers();
    h.launchEmulatorGame({ source: 'rpcs3', titleId: 'BCES00510' });
    assert.equal(calls.spawn[0].appId, 'rpcs3-game-BCES00510');
});

test('launchRetroarchGame — the ROM file does not exist: err.fileMissing, no spawn', () => {
    const { h, calls } = makeHandlers({ fileExists: () => false });
    h.launchRetroarchGame({ system: 'SNES', path: '/roms/snes/zelda.sfc' });
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.sent[0].payload.errorKey, 'err.fileMissing');
    assert.deepEqual(calls.sent[0].payload.params, { file: 'zelda.sfc' });
});

// --- Custom ROM-folder source ---

test('launchCustomGame — the cmd/args of the launcher + the template, recent meta; a file outside the source / missing source: app-error', () => {
    const { tmpDir, writeFile } = require('../helpers/fs.js');
    const root = tmpDir();
    const rom = writeFile(root, 'Zelda BotW.nsp', 'x');
    const outside = writeFile(tmpDir(), 'Other.nsp', 'x');
    const source = { launcherId: 'custom-citron', dirs: [root], exts: ['.nsp'], argsTemplate: '-f {rom}' };
    const launchers = () => [{ id: 'custom-citron', name: 'Citron', cmd: '/opt/citron.AppImage', args: ['--no-update'] }];
    const { h, calls } = makeHandlers({ getLaunchers: launchers, getCustomGameSources: () => [source] });
    h.launchCustomGame({ launcherId: 'custom-citron', path: rom, name: 'Zelda BotW' });
    assert.equal(calls.spawn.length, 1);
    assert.equal(calls.spawn[0].cmd, '/opt/citron.AppImage');
    assert.deepEqual(calls.spawn[0].args, ['--no-update', '-f', rom]);
    assert.match(calls.spawn[0].appId, /^custom-game-p:[0-9a-f]{16}$/);
    assert.equal(calls.spawn[0].meta.launcherId, 'custom-citron');
    assert.deepEqual(calls.spawn[0].meta.params, { launcherId: 'custom-citron', path: rom });

    h.launchCustomGame({ launcherId: 'custom-citron', path: outside });
    h.launchCustomGame({ launcherId: 'missing', path: rom });
    h.launchCustomGame({ launcherId: 'custom-citron' });
    assert.equal(calls.spawn.length, 1);
    assert.deepEqual(calls.sent.map((x) => x.payload.errorKey), ['err.customOutsideSource', 'err.customNoSource', 'err.customMissingPath']);
});

// --- Per-game launch options (lib/launch/launch-options.js) ---

test('launchEmulatorGame — the saved launch options go before the ROM, the env is the 5th parameter of spawn (native)', () => {
    const { h, spawned } = (() => {
        const spawned = [];
        const h = createLaunchHandlers({
            getLaunchers: () => [{ id: 'pcsx2', cmd: '/usr/bin/pcsx2-qt', args: [] }],
            spawnGame: (...a) => spawned.push(a),
            switchToRunning: () => {}, isLauncherRunning: async () => ({ running: false }),
            corePathForSystem: () => null, isSteamRunning: () => false, log: () => {}, sendToRenderer: () => {},
            fileExists: () => true,
            emulatorSources: { pcsx2: { launch: { args: (p) => ['run', 'net.pcsx2.PCSX2', '-batch', '--', p.path], gameId: () => 'g1', missingReason: 'x' } } },
            getLaunchOption: (key) => (key === 'pcsx2-game-g1' ? 'MANGOHUD=1 -nogui' : ''),
        });
        return { h, spawned };
    })();
    h.launchEmulatorGame({ source: 'pcsx2', path: '/r.iso' });
    assert.equal(spawned.length, 1);
    const [appId, cmd, args, , extra] = spawned[0];
    assert.equal(appId, 'pcsx2-game-g1');
    assert.equal(cmd, '/usr/bin/pcsx2-qt');
    assert.deepEqual(args, ['-batch', '-nogui', '--', '/r.iso']);
    assert.deepEqual(extra, { env: { MANGOHUD: '1' } });
});

test('launchEmulatorGame — an uninterpretable saved option is skipped, the launch goes without options', () => {
    const spawned = [];
    const logs = [];
    const h = createLaunchHandlers({
        getLaunchers: () => [{ id: 'pcsx2', cmd: '/usr/bin/pcsx2-qt', args: [] }],
        spawnGame: (...a) => spawned.push(a),
        switchToRunning: () => {}, isLauncherRunning: async () => ({ running: false }),
        corePathForSystem: () => null, isSteamRunning: () => false, log: (m) => logs.push(m), sendToRenderer: () => {},
        fileExists: () => true,
        emulatorSources: { pcsx2: { launch: { args: (p) => ['run', 'net.pcsx2.PCSX2', p.path], gameId: () => 'g1', missingReason: 'x' } } },
        getLaunchOption: () => 'LD_PRELOAD=/evil.so',
    });
    h.launchEmulatorGame({ source: 'pcsx2', path: '/r.iso' });
    assert.deepEqual(spawned[0][2], ['/r.iso']);
    assert.equal(spawned[0][4], undefined);
    assert.ok(logs.some((l) => l.includes('Launch options skipped')));
});
