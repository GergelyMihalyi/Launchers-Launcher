'use strict';

// Every `$('id')` / `document.getElementById('id')` literal in renderer/*.js must point to an
// existing element in index.html. A typo'd id -> silent `null` -> a runtime
// "Cannot read properties of null" on the kiosk; this test catches it at source level (like
// ipc-channels.test.js does for IPC channels). The `$` definition in `renderer/util.js` itself
// (`return document.getElementById(id)`) takes a dynamic parameter — it is skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

const rendererDir = path.join(root, 'renderer');

const files = listJsFiles(rendererDir);

test('index.html has at least a few ids', () => {
    assert.ok(htmlIds.size >= 10, `only ${htmlIds.size} ids in index.html`);
});

test('every $(\'id\') / getElementById(\'id\') literal points to an existing element', () => {
    const missing = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(rendererDir, f), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // exclude quotes in comments
        const refs = [
            ...src.matchAll(/\bgetElementById\(\s*'([^']+)'\s*\)/g),
            ...src.matchAll(/\$\(\s*'([^']+)'\s*\)/g),
        ];
        for (const m of refs) {
            // The `$` definition in util.js passes the `id` parameter on — there is no literal.
            if (!htmlIds.has(m[1])) missing.push(`${f}: $('${m[1]}')`);
        }
    }
    assert.deepEqual(missing, [], `unknown DOM id reference(s): ${missing.join(', ')}`);
});
