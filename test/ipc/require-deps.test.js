'use strict';

// lib/ipc/require-deps.js — fail-fast deps check + the guard of the convention:
// every `lib/ipc` register/create constructor calls it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireDeps } = require('../../lib/ipc/require-deps.js');
const { fakeIpcMain } = require('../helpers/ipc.js');

test('requireDeps — missing (undefined) field: throws with the names; null is an intentional value, passes', () => {
    assert.throws(() => requireDeps({ a: 1 }, ['a', 'b', 'c'], 'createX'), /createX: missing deps: b, c/);
    assert.throws(() => requireDeps(undefined, ['a'], 'createX'), /missing deps object/);
    assert.doesNotThrow(() => requireDeps({ a: 0, b: null, c: false }, ['a', 'b', 'c'], 'createX'));
});

test('a register*Ipc with missing deps throws ALREADY at construction (not at the first IPC call)', () => {
    const { registerWifiIpc } = require('../../lib/ipc/wifi-ipc.js');
    assert.throws(() => registerWifiIpc({ ipcMain: fakeIpcMain() }), /registerWifiIpc: missing deps: log/);
});

test('convention: every lib/ipc/* register*/create* constructor starts with requireDeps', () => {
    const dir = path.join(__dirname, '..', '..', 'lib', 'ipc');
    const missing = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'require-deps.js')) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of src.matchAll(/^function ((?:create|register)\w*)\(deps\) \{\n([\s\S]*?)^\}/gm)) {
            if (!m[2].includes(`requireDeps(deps, `) || !m[2].includes(`'${m[1]}')`)) missing.push(`${f}: ${m[1]}`);
        }
        for (const m of src.matchAll(/^function ((?:create|register)\w*)\(\{/gm)) missing.push(`${f}: ${m[1]} (parameter destructuring — \`(deps)\` + requireDeps needed)`);
    }
    assert.deepEqual(missing, []);
});
