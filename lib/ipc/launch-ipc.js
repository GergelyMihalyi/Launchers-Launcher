// @ts-check
'use strict';

// Bodies of the `launch-*` game/launcher launch IPC handlers; `registerLaunchIpc({ ipcMain, … })` registers the channels next
// to them. The spawn / window-hide state machine stays in lib/launch/launch-controller.js — main injects it as `spawnGame` /
// `switchToRunning`. The module does NOT know Electron / paths / `os`: the caller pre-binds every machine-specific thing
// (launcher list, retroarch core path, steam homedir) in `deps`.

/** @typedef {import('../types.js').Launcher} Launcher */

const fs = require('fs');
const { fileMissingInfo } = require('../launch/launch-errors.js');
const { parseLaunchOptions, applyLaunchOptions } = require('../launch/launch-options.js');
const { catalogAppId, flatpakRunAppId } = require('../flatpak.js');
const { isSteamLauncher } = require('../launchers/steam-library.js');
const { HEROIC_FLATPAK_ID } = require('../launchers/heroic-library.js');
const { RETROARCH_FLATPAK_ID } = require('../launchers/retroarch-library.js');
const { RPCS3_FLATPAK_ID } = require('../launchers/rpcs3-library.js');
const { EMULATOR_REGISTRY, launchParamsFor } = require('../../launcher-registry.js');
const customRoms = require('../launchers/custom-roms-library.js');
const { requireDeps } = require('./require-deps.js');
const { str, PATH_MAX } = require('../validate.js');

// --- Pure arg builders (for tests) ---

// The "Steam Big Picture" launcher card's flags (`-gamepadui -tenfoot`) + the chosen game's URI in ONE call.
// The launcher hides as usual and comes back when the `child` closes, exactly as with the Big Picture card.
function steamGameArgs(appid) {
    return ['-gamepadui', '-tenfoot', `steam://rungameid/${appid}`];
}

// The actual spawn/exec `cmd`/`args` by the added Steam launcher, with any trailing argument list: native →
// `steam <extraArgs>`; flatpak → `flatpak run com.valvesoftware.Steam <extraArgs>`; no steam launcher → native fallback.
// Both Steam call paths use it: `steamLaunchSpec()` and `raiseSteamBigPicture()`.
function steamExecSpec(steamLauncher, extraArgs) {
    const flatpakId = steamLauncher && steamLauncher.cmd === 'flatpak' ? flatpakRunAppId(steamLauncher.args) : null;
    if (flatpakId) return { cmd: 'flatpak', args: ['run', flatpakId, ...extraArgs] };
    return { cmd: 'steam', args: extraArgs };
}

// A flatpak-shaped (`['run', <appid>, …app args]`) game launch according to the added launcher's VARIANT:
// native launcher (`cmd` ≠ 'flatpak') → `<cmd> …app args`; flatpak / not added → `flatpak run <appid> …`
// unchanged. So the emulator/Heroic/RetroArch arg builders can stay flatpak-shaped (and their tests too).
/** @param {Launcher|undefined|null} launcher @param {string[]} flatpakArgs */
function variantExecSpec(launcher, flatpakArgs) {
    if (launcher && launcher.cmd && launcher.cmd !== 'flatpak' && flatpakArgs[0] === 'run') {
        return { cmd: launcher.cmd, args: flatpakArgs.slice(2) };
    }
    return { cmd: 'flatpak', args: flatpakArgs };
}

function steamLaunchSpec(steamLauncher, appid) {
    return steamExecSpec(steamLauncher, steamGameArgs(appid));
}

// Finds Steam among the added launchers (by the shared `isSteamLauncher`: id `'steam'` OR native
// `cmd: 'steam'` OR flatpak `com.valvesoftware.Steam`) — called by `launchSteamGame` AND `raiseSteamBigPicture()`.
function findSteamLauncher(launchers) {
    return (launchers || []).find(isSteamLauncher);
}

// The payload is either a bare appid OR { appid, ... } (the games panel also sends `name`/`cover` for the
// quick-launch bar — but Steam recents come from the appmanifest `LastPlayed` at read time, so only the
// appid is needed here).
function steamAppId(payload) {
    return (payload && typeof payload === 'object') ? payload.appid : payload;
}

// Heroic's `heroic://launch?...` deep link (reverse-engineered from Heroic's app.asar) + `--no-gui`
// (headless — the spawned process lives as long as the game, so unlike Steam the `close` REALLY means
// the game closed).
function heroicGameArgs(appName, runner) {
    return [
        'run', HEROIC_FLATPAK_ID, '--no-gui',
        `heroic://launch?appName=${appName}&runner=${runner}`,
    ];
}

// The optional 4th `meta` argument of `spawnGame` — source of the launch-time "recently played"
// (`recordRecentGame`) for the quick-launch bar. See lib/recent/usage.js.
function heroicMeta(appName, runner, name, cover) {
    return {
        launcherId: 'heroic', key: `heroic-game-${appName}`, name, cover, kind: 'heroic',
        params: { appName, runner },
    };
}

// The `retroarch` process is the running emulator itself -> the shared `spawnGame()` flow fits it
// unchanged (like launch-app).
function retroarchGameArgs(core, romPath) {
    return ['run', RETROARCH_FLATPAK_ID, '-L', core, romPath];
}

// Lutris's `lutris:rungameid/<numeric-id>` URI (per `lutris --help` — the Steam `steam://rungameid/<appid>`
// pattern). ⚠️ NOT tested live — the Lutris client's lifecycle (does it stay running until `close` like Heroic
// `--no-gui`, or forward to an already running instance and exit immediately like Steam) is to be verified
// on the machine.
function lutrisGameArgs(id) {
    return [`lutris:rungameid/${id}`];
}

// The actual spawn `cmd`/`args` by the added Lutris launcher (native OR flatpak — variant picker): native →
// `lutris lutris:rungameid/<id>`; flatpak → `flatpak run net.lutris.Lutris lutris:rungameid/<id>`. The
// `steamLaunchSpec` pattern, with `catalogAppId` to extract the flatpak appid.
function lutrisLaunchSpec(lutrisLauncher, id) {
    if (lutrisLauncher && lutrisLauncher.cmd === 'flatpak') {
        return { cmd: 'flatpak', args: ['run', catalogAppId(lutrisLauncher), ...lutrisGameArgs(id)] };
    }
    return { cmd: (lutrisLauncher && lutrisLauncher.cmd) || 'lutris', args: lutrisGameArgs(id) };
}

// The payload is a bare id OR { id, ... } (the `steamAppId` pattern).
function lutrisGameId(payload) {
    return (payload && typeof payload === 'object') ? payload.id : payload;
}

// The `rpcs3` process is the running emulator itself → the shared `spawnGame()` flow fits. The `"%RPCS3_GAMEID%:<TITLE_ID>"`
// form is RPCS3's documented "boot by title ID" (RPCS3 resolves the path from its own `games.yml`).
// ⚠️ DELIBERATELY no `--no-gui`: with it, after closing the game RPCS3 brought back its classic (non-controller) main window;
// the controller Big Picture Mode has to be enabled in RPCS3, and `--no-gui` suppressed it.
// Background: docs/dev/launchers/rpcs3.md
function rpcs3GameArgs(titleId) {
    return [`%RPCS3_GAMEID%:${titleId}`];
}

// The actual spawn `cmd`/`args` by the added RPCS3 launcher (native AppImage OR flatpak, the `lutrisLaunchSpec`
// pattern): native → `rpcs3 %RPCS3_GAMEID%:<id>`; flatpak → `flatpak run net.rpcs3.RPCS3 %RPCS3_GAMEID%:<id>`
// (DELIBERATELY no `--no-gui`, see `rpcs3GameArgs`). No rpcs3 launcher added → native fallback (`rpcs3`).
function rpcs3LaunchSpec(rpcs3Launcher, titleId) {
    if (rpcs3Launcher && rpcs3Launcher.cmd === 'flatpak') {
        return { cmd: 'flatpak', args: ['run', RPCS3_FLATPAK_ID, ...rpcs3GameArgs(titleId)] };
    }
    return { cmd: (rpcs3Launcher && rpcs3Launcher.cmd) || 'rpcs3', args: rpcs3GameArgs(titleId) };
}

// --- "Recently played" meta of the path-based emulators ---
// The 4th `meta` argument of `spawnGame` — ONLY for emulators booked at launch time (not `derivedRecent` in the registry);
// derived sources have none. `params` are the registry's `launchParams` (the first — `path` — raw, the rest `|| null`):
// needed for the cover download and for relaunching a favorite/quick-launch entry. `killable` (the descriptor's
// `launch.killable`, today only melonDS) → `killable: true` + `flatpakId`: the launch controller then allows the PS/Home force close.
/**
 * @param {{ id: string, launchParams: string[], derivedRecent?: boolean }} entry the registry row
 * @param {{ killable?: boolean }} launch the descriptor's `launch` field
 * @param {string} id the stable game id (`<x>GameId`)
 * @param {Record<string, any>} p the payload
 * @param {string[]} flatpakArgs the flatpak-shaped launch argument list (for `flatpakId`)
 */
function emulatorRecentMeta(entry, launch, id, p, flatpakArgs) {
    if (entry.derivedRecent) return undefined;
    const meta = {
        launcherId: entry.id, key: `${entry.id}-game-${id}`, name: p.name, cover: p.cover, kind: entry.id,
        params: launchParamsFor(entry, p),
    };
    return launch.killable ? { ...meta, killable: true, flatpakId: flatpakRunAppId(flatpakArgs) } : meta;
}

/**
 * @param {Object} deps
 * @param {() => Launcher[]} deps.getLaunchers
 * @param {(appId: string, cmd: string, args: string[], meta?: Object, extra?: { env?: Record<string, string> }) => unknown} deps.spawnGame
 * @param {(launcher: Launcher, pid: number|null) => unknown} deps.switchToRunning
 * @param {(launcher: Launcher) => Promise<{ running: boolean, pid: number|null }>} deps.isLauncherRunning
 * @param {(system: string) => (string|null)} deps.corePathForSystem   (pre-bound to the retroarch config root)
 * @param {() => boolean} deps.isSteamRunning   (logging only)
 * @param {import('../types.js').Logger} deps.log
 * @param {(channel: string, payload?: unknown) => void} deps.sendToRenderer
 * @param {(p: string) => boolean} [deps.fileExists]   does the ROM file exist (default `fs.existsSync`)
 * @param {() => any[]} [deps.getCustomGameSources]   the custom ROM-folder sources
 * @param {(key: string) => string} [deps.getLaunchOption]   the game's launch options (`gameLaunchOptions`, lib/launch/launch-options.js)
 * @param {Record<string, any>} deps.emulatorSources   descriptor of the registry emulators (lib/launchers/emulator-sources.js)
 *   — path-based emulators launch by their `launch` field
 */
function createLaunchHandlers(deps) {
    const {
        getLaunchers, spawnGame, switchToRunning, isLauncherRunning,
        corePathForSystem, isSteamRunning, log, sendToRenderer,
        fileExists = (p) => fs.existsSync(p), // injectable (tests)
        getCustomGameSources = () => [],
        getLaunchOption = () => '',
        emulatorSources,
    } = deps;
    requireDeps(deps, ['getLaunchers', 'spawnGame', 'switchToRunning', 'isLauncherRunning', 'corePathForSystem', 'isSteamRunning', 'log', 'sendToRenderer', 'emulatorSources'], 'createLaunchHandlers');

    // Invalid payload of a launch-* handler: log + `app-error` (the renderer's `onAppError` releases
    // `isLaunching` + shows a toast) — instead of the silent "hides, then the spawn watchdog brings it back
    // 6-8 s later". `reason` = prose for the log (+ `error` fallback); `errorKey` = renderer i18n key (`err.*`).
    const findLauncher = (id) => getLaunchers().find((l) => l.id === id);

    function rejectLaunch(appId, reason, errorKey, params) {
        log(`Launch rejected (${appId}): ${reason}`);
        sendToRenderer('app-error', { appId, error: reason, errorKey, ...(params ? { params } : {}) });
    }

    // Does the ROM/disc image exist — otherwise the emulator would start and exit right away (or get stuck on
    // its own error dialog). See lib/launch/launch-errors.js.
    function rejectIfMissing(appId, filePath) {
        if (fileExists(filePath)) return false;
        const info = fileMissingInfo(filePath);
        rejectLaunch(appId, info.error, info.errorKey, info.params);
        return true;
    }

    // The game's saved launch options (env + extra arguments) built into the spawn command. Unparseable text
    // (hand-edited config) → skipped with a log line, the launch continues without options.
    // `{ cmd, args, extra? }` — `extra.env` is the 5th parameter of spawnGame.
    function withLaunchOptions(key, spec, romPath) {
        const text = getLaunchOption(key);
        if (!text) return { cmd: spec.cmd, args: spec.args };
        const parsed = parseLaunchOptions(text);
        if (!parsed.ok) {
            log(`Launch options skipped (${key}): ${parsed.error}`);
            return { cmd: spec.cmd, args: spec.args };
        }
        const applied = applyLaunchOptions(spec.cmd, spec.args, romPath, parsed);
        log(`Launch options (${key}): ${Object.keys(parsed.env).length} env, ${parsed.args.length} arguments`);
        return { cmd: applied.cmd, args: applied.args, extra: Object.keys(applied.env).length ? { env: applied.env } : undefined };
    }

    async function launchApp(appId) {
        const launcher = getLaunchers().find((l) => l.id === appId);
        if (!launcher) {
            log(`Unknown launcher id: ${appId}`);
            return;
        }
        let status = /** @type {{ running: boolean, pid: number|null }} */ ({ running: false, pid: null });
        try {
            status = await isLauncherRunning(launcher);
        } catch (err) {
            log(`Running-check error (${appId}): ${err.message}`);
        }
        // Already running -> switch to its window (no new instance)
        if (status.running) {
            switchToRunning(launcher, status.pid);
        } else {
            spawnGame(appId, launcher.cmd, launcher.args);
        }
    }

    // RetroArch: `path` is the ROM path of the chosen .lpl entry, `system` picks the installed core from it
    // (lib/launchers/retroarch-library.js `SYSTEM_CORES`).
    function launchRetroarchGame(payload) {
        const p = payload || {};
        const system = str(p.system);
        const romPath = str(p.path, PATH_MAX);
        if (!system || !romPath) {
            rejectLaunch('retroarch-game', 'Missing system or ROM path', 'err.retroMissingPath');
            return;
        }
        if (rejectIfMissing('retroarch-game', romPath)) return;
        const core = corePathForSystem(system);
        if (!core) {
            log(`RetroArch launch: no core installed for this system: ${system}`);
            sendToRenderer('app-error', {
                appId: 'retroarch-game', error: 'No core installed for this system', errorKey: 'err.retroNoCore',
            });
            return;
        }
        // `usage` is shared (`retroarch-game`); "recently played" is NOT stored from here but derived from
        // RetroArch's `content_history.lpl` at read time.
        const spec = variantExecSpec(findLauncher('retroarch'), retroarchGameArgs(core, romPath));
        // Options of RetroArch ROMs are keyed by path (the playlist label is not in the payload): `retroarch-rom:<path>`.
        const run = withLaunchOptions(`retroarch-rom:${romPath}`, spec, romPath);
        spawnGame('retroarch-game', run.cmd, run.args, undefined, run.extra);
    }

    function launchSteamGame(payload) {
        const appid = steamAppId(payload);
        if (!appid) {
            rejectLaunch('steam-game', 'Missing Steam appid', 'err.steamMissingAppid');
            return;
        }
        const spec = steamLaunchSpec(findSteamLauncher(getLaunchers()), appid);
        log(`Starting Steam game (${spec.cmd}): appid ${appid} (Steam running: ${isSteamRunning()})`);
        spawnGame(`steam-game-${appid}`, spec.cmd, spec.args);
    }

    function launchHeroicGame(payload) {
        const p = payload || {};
        const appName = str(p.appName);
        const runner = str(p.runner, 40);
        const { name, cover } = p;
        if (!appName || !runner) {
            rejectLaunch(`heroic-game-${appName || '?'}`, 'Missing appName or runner', 'err.heroicMissingArgs');
            return;
        }
        const spec = variantExecSpec(findLauncher('heroic'), heroicGameArgs(appName, runner));
        spawnGame(`heroic-game-${appName}`, spec.cmd, spec.args, heroicMeta(appName, runner, name, cover));
    }

    function launchLutrisGame(payload) {
        const id = lutrisGameId(payload);
        if (id === undefined || id === null || id === '') {
            rejectLaunch('lutris-game', 'Missing Lutris game id', 'err.lutrisMissingId');
            return;
        }
        const lutrisLauncher = getLaunchers().find((l) => l.id === 'lutris');
        const spec = lutrisLaunchSpec(lutrisLauncher, id);
        spawnGame(`lutris-game-${id}`, spec.cmd, spec.args);
    }

    // The payload comes from the games panel's RPCS3 sub-list (OR a saved favorite/quick-launch entry): `titleId` is
    // required (the `games.yml` key — always present, no path-hash substitute needed). No `meta` ("recently played"
    // comes from `persistent_settings.dat` at READ time, as with PCSX2). The only emulator whose descriptor gives
    // NO `launch`: the id is not a path, and the spawn may be a native AppImage OR flatpak (`rpcs3LaunchSpec`).
    function launchRpcs3Game(payload) {
        const titleId = str((payload || {}).titleId, 40);
        if (!titleId) {
            rejectLaunch('rpcs3-game', 'Missing RPCS3 title ID', 'err.rpcs3MissingTitleId');
            return;
        }
        const rpcs3Launcher = getLaunchers().find((l) => l.id === 'rpcs3');
        const spec = rpcs3LaunchSpec(rpcs3Launcher, titleId);
        spawnGame(`rpcs3-game-${titleId}`, spec.cmd, spec.args);
    }

    // SHARED launch of the path-based emulators — by the descriptor's `launch` field (lib/launchers/emulator-sources.js):
    // `path` is required → the stable id via `launch.gameId` (the SAME library helper as when building the list, so a
    // favorite/quick-launch entry WITHOUT an `id` can be relaunched too) → `spawnGame`.
    function launchPathEmulatorGame(entry, launch, payload) {
        const kind = entry.id;
        const p = payload || {};
        if (!str(p.path, PATH_MAX)) {
            rejectLaunch(`${kind}-game`, launch.missingReason, `err.${kind}MissingPath`);
            return;
        }
        if (rejectIfMissing(`${kind}-game`, p.path)) return;
        const id = launch.gameId(p);
        const flatpakArgs = launch.args(p);
        const exec = variantExecSpec(findLauncher(kind), flatpakArgs);
        const meta = emulatorRecentMeta(entry, launch, id, p, flatpakArgs);
        // With the native variant there is no flatpak app to `flatpak kill` — the force close then stops the
        // spawned process (launch controller).
        const spawnMeta = meta && exec.cmd !== 'flatpak' && 'flatpakId' in meta ? { ...meta, flatpakId: null } : meta;
        const run = withLaunchOptions(`${kind}-game-${id}`, exec, p.path);
        spawnGame(`${kind}-game-${id}`, run.cmd, run.args, spawnMeta, run.extra);
    }

    // The SHARED `launch-emulator-game` { source, ...params } IPC: `source` is whitelisted against the registry
    // emulators — RPCS3 goes to its own (title-ID) handler, the rest to the descriptor's `launch` field. Unknown
    // source → `app-error`, no spawn.
    function launchEmulatorGame(payload) {
        const p = payload || {};
        const source = p.source;
        if (source === 'rpcs3') {
            launchRpcs3Game(p);
            return;
        }
        const entry = typeof source === 'string' ? EMULATOR_REGISTRY.find((e) => e.id === source) : null;
        const launch = entry && emulatorSources[source] && emulatorSources[source].launch;
        if (!launch) {
            rejectLaunch('emulator-game', `Unknown emulator source: ${JSON.stringify(source)}`, 'err.unknownGameSource');
            return;
        }
        launchPathEmulatorGame(entry, launch, p);
    }

    // Game of a custom ROM-folder source: `{ launcherId, path, name? }`. The file must be UNDER one of the folders of the
    // source set for the launcher, with a matching extension (the renderer must not launch an arbitrary file); the command
    // is the added launcher's `cmd`/`args` + the arguments built from the template. "Recently played" is booked at launch
    // time (under the launcher's card).
    function launchCustomGame(payload) {
        const { launcherId, path: romPath, name } = payload || {};
        const source = getCustomGameSources().find((s) => s.launcherId === launcherId);
        if (!source) {
            rejectLaunch('custom-game', `No ROM source for this launcher: ${launcherId}`, 'err.customNoSource');
            return;
        }
        if (typeof romPath !== 'string' || !romPath) {
            rejectLaunch('custom-game', 'Missing ROM path', 'err.customMissingPath');
            return;
        }
        if (rejectIfMissing('custom-game', romPath)) return;
        if (!customRoms.isRomInSource(source, romPath)) {
            rejectLaunch('custom-game', `The file is not in the configured ROM folder: ${romPath}`, 'err.customOutsideSource');
            return;
        }
        const launcher = findLauncher(launcherId);
        if (!launcher) {
            rejectLaunch('custom-game', `The launcher is no longer added: ${launcherId}`, 'err.customNoSource');
            return;
        }
        const id = customRoms.customGameId(launcherId, romPath);
        const args = [...(launcher.args || []), ...customRoms.buildCustomGameArgs(source.argsTemplate, romPath)];
        const run = withLaunchOptions(`custom-game-${id}`, { cmd: launcher.cmd, args }, romPath);
        spawnGame(`custom-game-${id}`, run.cmd, run.args, customRoms.customGameMeta(launcherId, id, name, romPath), run.extra);
    }

    return {
        launchApp, launchRetroarchGame, launchSteamGame, launchHeroicGame, launchLutrisGame,
        launchRpcs3Game, launchEmulatorGame, launchCustomGame, rejectLaunch,
    };
}

/**
 * The `launch-*` channels + the controller force close.
 * @param {Parameters<typeof createLaunchHandlers>[0] & {
 *   ipcMain: import('../types.js').IpcMainLike, killActiveGame: () => void,
 *   cancelLaunch: () => Promise<{ killed: boolean }>,
 *   getActiveSession: () => ({ appId: string, name: string, cover: string|null } | null),
 *   resumeActiveSession: () => Promise<{ ok: boolean, activated: boolean }> }} deps
 */
function registerLaunchIpc(deps) {
    const { ipcMain, killActiveGame, cancelLaunch, getActiveSession, resumeActiveSession } = deps;
    requireDeps(deps, ['ipcMain', 'killActiveGame', 'cancelLaunch', 'getActiveSession', 'resumeActiveSession'], 'registerLaunchIpc');
    const h = createLaunchHandlers(deps);
    ipcMain.on('launch-app', (event, appId) => h.launchApp(appId));
    ipcMain.on('launch-retroarch-game', (event, payload) => h.launchRetroarchGame(payload));
    ipcMain.on('launch-steam-game', (event, payload) => h.launchSteamGame(payload));
    ipcMain.on('launch-heroic-game', (event, payload) => h.launchHeroicGame(payload));
    ipcMain.on('launch-lutris-game', (event, payload) => h.launchLutrisGame(payload));
    // SHARED launch of the registry emulators: { source, ...params }.
    ipcMain.on('launch-emulator-game', (event, payload) => h.launchEmulatorGame(payload));
    // Game of a custom ROM-folder source.
    ipcMain.on('launch-custom-game', (event, payload) => h.launchCustomGame(payload));
    // Controller force close (PS/Home) of a game launched with `killable` meta (melonDS) — the return runs on
    // the usual `child.on('close')` → `bringToFront()` path.
    ipcMain.on('kill-active-game', () => { killActiveGame(); });
    // Cancel a launch on the loading screen (hold ○): `{ killed }` — the launcher comes back.
    ipcMain.handle('cancel-launch', () => cancelLaunch());
    // Running game: the active session + switching back, for the home screen's "BACK" item.
    ipcMain.handle('get-active-session', () => getActiveSession());
    ipcMain.handle('resume-active-session', () => resumeActiveSession());
    return h;
}

module.exports = {
    createLaunchHandlers, registerLaunchIpc,
    steamGameArgs, steamExecSpec, steamLaunchSpec, variantExecSpec, findSteamLauncher, steamAppId, heroicGameArgs, heroicMeta, retroarchGameArgs,
    lutrisGameArgs, lutrisLaunchSpec, lutrisGameId, rpcs3GameArgs, rpcs3LaunchSpec, emulatorRecentMeta,
};
