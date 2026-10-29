// @ts-check
'use strict';

// Brings a running application's window to the front under KDE Plasma (Wayland) through the D-Bus interface of KWin's KRunner window
// switcher (`org.kde.KWin /WindowsRunner`: `Match(query)` → `a(sssuda{sv})`, `Run(matchId, actionId)`). Needs `gdbus` (`qdbus` fails on
// the complex return type). On GNOME there is no equivalent (the Shell has no public API to activate a foreign window) → `false`, the caller
// falls back to a normal launch. No `electron` reference — `test/launch/window-activate.test.js` (parser).
// Background: docs/dev/launching.md#window-activation-and-moving-kde

const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
const { desktopEnv } = require('../desktop-env.js');

const KWIN_DEST = 'org.kde.KWin';
const WINDOWS_RUNNER_PATH = '/WindowsRunner';

// The `gdbus call ... Match` output is Python-repr-like: every match is a `('<id>', '<caption>', '<iconName>', <type>, <relevance>, {...})`
// tuple. The `id` format is stable (`<number>_{<uuid>}`), the caption is arbitrary text (gdbus escapes an inner `'` as `\'`). The
// `icon-data` prop may be a byte array of hundreds of KB — so we do NOT parse the whole structure, only pull the `(id, caption)` prefix of
// each match with a regex.
function parseWindowsRunnerMatches(gdbusOutput) {
    const out = [];
    const re = /\('(\d+_\{[0-9a-fA-F-]+\})',\s*'((?:\\.|[^'\\])*)'/g;
    let m;
    while ((m = re.exec(String(gdbusOutput)))) {
        out.push({ id: m[1], caption: m[2].replace(/\\(.)/g, '$1') });
    }
    return out;
}

// The id of the window best matching the query. KWin returns them in descending relevance, so the first is the best by default; but if one's
// caption contains the query (case-insensitive), it is preferred (e.g. the "… - Steam" main window among several windows for "steam").
function pickMatch(matches, query) {
    if (!matches.length) return null;
    const q = String(query || '').toLowerCase();
    const exact = q && matches.find((mt) => mt.caption.toLowerCase().includes(q));
    return (exact || matches[0]).id;
}

// Activates the first window matching `query` (in KWin's `Match` the query is matched against the window caption AND the resource class).
// Returns `true` if it found one and ran `Run`; `false` if there is no matching window (the app runs but has no visible window — the caller
// may fall back to a normal launch). Throws on error.
async function activateWindow(query, opts = {}) {
    if ((opts.desktop || desktopEnv()) === 'gnome') return false;
    const timeout = opts.timeout || EXEC_TIMEOUT_MS;
    const { stdout } = await execFileAsync('gdbus', [
        'call', '--session', '--dest', KWIN_DEST, '--object-path', WINDOWS_RUNNER_PATH,
        '--method', 'org.kde.krunner1.Match', String(query),
    ], { timeout });
    const matchId = pickMatch(parseWindowsRunnerMatches(stdout), query);
    if (!matchId) return false;
    await execFileAsync('gdbus', [
        'call', '--session', '--dest', KWIN_DEST, '--object-path', WINDOWS_RUNNER_PATH,
        '--method', 'org.kde.krunner1.Run', matchId, '',
    ], { timeout });
    return true;
}

module.exports = { parseWindowsRunnerMatches, pickMatch, activateWindow };
