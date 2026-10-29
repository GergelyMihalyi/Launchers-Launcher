// @ts-check
'use strict';

// "Is this launcher already running?" — for the "● RUNNING" badge (`running-poll.js`) and the `launch-app` branch. Signal per launcher:
// native Steam `~/.steam/steam.pid`; flatpak launcher (the flatpak Steam too — its `steam.pid` is a namespace-internal PID) `flatpak ps` for
// the appid line; native binary exact name match in `ps -eo pid=,comm=`. A "probe" memoizes the external commands: `flatpak ps` and `ps` run
// ONCE per poll. No `electron` reference. Background: docs/dev/launching.md

const os = require('os');
const path = require('path');
const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
const flatpak = require('../flatpak.js');
const { steamClientPid, isSteamLauncher } = require('../launchers/steam-library.js');

// The kernel truncates the process name (comm) to 15 characters — `pgrep -x` compares the same way.
const COMM_MAX = 15;

// The PID of the first process in `ps -eo pid=,comm=` output whose name is exactly `name` (truncated to 15 characters like the kernel's
// comm), or null. Pure.
function parseProcessList(psOutput, name) {
    const want = String(name || '').slice(0, COMM_MAX);
    if (!want) return null;
    for (const line of String(psOutput || '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*?)\s*$/);
        if (m && m[2] === want) return parseInt(m[1], 10);
    }
    return null;
}

async function processListOutput() {
    try {
        const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,comm='], { timeout: EXEC_TIMEOUT_MS });
        return stdout;
    } catch (err) {
        return null;
    }
}

// Memoized external commands of one query round (lazy: only what is needed runs).
function createProbe() {
    /** @type {Promise<string|null> | null} */
    let ps = null;
    /** @type {Promise<string|null> | null} */
    let procs = null;
    return {
        flatpakPs: () => ps || (ps = flatpak.flatpakPsOutput()),
        processList: () => procs || (procs = processListOutput()),
    };
}

// Is a launcher running right now — `{ running, pid }`. Best effort: any error → "not running".
// `probe` is optional (shared when checking several launchers in one round).
async function isLauncherRunning(launcher, homeDir = os.homedir(), probe = createProbe()) {
    if (!launcher) return { running: false, pid: null };

    if (isSteamLauncher(launcher) && launcher.cmd !== 'flatpak') {
        const pid = steamClientPid(homeDir);
        return { running: pid !== null, pid };
    }

    let pid = null;
    if (launcher.cmd === 'flatpak') {
        const out = await probe.flatpakPs();
        pid = out === null ? null : flatpak.parseFlatpakPs(out, flatpak.catalogAppId(launcher));
    } else {
        const out = await probe.processList();
        pid = out === null ? null : parseProcessList(out, path.basename(launcher.cmd));
    }
    return { running: pid !== null, pid };
}

// The running ones among the given launchers — `Map<launcherId, { pid }>`.
async function detectRunningLaunchers(launchers, homeDir = os.homedir()) {
    const probe = createProbe();
    const found = new Map();
    await Promise.all((launchers || []).map(async (l) => {
        const r = await isLauncherRunning(l, homeDir, probe);
        if (r.running) found.set(l.id, { pid: r.pid });
    }));
    return found;
}

module.exports = {
    parseProcessList, createProbe, isLauncherRunning, detectRunningLaunchers,
};
