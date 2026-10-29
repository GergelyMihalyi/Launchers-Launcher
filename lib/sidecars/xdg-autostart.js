// @ts-check
'use strict';

// XDG autostart entry for the `startWithSystem` key: opens the launcher window automatically at login, COMPLETELY INDEPENDENT of
// `controllerAutostart` (that only enables the controller BT trigger, see `autostart.js`). A freedesktop-compatible DE runs
// `~/.config/autostart/*.desktop` when the session starts; no sudo, only writes into $HOME. `Exec=` points to
// `bin/launchers-launcher-show.sh` (running → bring to front, otherwise start). No `electron` reference.
// Background: docs/dev/infrastructure.md#sidecar-files-for-shell-scripts

const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeFileAtomic } = require('../fs-atomic.js');

function autostartDir(homeDir) {
    const home = homeDir || os.homedir();
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart');
}

function autostartDesktopPath(homeDir) {
    return path.join(autostartDir(homeDir), 'launchers-launcher.desktop');
}

// Pure helper (kept apart from the file I/O for tests) — the minimal fields of the freedesktop.org autostart spec.
function desktopEntryContent(repoRoot) {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=Launchers Launcher',
        `Icon=${path.join(repoRoot, 'assets', 'logo', 'logo.svg')}`,
        `Exec=${path.join(repoRoot, 'bin', 'launchers-launcher-show.sh')}`,
        'Terminal=false',
        '',
    ].join('\n');
}

// Atomic write (lib/fs-atomic.js).
function writeAutostartEntry(repoRoot, homeDir) {
    writeFileAtomic(autostartDesktopPath(homeDir), desktopEntryContent(repoRoot));
}

function removeAutostartEntry(homeDir) {
    try {
        fs.rmSync(autostartDesktopPath(homeDir), { force: true });
    } catch (err) {
        // noop — nothing to delete
    }
}

// For the resync (app.whenReady): compares the config's `startWithSystem` value with the actual presence of the file, for a hand-edited
// config.json / a file deleted by hand.
function isAutostartEntryPresent(homeDir) {
    try {
        fs.accessSync(autostartDesktopPath(homeDir));
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = {
    autostartDir,
    autostartDesktopPath,
    desktopEntryContent,
    writeAutostartEntry,
    removeAutostartEntry,
    isAutostartEntryPresent,
};
