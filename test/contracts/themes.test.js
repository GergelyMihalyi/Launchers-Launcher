'use strict';

// Theme manifest <-> themes/*.css consistency — `node --test`, zero dependencies.
// This catches the "forgotten entry" class of bug: themes/themes.json is the ONLY
// source (main.js THEMES whitelist, renderer THEMES + <link> injection all come from it), so
// if a theme CSS or a field is missing, it fails here, not silently on the kiosk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'themes/themes.json'), 'utf8'));
const HEX = /^#[0-9a-fA-F]{6}$/;

test('themes.json — an array, every entry a valid id + label + 3-hex swatch', () => {
    assert.ok(Array.isArray(manifest) && manifest.length > 0, 'not an empty array');
    for (const t of manifest) {
        assert.equal(typeof t.id, 'string', `${t.id}: id string`);
        assert.ok(t.id.length, 'id not empty');
        assert.equal(typeof t.label, 'string', `${t.id}: label string`);
        assert.ok(t.label.length, `${t.id}: label not empty`);
        assert.ok(Array.isArray(t.swatch) && t.swatch.length === 3, `${t.id}: swatch = 3 elements`);
        for (const c of t.swatch) assert.match(c, HEX, `${t.id}: invalid swatch hex: ${c}`);
        if ('motion' in t) assert.equal(t.motion, 'off', `${t.id}: motion can only be "off"`);
    }
});

test('themes.json — unique ids, "neon" is included', () => {
    const ids = manifest.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id: ${ids}`);
    assert.ok(ids.includes('neon'), 'the "neon" base theme must be in the manifest');
});

test('neon has no separate CSS file (styles/*.css is the base itself)', () => {
    assert.ok(
        !fs.existsSync(path.join(root, 'themes/neon.css')),
        'there must be no themes/neon.css — the <link> injection skips it with the id==="neon" exception',
    );
});

test('every non-neon theme has a themes/<id>.css, with only its own :root[data-theme], balanced {}', () => {
    for (const t of manifest) {
        if (t.id === 'neon') continue;
        const p = path.join(root, 'themes', `${t.id}.css`);
        assert.ok(fs.existsSync(p), `missing theme CSS: themes/${t.id}.css`);
        const css = fs.readFileSync(p, 'utf8');

        const selectors = [...css.matchAll(/:root\[data-theme="([^"]+)"\]/g)].map((m) => m[1]);
        assert.ok(selectors.length > 0, `themes/${t.id}.css: no :root[data-theme] scope`);
        for (const s of selectors) {
            assert.equal(s, t.id, `themes/${t.id}.css contains a foreign data-theme selector: "${s}"`);
        }

        const opens = (css.match(/\{/g) || []).length;
        const closes = (css.match(/\}/g) || []).length;
        assert.equal(opens, closes, `themes/${t.id}.css: unbalanced curly braces (${opens} open / ${closes} close)`);
    }
});

test('lib/prefs.js derives the theme whitelist from the manifest (no hardcoded array)', () => {
    const prefsSrc = fs.readFileSync(path.join(root, 'lib/prefs.js'), 'utf8');
    assert.match(prefsSrc, /require\('\.\.\/themes\/themes\.json'\)/, 'lib/prefs.js requires the manifest');
    assert.match(prefsSrc, /themeManifest\.map\(/, 'THEME_IDS is mapped from the manifest');
    assert.doesNotMatch(
        prefsSrc,
        /THEME_IDS = \[\s*['"]neon['"]/,
        'there must be no hardcoded theme list in lib/prefs.js',
    );
});

test('the theme / feedback config logic is in lib/prefs.js (not in main.js)', () => {
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(mainSrc, /require\('\.\/lib\/prefs\.js'\)/, 'main.js uses lib/prefs.js');
    assert.doesNotMatch(mainSrc, /function (read|write)ThemeConfig/, 'the theme config is not in main.js');
    assert.doesNotMatch(mainSrc, /function (read|write)FeedbackConfig/, 'the feedback config is not in main.js');
});
