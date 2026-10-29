// @ts-check
'use strict';

// Moving the launcher window to an output under KDE Plasma (Wayland): a client cannot position itself, but KWin can from a loaded script
// (`workspace.sendClientToScreen`). Needed with `display.keepOtherMonitors` (the old monitor stays on, the window would stick there);
// without it KWin moves it by itself. Verified on the machine: the window can be found by its `pid`, and a FULLSCREEN window moves correctly
// WITHOUT toggling `fullScreen` (toggling caused an async race).
// Flow: temp file → `loadScript` → `run` → `unloadScript`; non-KDE / missing D-Bus → `false`, never throws.
// Background: docs/dev/launching.md#window-activation-and-moving-kde

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileAsync, EXEC_TIMEOUT_MS, toLogger } = require('../exec.js');
const { desktopEnv } = require('../desktop-env.js');
const { X11_FULLSCREEN_LEAVE_MS, X11_DISPLAY_POLL_MS, X11_DISPLAY_POLL_TRIES } = require('../timings.js');

const KWIN_DEST = 'org.kde.KWin';
const PLUGIN_NAME = 'launchers-launcher-move-window';

// Pure: the text of the KWin JS script. The output name goes in as a JSON literal (no injection), the pid can only be a positive integer.
function buildMoveScript(pid, output) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${pid}`);
    if (typeof output !== 'string' || !output) throw new Error('missing output name');
    return [
        `const target = workspace.screens.find((s) => s.name === ${JSON.stringify(output)});`,
        `const win = workspace.windowList().find((w) => w.pid === ${pid} && w.normalWindow);`,
        'if (target && win) {',
        '    if (win.output !== target) workspace.sendClientToScreen(win, target);',
        // For a window still opening, the move may lose fullscreen — we ONLY turn it back on (toggling caused an async race, see above).
        '    if (!win.fullScreen) win.fullScreen = true;',
        '    workspace.activeWindow = win;',
        '}',
        '',
    ].join('\n');
}

// The `gdbus call ... loadScript` output is e.g. `(3,)` — the script id; `-1` = failed.
function parseLoadScriptId(stdout) {
    const m = String(stdout).match(/\((-?\d+),?\)/);
    return m ? parseInt(m[1], 10) : null;
}

// The KWin D-Bus service is missing (non-KDE session, e.g. GNOME/X11 — in production: ThinkPad T410): on the first such error we log
// ONCE, after that the call is silently skipped (it is called twice at startup — do not repeat the same error).
const KWIN_MISSING_RE = /ServiceUnknown|was not provided by any|NameHasNoOwner/;
let kwinMissing = false;

/** @param {any} err */
function isKwinMissingError(err) {
    return KWIN_MISSING_RE.test(String((err && (err.stderr || err.message)) || ''));
}

const gdbus = (args) => execFileAsync('gdbus', ['call', '--session', '--dest', KWIN_DEST, ...args], { timeout: EXEC_TIMEOUT_MS });

async function unload() {
    await gdbus(['--object-path', '/Scripting', '--method', 'org.kde.kwin.Scripting.unloadScript', PLUGIN_NAME])
        .catch(() => {});
}

// Moves the window (pid) to the `output` output. `true` = the script ran (the actual move in KWin is async). Never throws.
async function moveWindowToOutput(pid, output, log) {
    const emit = toLogger(log);
    if (kwinMissing) return false;
    // GNOME has no KWin scripting (and Mutter has no window-moving D-Bus API). We log once, as with a missing KWin.
    if (desktopEnv() === 'gnome') {
        kwinMissing = true;
        emit('Window move skipped: not supported on GNOME (no KWin) — it will not try again');
        return false;
    }
    let file = null;
    try {
        const script = buildMoveScript(pid, output);
        file = path.join(os.tmpdir(), `${PLUGIN_NAME}-${process.pid}.js`);
        fs.writeFileSync(file, script);
        await unload(); // an earlier, stuck instance must not get in the way (loadScript → -1)
        const { stdout } = await gdbus(['--object-path', '/Scripting', '--method',
            'org.kde.kwin.Scripting.loadScript', file, PLUGIN_NAME]);
        const id = parseLoadScriptId(stdout);
        if (id === null || id < 0) {
            emit(`Window move (${output}): KWin did not load the script (${String(stdout).trim()})`);
            return false;
        }
        await gdbus(['--object-path', `/Scripting/Script${id}`, '--method', 'org.kde.kwin.Script.run']);
        await new Promise((r) => setTimeout(r, 300));
        await unload();
        emit(`Launcher window moved: ${output}`);
        return true;
    } catch (err) {
        if (isKwinMissingError(err)) {
            kwinMissing = true;
            emit(`Window move skipped: KWin is unavailable (not a KDE Plasma session) — it will not try again`);
            return false;
        }
        emit(`Window move (${output}) failed: ${err.message}`);
        return false;
    } finally {
        if (file) fs.rm(file, { force: true }, () => {});
    }
}

// Is the startup move needed: the target output is active AND there is another active output next to it. With a single active monitor
// (laptop, only the built-in display) the window is there anyway. Pure.
/** @param {Array<{ name: string, active?: boolean }>} monitors @param {string} target */
function shouldMoveToStartupMonitor(monitors, target) {
    const active = (monitors || []).filter((m) => m && m.active);
    return active.length > 1 && active.some((m) => m.name === target);
}

// Pure: the Electron display (`screen.getAllDisplays()`) belonging to the output's geometry (`displays.outputGeometry`, in screen pixels).
// Electron's `label` is NOT the connector name (but the monitor name, e.g. "VP201b"), so the position decides: the top-left corner of
// `bounds` × `scaleFactor` matches. No exact match → the display containing the center of the geometry; none either → null (the monitor
// has not appeared in Electron's list yet).
/**
 * @param {Array<{ id: number, bounds: { x: number, y: number, width: number, height: number }, scaleFactor?: number }>} displays
 * @param {{ x: number, y: number, width: number, height: number }} geom
 */
function pickDisplayForGeometry(displays, geom) {
    if (!geom || !Array.isArray(displays)) return null;
    const sf = (d) => d.scaleFactor || 1;
    const exact = displays.find((d) => Math.round(d.bounds.x * sf(d)) === geom.x && Math.round(d.bounds.y * sf(d)) === geom.y);
    if (exact) return exact;
    const cx = geom.x + geom.width / 2;
    const cy = geom.y + geom.height / 2;
    return displays.find((d) => {
        const b = d.bounds;
        const s = sf(d);
        return cx >= b.x * s && cx < (b.x + b.width) * s && cy >= b.y * s && cy < (b.y + b.height) * s;
    }) || null;
}

/**
 * Moves the LAUNCHER window to an output (with `keepOtherMonitors`, on a monitor switch + at startup). KDE: the KWin script above.
 * GNOME + X11: Electron moves it ITSELF (on X11 a client may position its own window): the target geometry from Mutter
 * (`displays.outputGeometry`), the matching Electron display (`pickDisplayForGeometry`), fullscreen off → `setBounds` → fullscreen on.
 * GNOME + Wayland: no client positioning and no KWin script → skipped, logged once.
 * The caller passes Electron's `screen` and the window (the module does not require electron).
 * @param {Object} deps
 * @param {{ getAllDisplays: () => any[], getDisplayMatching: (rect: any) => { id: number } }} deps.screen
 * @param {() => any} deps.getWindow the launcher's `BrowserWindow` (may be null / destroyed)
 * @param {{ outputGeometry: (output: string) => Promise<any>, readDisplayConfig: () => { monitor?: string|null },
 *   listMonitors: () => Promise<any[]> }} deps.displays
 * @param {string} deps.platform the ozone platform (`wayland` / `x11`)
 * @param {(msg: string) => void} deps.log
 * @param {string} [deps.desktop] default: `desktopEnv()`
 * @param {number} [deps.pid] default: `process.pid` (the KWin script finds the window by it)
 * @param {(output: string) => Promise<boolean>} [deps.kwinMove] for tests; default: `moveWindowToOutput`
 */
function createLauncherMover({
    screen, getWindow, displays, platform, log, desktop = desktopEnv(), pid = process.pid,
    kwinMove = (output) => moveWindowToOutput(pid, output, log),
}) {
    let gnomeWaylandLogged = false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // `true` = moved / was already there. Never throws.
    async function moveTo(output) {
        if (desktop !== 'gnome') return kwinMove(output);
        if (platform !== 'x11') {
            if (!gnomeWaylandLogged) log('Window move skipped: not supported on GNOME Wayland');
            gnomeWaylandLogged = true;
            return false;
        }
        try {
            const geom = await displays.outputGeometry(output);
            if (!geom) { log(`Window move (${output}): the output is not active`); return false; }
            // A monitor just turned on only appears in Electron's `screen` list a bit later.
            let target = null;
            for (let i = 0; i < X11_DISPLAY_POLL_TRIES; i++) {
                target = pickDisplayForGeometry(screen.getAllDisplays(), geom);
                if (target) break;
                await sleep(X11_DISPLAY_POLL_MS);
            }
            const win = getWindow();
            if (!target || !win || win.isDestroyed()) {
                if (!target) log(`Window move (${output}): Electron cannot see the display`);
                return false;
            }
            if (screen.getDisplayMatching(win.getBounds()).id === target.id) {
                if (!win.isFullScreen()) win.setFullScreen(true);
                return true;
            }
            if (win.isFullScreen()) {
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, X11_FULLSCREEN_LEAVE_MS);
                    win.once('leave-full-screen', () => { clearTimeout(t); resolve(); });
                    win.setFullScreen(false);
                });
            }
            if (win.isDestroyed()) return false;
            win.setBounds(target.bounds);
            win.setFullScreen(true);
            log(`Launcher window moved: ${output} (X11)`);
            return true;
        } catch (err) {
            log(`Window move (${output}) failed: ${err.message}`);
            return false;
        }
    }

    // At startup: to the startup monitor, but ONLY if there are several active outputs (`shouldMoveToStartupMonitor`). Never throws.
    async function moveToStartupMonitor() {
        const cfg = displays.readDisplayConfig();
        if (!cfg.monitor) return false;
        try {
            const mons = await displays.listMonitors();
            return shouldMoveToStartupMonitor(mons, cfg.monitor) ? await moveTo(cfg.monitor) : false;
        } catch (err) {
            log(`Startup window move error: ${err.message}`);
            return false;
        }
    }

    return { moveTo, moveToStartupMonitor };
}

// Tests only: resets the "KWin missing" state.
function _resetKwinMissing() { kwinMissing = false; }

module.exports = {
    buildMoveScript, parseLoadScriptId, moveWindowToOutput, isKwinMissingError, shouldMoveToStartupMonitor,
    pickDisplayForGeometry, createLauncherMover,
    PLUGIN_NAME, _resetKwinMissing,
};
