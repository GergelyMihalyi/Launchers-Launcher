#!/usr/bin/env node
// @ts-check
'use strict';

// Entry point of `npm start`: launches Electron with the `lib/ozone-platform.js`
// `pickOzonePlatform()` decision as an `--ozone-platform=<x>` CLI switch. This is REQUIRED:
// Chromium picks the ozone platform before the JS (main.js) loads, so an
// `app.commandLine.appendSwitch` is too late — when started without env (systemd --user
// watcher) it would fall back to x11 → "Missing X server or $DISPLAY" → SIGTRAP.

const { spawn } = require('child_process');
const path = require('path');
const { pickOzonePlatform } = require('../lib/ozone-platform.js');

const root = path.join(__dirname, '..');
const ozone = pickOzonePlatform();
const env = { ...process.env };
if (ozone.display && !env.DISPLAY) env.DISPLAY = ozone.display;
if (ozone.waylandDisplay && !env.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = ozone.waylandDisplay;

const electronBin = /** @type {string} */ (/** @type {unknown} */ (require('electron')));
const child = spawn(electronBin, [`--ozone-platform=${ozone.platform}`, root, ...process.argv.slice(2)],
    { stdio: 'inherit', env });

for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* already exited */ } });
}
child.on('error', (err) => { console.error(`failed to start electron: ${err.message}`); process.exit(1); });
// The exit code is passed through (the watcher relies on it: 0 = clean exit / relaunch,
// anything else = crash); a child killed by a signal (e.g. SIGTRAP) → 1.
child.on('exit', (code) => process.exit(code === null ? 1 : code));
