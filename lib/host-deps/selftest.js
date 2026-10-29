// @ts-check
'use strict';

// Startup command self-test: are the external commands the launcher calls available (otherwise it would only show up in the given
// feature, with a timeout); the Diagnostics subview shows it too. `cec-ctl` is DELIBERATELY not on the list (the `cecAvailable()` guard
// handles it, its absence is not an error). Installing the missing ones: `host-packages.js`. Background: docs/dev/infrastructure.md#host-dependencies

const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
const { desktopEnv } = require('../desktop-env.js');

// The full (KDE) list. On GNOME `kscreen-doctor` is not needed — the monitor switch goes through Mutter's D-Bus there (`busctl`, part
// of systemd)
const REQUIRED_COMMANDS = ['pactl', 'kscreen-doctor', 'bluetoothctl', 'flatpak', 'git'];
const KDE_ONLY_COMMANDS = ['kscreen-doctor'];

/** The commands actually called on the given DE. Pure. @param {import('../desktop-env.js').DesktopEnv} [desktop] */
function requiredCommands(desktop = desktopEnv()) {
    return desktop === 'gnome' ? REQUIRED_COMMANDS.filter((c) => !KDE_ONLY_COMMANDS.includes(c)) : REQUIRED_COMMANDS;
}

// Pairs the `Promise.allSettled` results with the command names: fulfilled -> ok, everything else (rejected: non-0 `which` exit code /
// timeout) -> missing. Pure function.
function summarizeSelftest(settled, commands = requiredCommands()) {
    return commands.map((cmd, i) => ({
        cmd,
        ok: !!(settled[i] && settled[i].status === 'fulfilled'),
    }));
}

let cache = null;

// `which <cmd>` for all, in parallel. Module-level cache (runs once per process) — like `cecAvailableCache` in lib/output/cec.js; so the
// `get-selftest` IPC is cheap.
async function checkCommands(commands) {
    const isDefault = commands === undefined;
    if (isDefault) commands = requiredCommands();
    if (cache && isDefault) return cache;
    const settled = await Promise.allSettled(
        commands.map((cmd) => execFileAsync('which', [cmd], { timeout: EXEC_TIMEOUT_MS })),
    );
    const result = summarizeSelftest(settled, commands);
    if (isDefault) cache = result;
    return result;
}

// Drops the cache — after a package install (lib/host-deps/host-packages.js) the next `checkCommands()` runs `which` again.
function invalidate() {
    cache = null;
}

module.exports = { REQUIRED_COMMANDS, requiredCommands, summarizeSelftest, checkCommands, invalidate };
