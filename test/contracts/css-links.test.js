'use strict';

// The base styles live in the `styles/NN-*.css` files. Cascade order matters: the files load in
// index.html in NUMERIC ORDER, exactly once. A new stylesheet: numbered for its place
// (by cascade position) + one <link> in index.html.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const stylesDir = path.join(root, 'styles');
const files = fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css')).sort();
const linked = [...html.matchAll(/<link rel="stylesheet" href="styles\/([^"]+)">/g)].map((m) => m[1]);

test('every styles/*.css is of the form NN-name.css (the number is the cascade position)', () => {
    assert.ok(files.length >= 5);
    for (const f of files) assert.match(f, /^\d{2}-[a-z0-9-]+\.css$/, f);
});

test('index.html links every styles/*.css exactly once, in NUMERIC ORDER', () => {
    assert.deepEqual(linked, files);
});

test('there is no old root styles.css and no <link> to it', () => {
    assert.equal(fs.existsSync(path.join(root, 'styles.css')), false);
    assert.doesNotMatch(html, /href="styles\.css"/);
});

test('the relative url()s of styles/ point to an existing file relative to the repo root (with a ../ prefix)', () => {
    const bad = [];
    for (const f of files) {
        const css = fs.readFileSync(path.join(stylesDir, f), 'utf8');
        for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
            const u = m[1];
            if (/^(https?:|data:|#)/.test(u)) continue;
            if (!fs.existsSync(path.join(stylesDir, u))) bad.push(`${f}: ${u}`);
        }
    }
    assert.deepEqual(bad, [], `broken relative url(): ${bad.join(', ')}`);
});

test('@import only at the very start of the very first file (otherwise the browser drops it)', () => {
    for (const f of files) {
        const css = fs.readFileSync(path.join(stylesDir, f), 'utf8');
        const idx = css.indexOf('@import');
        if (idx === -1) continue;
        assert.equal(f, files[0], `@import is only allowed in ${files[0]}`);
        assert.equal(idx, 0, `${f}: the @import must be at the very start of the file`);
    }
});
