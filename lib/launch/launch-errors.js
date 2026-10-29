// @ts-check
'use strict';

// The SPECIFIC reason of a failed launch for the toast (the most common case: the emulator starts, then exits immediately with an error
// code). DELIBERATELY no stderr capture: with a pipe the game could get SIGPIPE when the launcher quits, with a file it would grow with the
// Steam/Proton output — instead targeted checks (spawn error code, is the flatpak installed, does the file exist); the full output can be
// logged with `LAUNCHER_DEBUG_CHILD=1`. Every function returns `{ errorKey, params, error }` (`err.*` i18n key + Hungarian fallback).
// Background: docs/dev/launching.md#failed-launches

const path = require('path');
const { flatpakRunAppId } = require('../flatpak.js');

// The name shown to the user from a command: for flatpak the last segment of the appid (`org.DolphinEmu.dolphin-emu` → `dolphin-emu`),
// otherwise the command's file name.
function appLabel(cmd, args) {
    const appId = cmd === 'flatpak' ? flatpakRunAppId(args || []) : null;
    if (appId) return appId.split('.').pop() || appId;
    return path.basename(String(cmd || '?'));
}

// `child.on('error')` — the spawn itself failed (no such command / not executable).
function spawnErrorInfo(err, cmd) {
    const code = err && err.code;
    const name = path.basename(String(cmd || '?'));
    if (code === 'ENOENT') {
        return { errorKey: 'err.cmdNotFound', params: { cmd: name }, error: `Command not found: ${name}` };
    }
    if (code === 'EACCES') {
        return { errorKey: 'err.cmdNoPermission', params: { cmd: name }, error: `No permission to run: ${name}` };
    }
    const message = err && err.message ? err.message : String(err);
    return { errorKey: 'err.spawnFailed', params: { msg: message }, error: message };
}

function spawnTimeoutInfo(cmd, args) {
    const name = appLabel(cmd, args);
    return { errorKey: 'err.spawnTimeout', params: { name }, error: `The launch was aborted by a timeout (${name})` };
}

// Quick exit with an error code. `flatpakInstalled`: `true`/`false`/`null` (not flatpak / cannot be checked). If the flatpak is not
// installed, that is the likely reason.
function quickExitInfo({ cmd, args, code, flatpakInstalled }) {
    const name = appLabel(cmd, args);
    if (cmd === 'flatpak' && flatpakInstalled === false) {
        const appId = flatpakRunAppId(args || []) || name;
        return { errorKey: 'err.flatpakNotInstalled', params: { app: appId }, error: `The flatpak ${appId} is not installed` };
    }
    return { errorKey: 'err.quickExit', params: { name, code }, error: `${name} exited immediately (code ${code})` };
}

// Should a `close` be reported as an error: non-zero exit code, no signal, within the quick window, and the close was not requested by
// the user (PS force close → 137). So the `steam` wrapper's early `exit 0` is not an error.
function isQuickFailure({ code, signal, elapsedMs, quickExitMs, killRequested }) {
    return !killRequested && !signal && Number.isInteger(code) && code !== 0 && elapsedMs < quickExitMs;
}

// The missing ROM/disc-image file (BEFORE the launch, in `lib/ipc/launch-ipc.js`).
function fileMissingInfo(filePath) {
    const file = path.basename(String(filePath || '?'));
    return { errorKey: 'err.fileMissing', params: { file }, error: `File not found: ${filePath}` };
}

module.exports = {
    appLabel, spawnErrorInfo, spawnTimeoutInfo, quickExitInfo, isQuickFailure, fileMissingInfo,
};
