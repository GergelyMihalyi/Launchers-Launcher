// @ts-check
'use strict';

// Do-not-disturb while playing: `start()`/`stop()` at the start/end of the launch sequence (`launch-controller` `onLaunchSequenceStart`/`End`).
// KDE: a `kde-inhibit --notifications sleep 86400` child process; `stop()` kills the process group (`process.kill(-pid)`). No
// `kde-inhibit` → silent no-op (checked once, cached). GNOME (`deps.desktop === 'gnome'`): the
// `org.gnome.desktop.notifications show-banners` gsetting — `start()` → `false` (ONLY if it was `true`), `stop()` → back to `true`.
// That is a PERSISTENT setting a crash would leave behind: `markerFile` records that we turned it off, and the next startup's
// `recover()` turns it back on; `stop()` is synchronous (`forceQuitCleanup`), so turning it back on is a detached `gsettings` child.
// Background: docs/dev/launching.md#foreground-guard-and-do-not-disturb

const fs = require('fs');
const path = require('path');

const GNOME_SCHEMA = 'org.gnome.desktop.notifications';
const GNOME_KEY = 'show-banners';

/**
 * @param {object} deps
 * @param {(msg: string) => void} deps.log
 * @param {(cmd: string, args: string[], opts?: object) => Promise<any>} deps.execFileAsync
 * @param {(cmd: string, args: string[], opts?: object) => any} deps.spawn
 * @param {number} deps.execTimeoutMs
 * @param {import('../desktop-env.js').DesktopEnv} [deps.desktop] default: KDE behavior
 * @param {string|null} [deps.markerFile] GNOME: "we turned the banners off" marker file
 */
function createDoNotDisturb({ log, execFileAsync, spawn, execTimeoutMs, desktop = 'unknown', markerFile = null }) {
    if (desktop === 'gnome') return createGnomeDoNotDisturb({ log, execFileAsync, spawn, execTimeoutMs, markerFile });
    let child = null;
    let wanted = false; // is a launch sequence running — against the race: it may end during the async probe
    let probed = false;
    let available = false;

    async function start() {
        wanted = true;
        if (child) return;
        if (!probed) {
            probed = true;
            try {
                await execFileAsync('which', ['kde-inhibit'], { timeout: execTimeoutMs });
                available = true;
            } catch (_) {
                log('"Do not disturb" skipped — no kde-inhibit');
            }
        }
        if (!available || child || !wanted) return; // the sequence ended meanwhile
        try {
            // detached: own process group → process.kill(-pid) also stops `kde-inhibit` + its `sleep` child
            // (so the inhibit is surely released).
            child = spawn('kde-inhibit', ['--notifications', 'sleep', '86400'], { stdio: 'ignore', detached: true });
            child.unref();
            child.on('error', () => { child = null; });
            child.on('exit', () => { child = null; });
            log('„Ne zavarj" BE (kde-inhibit --notifications)');
        } catch (err) {
            child = null;
            log(`"Do not disturb" start error: ${err.message}`);
        }
    }

    function stop() {
        wanted = false;
        if (!child) return;
        const pid = child.pid;
        child = null;
        try {
            process.kill(-pid, 'SIGTERM'); // a folyamatcsoport (kde-inhibit + sleep)
        } catch (_) {
            try { process.kill(pid, 'SIGTERM'); } catch (_) { /* already dead */ }
        }
        log('„Ne zavarj" KI');
    }

    return { start, stop, recover: () => {} };
}

/** @param {{ log: (msg: string) => void, execFileAsync: Function, spawn: Function, execTimeoutMs: number, markerFile: string|null }} deps */
function createGnomeDoNotDisturb({ log, execFileAsync, spawn, execTimeoutMs, markerFile }) {
    let wanted = false;
    let active = false; // we turned the banners off and have not turned them back on yet
    let busy = false;

    function writeMarker() {
        if (!markerFile) return;
        try {
            fs.mkdirSync(path.dirname(markerFile), { recursive: true });
            fs.writeFileSync(markerFile, `${new Date().toISOString()}\n`);
        } catch (_) { /* best effort */ }
    }
    function clearMarker() {
        if (!markerFile) return;
        try { fs.rmSync(markerFile, { force: true }); } catch (_) { /* best effort */ }
    }
    // Detached child: runs even after a `stop()` right before `app.exit()`.
    function restoreBanners() {
        try {
            const c = spawn('gsettings', ['set', GNOME_SCHEMA, GNOME_KEY, 'true'], { stdio: 'ignore', detached: true });
            if (c && typeof c.on === 'function') c.on('error', (err) => log(`"Do not disturb" restore error: ${err.message}`));
            if (c && typeof c.unref === 'function') c.unref();
        } catch (err) {
            log(`"Do not disturb" restore error: ${err.message}`);
        }
        clearMarker();
    }

    async function start() {
        wanted = true;
        if (active || busy) return;
        busy = true;
        try {
            const { stdout } = await execFileAsync('gsettings', ['get', GNOME_SCHEMA, GNOME_KEY], { timeout: execTimeoutMs });
            if (String(stdout).trim() !== 'true') {
                log('"Do not disturb" is already on in GNOME — leaving it alone');
                return;
            }
            if (!wanted) return; // the sequence ended meanwhile
            writeMarker(); // BEFORE the write: turns it back on even after a crash in between
            await execFileAsync('gsettings', ['set', GNOME_SCHEMA, GNOME_KEY, 'false'], { timeout: execTimeoutMs });
            active = true;
            log('„Ne zavarj" BE (GNOME show-banners=false)');
            if (!wanted) stop(); // ended during the `set`
        } catch (err) {
            log(`"Do not disturb" skipped — gsettings error: ${err.message}`);
            if (!active) clearMarker();
        } finally {
            busy = false;
        }
    }

    function stop() {
        wanted = false;
        if (!active) return;
        active = false;
        restoreBanners();
        log('„Ne zavarj" KI (GNOME show-banners=true)');
    }

    // At startup: an earlier run (crash / SIGKILL) left the banners turned off.
    function recover() {
        if (!markerFile || !fs.existsSync(markerFile)) return;
        log('"Do not disturb": left on by an earlier run — GNOME notifications switched back on');
        restoreBanners();
    }

    return { start, stop, recover };
}

module.exports = { createDoNotDisturb };
