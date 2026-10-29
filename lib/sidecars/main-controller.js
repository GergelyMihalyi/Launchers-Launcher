// @ts-check
'use strict';

// "Main controller" sidecar: the launcher writes the chosen BT MAC (from the `mainController` key) into a plain text file, the TV-mode
// entry script `cat`s it and guards with it (only starts if the main controller is connected right now). Why not `jq config.json`: `jq`
// is not guaranteed to be installed, the code runs early in boot with a minimal PATH. No `electron` reference.
// Background: docs/dev/infrastructure.md#sidecar-files-for-shell-scripts

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../fs-atomic.js');
const { dataHome } = require('../xdg.js');

// Follows the log file convention (~/.local/share/launchers-launcher.log). On Linux `os.homedir()` returns `$HOME` — the tests point it to
// a temp folder before the require.
function sidecarPath() {
    return path.join(dataHome(), 'launchers-launcher-main-controller');
}

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function isMac(v) {
    return typeof v === 'string' && MAC_RE.test(v.trim());
}

// Atomic write (lib/fs-atomic.js). `null`/invalid MAC → empty file (= "any controller", the guard does not filter then). Returns the
// written MAC or `null`.
function writeSidecar(mac) {
    const value = isMac(mac) ? mac.trim().toUpperCase() : null;
    writeFileAtomic(sidecarPath(), value ? value + '\n' : '', { fsync: true });
    return value;
}

// Mirror of the guard logic (the shell script `cat`s it itself) — for tests / diagnostics.
function readSidecar() {
    try {
        const raw = fs.readFileSync(sidecarPath(), 'utf8').trim();
        return isMac(raw) ? raw.toUpperCase() : null;
    } catch (err) {
        return null; // no file / unreadable → no filtering
    }
}

module.exports = { sidecarPath, MAC_RE, isMac, writeSidecar, readSidecar };
