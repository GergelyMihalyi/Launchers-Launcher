// @ts-check
'use strict';

// "Auto-start on controller" — sidecar file for the trigger chain (`bin/launchers-launcher-bt-trigger.sh`). Does NOT affect the watcher +
// bt-trigger units (they always run) — it only decides whether a recognized controller connection starts the launcher. Why a sidecar
// and not `jq config.json`: `jq` is not guaranteed to be installed, and the trigger runs early in boot with a minimal PATH — a plain `cat`
// is bulletproof. No `electron` reference. Background: docs/dev/infrastructure.md#sidecar-files-for-shell-scripts

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../fs-atomic.js');
const { dataHome } = require('../xdg.js');

// Follows the log file convention (~/.local/share/launchers-launcher*). On Linux `os.homedir()` returns `$HOME` — the tests point it to a
// temp folder before the require.
function sidecarPath() {
    return path.join(dataHome(), 'launchers-launcher-autostart');
}

// Atomic write (lib/fs-atomic.js). `enabled !== false` → empty file (= "a controller may start the launcher", the default behavior).
// `enabled === false` → "disabled" content (the bt-trigger guard looks for it).
function writeSidecar(enabled) {
    const value = enabled !== false;
    writeFileAtomic(sidecarPath(), value ? '' : 'disabled\n', { fsync: true });
    return value;
}

// Mirror of the guard logic (the shell script `cat`s it itself) — for tests / diagnostics. Missing file / read error → `true` (no
// sidecar = no restriction, like the empty main-controller sidecar).
function readSidecar() {
    try {
        return fs.readFileSync(sidecarPath(), 'utf8').trim() !== 'disabled';
    } catch (err) {
        return true;
    }
}

module.exports = { sidecarPath, writeSidecar, readSidecar };
