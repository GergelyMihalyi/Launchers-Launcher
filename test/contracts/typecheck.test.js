'use strict';

// Gate of the lib/*.js `// @ts-check` layer: runs `tsc -p jsconfig.json` (no build,
// `noEmit`). If TypeScript is not installed (fresh clone before `npm install`),
// `t.skip()` — so `npm test` has no hard TS dependency.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const TSC = path.join(ROOT, 'node_modules', '.bin', 'tsc');
const JSCONFIG = path.join(ROOT, 'jsconfig.json');

test('jsconfig.json — exists, checkJs + lib/ include', () => {
    const cfg = JSON.parse(fs.readFileSync(JSCONFIG, 'utf8'));
    assert.equal(cfg.compilerOptions.checkJs, true);
    assert.equal(cfg.compilerOptions.noEmit, true);
    assert.ok(cfg.include.some((p) => p.startsWith('lib/')));
});

test('lib/*.js @ts-check clean (tsc -p jsconfig.json)', (t) => {
    if (!fs.existsSync(TSC)) {
        t.skip('typescript is not installed — run: npm install');
        return;
    }
    try {
        execFileSync(TSC, ['-p', JSCONFIG], { cwd: ROOT, stdio: 'pipe' });
    } catch (err) {
        const out = String(err.stdout || '') + String(err.stderr || '');
        assert.fail(`tsc found error(s):\n${out || err.message}`);
    }
});

// --- Renderer (jsconfig.renderer.json) ---

const JSCONFIG_RENDERER = path.join(ROOT, 'jsconfig.renderer.json');

test('renderer/**/*.js @ts-check clean (tsc -p jsconfig.renderer.json)', (t) => {
    if (!fs.existsSync(TSC)) {
        t.skip('typescript is not installed — run: npm install');
        return;
    }
    try {
        execFileSync(TSC, ['-p', JSCONFIG_RENDERER], { cwd: ROOT, stdio: 'pipe' });
    } catch (err) {
        const out = String(err.stdout || '') + String(err.stderr || '');
        assert.fail(`tsc (renderer) found error(s):\n${out || err.message}`);
    }
});

// The renderer files are scripts with a SHARED global scope: a `module.exports = …` assignment or
// a guarded `require('./x')` would make the file a module in TS's eyes (the other files would not
// see its names, the typecheck falls apart). The convention: `Object.assign(module.exports, { … })` +
// `module.require('./x')`. Checked at source level, without TypeScript too.
test('renderer: no `module.exports =` and no bare `require(` (the convention of the guards)', () => {
    const { listJsFiles } = require('../helpers/fs.js');
    const dir = path.join(ROOT, 'renderer');
    const bad = [];
    for (const rel of listJsFiles(dir)) {
        const src = fs.readFileSync(path.join(dir, rel), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/module\.exports\s*=/.test(src)) bad.push(`${rel}: module.exports =`);
        if (/(^|[^.\w])require\(/m.test(src)) bad.push(`${rel}: require(`);
    }
    assert.deepEqual(bad, [], `use: Object.assign(module.exports, {…}) / module.require(…) — ${bad.join(', ')}`);
});
