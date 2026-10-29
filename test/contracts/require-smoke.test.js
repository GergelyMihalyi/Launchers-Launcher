'use strict';

// Every lib/**/*.js (including the lib/launchers/ subfolder) must `require` without errors
// (it runs in the sandbox too, since they have no `electron`/`BrowserWindow` reference) — a
// forgotten require / bad export would cause a "white screen on the kiosk" when main.js loads;
// this catches it early.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listJsFiles } = require('../helpers/fs.js');

const LIB_DIR = path.join(__dirname, '..', '..', 'lib');

const files = listJsFiles(LIB_DIR);

test('lib/**/*.js contains at least one file', () => {
    assert.ok(files.length > 0);
});

for (const file of files) {
    test(`require('lib/${file}') does not throw, and exports an object`, () => {
        const mod = require(path.join(LIB_DIR, file));
        assert.equal(typeof mod, 'object');
        assert.notEqual(mod, null);
    });
}
