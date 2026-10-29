'use strict';

// `npm run test:e2e` — runner of the offscreen Electron smoke (test/e2e/harness.js). INTENTIONALLY
// not `*.test.js` (the `npm test` glob does not pick it up): it starts a real Electron binary (~7 s),
// and here we remove the sandboxed agent environment's `ELECTRON_RUN_AS_NODE=1` from the child env.
// One `node:test` test per scenario; missing Electron binary → skip.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');

function electronBinary() {
    try {
        return require(path.join(root, 'node_modules', 'electron')); // the package exports the binary's path
    } catch (err) {
        return null;
    }
}

const bin = electronBinary();
let out = null;
let runError = null;

if (bin && fs.existsSync(bin)) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const res = spawnSync(bin, [path.join(__dirname, 'harness.js'), '--headless', '--no-sandbox'], {
        env, cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
    });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('E2E_RESULT '));
    if (!line) runError = `no E2E_RESULT (exit ${res.status}, signal ${res.signal})\n${(res.stderr || '').slice(-2000)}`;
    else out = JSON.parse(line.slice('E2E_RESULT '.length));
}

test('the e2e harness ran', { skip: !bin && 'electron is not installed' }, () => {
    assert.equal(runError, null, runError || '');
    assert.equal(out.fatal, undefined, out.fatal);
    console.log(`# Electron ${out.electron} / Chrome ${out.chrome}, ${out.size}`);
});

for (const r of (out && out.results) || []) {
    test(r.name, () => {
        assert.ok(r.ok, r.failures.join('\n'));
    });
}

test('no console.error in the renderer', { skip: !out || !!out.fatal }, () => {
    assert.deepEqual(out.consoleErrors, []);
});
