'use strict';

// Line ceiling of `main.js` — a "ratchet". After the `lib/ipc` extractions the file grew back
// from 1056 to 1511 lines in two days, because the handler bodies of new features landed here
// again. main.js's job is wiring (construction + `register*Ipc` calls); the bodies belong in
// `lib/ipc/<domain>-ipc.js` (see "Folder organisation rules" in docs/dev/architecture.md).
//
// The ceiling may ONLY BE LOWERED: if you are well below it after an extraction, pull it down here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS_MAX_LINES = 585;

test(`main.js stays under ${MAIN_JS_MAX_LINES} lines`, () => {
    const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8').split('\n').length;
    assert.ok(lines <= MAIN_JS_MAX_LINES,
        `main.js ${lines} lines (cap ${MAIN_JS_MAX_LINES}) — put the new handler body into lib/ipc/<domain>-ipc.js, `
        + 'main.js keeps only the construction + the one-line ipcMain.on/handle wiring');
});
