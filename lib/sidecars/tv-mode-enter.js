// @ts-check
'use strict';

// The `tvMode` config key (programs to close + pre-commands when entering TV mode) → a shell-friendly sidecar file read by
// `bin/tv-mode-enter.sh` (the same pattern as `main-controller.js`). ⚠️ NOT to be confused with `lib/output/tv-mode.js` — that is the
// cleanup of the TV-mode EXIT; this is the program-close list of the ENTRY. No `electron` reference.
// Background: docs/dev/output-tv.md#the-tv-mode-lifecycle

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../fs-atomic.js');
const { dataHome } = require('../xdg.js');

function sidecarPath() {
    return path.join(dataHome(), 'launchers-launcher-tvmode');
}

// A single-line, whitespace-trimmed string from a field value; newline/CR → signals skipping (`null`), so no single entry can break the
// line-based sidecar format.
function oneLine(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || /[\r\n]/.test(s)) return null;
    return s;
}

// The `tvMode` config object → sidecar text. Format: one `<type> <arg>` per line:
//   flatpak <app-id>        → `flatpak kill <id>` (stops the whole flatpak sandbox)
//   native  <process name>  → `pkill -TERM -x <name>` (EXACT name match, never -f/a pattern —
//                             that would catch system-level apps too)
//   cmd     <shell command> → `bash -lc '<command>'`
//
// tvMode: {
//   closeFlatpak: [ "com.foo.Bar" | { id: "com.foo.Bar" }, ... ],
//   closeNative:  [ "firefox", ... ],
//   preCommands:  [ "cd ~/x && ./y down", ... ]
// }
//
// ⚠️ DELIBERATELY NO `pkill -f <pattern>` mechanism: a user pattern (e.g. "vscode") would match non-flatpak apps too. `flatpak kill`
// is enough.
function serialize(tvMode) {
    const tv = tvMode && typeof tvMode === 'object' ? tvMode : {};
    const lines = [];

    for (const e of Array.isArray(tv.closeFlatpak) ? tv.closeFlatpak : []) {
        const id = typeof e === 'string' ? oneLine(e) : (e && typeof e === 'object' ? oneLine(e.id) : null);
        if (id) lines.push(`flatpak ${id}`);
    }
    for (const p of Array.isArray(tv.closeNative) ? tv.closeNative : []) {
        const name = oneLine(p);
        if (name) lines.push(`native ${name}`);
    }
    for (const c of Array.isArray(tv.preCommands) ? tv.preCommands : []) {
        const cmd = oneLine(c);
        if (cmd) lines.push(`cmd ${cmd}`);
    }

    return lines.length ? lines.join('\n') + '\n' : '';
}

// Atomic write (lib/fs-atomic.js). Empty/missing `tvMode` → empty file (= the script closes nothing, only starts). Returns the written text.
function writeSidecar(tvMode) {
    const body = serialize(tvMode);
    // 0600: bin/tv-mode-enter.sh runs the `cmd` lines with `bash -lc` — nobody else may write it (the script checks too).
    writeFileAtomic(sidecarPath(), body, { fsync: true, mode: 0o600 });
    return body;
}

function readSidecar() {
    try {
        return fs.readFileSync(sidecarPath(), 'utf8');
    } catch (err) {
        return '';
    }
}

module.exports = { sidecarPath, serialize, writeSidecar, readSidecar };
