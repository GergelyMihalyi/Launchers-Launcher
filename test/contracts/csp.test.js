'use strict';

// CSP strictness: index.html has no inline <script>, and
// `script-src` does not ask for `'unsafe-inline'` — so injected HTML cannot run a script.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// HTML comments removed (the word "<script>" may appear in comments).
const markup = html.replace(/<!--[\s\S]*?-->/g, '');

test('there is no inline <script> in index.html (only <script src>)', () => {
    const inline = [...markup.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .filter((m) => !/\ssrc\s*=/.test(m[1] || '') || m[2].trim());
    assert.deepStrictEqual(inline.map((m) => m[0].slice(0, 60)), []);
});

test('the CSP script-src contains neither unsafe-inline nor unsafe-eval', () => {
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(markup);
    assert.ok(csp, 'no CSP <meta>');
    const scriptSrc = csp[1].split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    assert.ok(scriptSrc, 'no script-src directive');
    assert.ok(!/unsafe-(inline|eval)/.test(scriptSrc), `script-src: ${scriptSrc}`);
});

test('the boot scripts are under renderer/boot/ and exist', () => {
    const boots = [...markup.matchAll(/<script\s+src="(renderer\/boot\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(boots.length >= 2, 'the two boot scripts are missing from index.html');
    for (const rel of boots) assert.ok(fs.existsSync(path.join(root, rel)), `missing: ${rel}`);
});
