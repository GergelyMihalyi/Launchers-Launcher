'use strict';

// Every i18n key referenced in code must exist in the `renderer/i18n/i18n-hu.js` (`I18N.hu`) table.
// On a missing key `tr()` silently prints the key itself on the UI ("toast.fooo") — this test
// catches it at source level, like dom-ids.test.js catches typo'd DOM ids.
//
// Two sources:
//   1. Every `'<prefix>.<name>'` string literal in the renderer/** + lib/** files, where
//      `<prefix>` is a known i18n key prefix (`toast`, `sv`, `err`, …) — so keys not written
//      directly into `tr()` are covered too (`labelKey: 'sv.x'`, the errorKey of the main-side
//      `rejectLaunch(..., 'err.x')`, etc.).
//   2. The dynamically built `tr('group.' + id)` / `tr('menu.' + id)` — for every id of
//      `SETTINGS_GROUPS` / `SETTINGS_MENU`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');
const { I18N } = require('../../renderer/i18n/i18n.js');

const root = path.join(__dirname, '..', '..');

// Comment-free source; a `:` before `//` excludes URLs (`https://…`).
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sources(dir) {
    const abs = path.join(root, dir);
    return listJsFiles(abs)
        .filter((rel) => !/(^|\/)i18n(-hu|-en)?\.js$/.test(rel.split(path.sep).join('/'))) // the tables + tr() itself
        .map((rel) => ({ file: `${dir}/${rel}`, src: stripComments(fs.readFileSync(path.join(abs, rel), 'utf8')) }));
}

// Plus the shared (main + renderer) files of the repo root (the `subheadKey`s of launcher-registry.js).
const shared = ['launcher-registry.js', 'controller-id.js']
    .map((rel) => ({ file: rel, src: stripComments(fs.readFileSync(path.join(root, rel), 'utf8')) }));
const files = [...sources('renderer'), ...sources('lib'), ...shared];
const keys = new Set(Object.keys(I18N.hu));
// Only "word"-like prefixes (e.g. `toast`, `sv`) — file-extension-like literals
// (`'settings.xml'`, `'games.yml'`) are dropped by the `FILE_EXT` filter.
const prefixes = [...new Set([...keys].map((k) => k.split('.')[0]))];
const FILE_EXT = /^(xml|ini|ya?ml|json|svg|png|jpe?g|webp|md|js|css|txt|dat|lpl|sh|desktop)$/i;
const keyLiteral = new RegExp(`['\`](${prefixes.join('|')})\\.([A-Za-z][A-Za-z0-9_]*)['\`]`, 'g');

test('I18N — there are at least a few prefixes and keys (the regex is not empty)', () => {
    assert.ok(prefixes.length >= 5);
    assert.ok(keys.size >= 100);
});

test('every i18n key literal exists in the hu table', () => {
    const missing = [];
    for (const { file, src } of files) {
        for (const m of src.matchAll(keyLiteral)) {
            if (FILE_EXT.test(m[2])) continue;
            const k = `${m[1]}.${m[2]}`;
            if (!keys.has(k)) missing.push(`${file}: ${k}`);
        }
    }
    assert.deepEqual(missing, [], `unknown i18n key(s): ${missing.join(', ')}`);
});

test('the key of every tr(\'…\') call exists (regardless of the prefix)', () => {
    const missing = [];
    for (const { file, src } of files) {
        for (const m of src.matchAll(/\btr\(\s*'([^'\\]+)'\s*[,)]/g)) {
            if (!keys.has(m[1])) missing.push(`${file}: ${m[1]}`);
        }
    }
    assert.deepEqual(missing, [], `unknown tr() key(s): ${missing.join(', ')}`);
});

test('the Settings categories and menu items have a group.* / menu.* key', () => {
    const src = stripComments(fs.readFileSync(path.join(root, 'renderer', 'settings', 'settings.js'), 'utf8'));
    const block = (name) => {
        const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
        assert.ok(m, `${name} not found`);
        return [...m[1].matchAll(/\{\s*id:\s*'([^']+)'/g)].map((x) => x[1]);
    };
    const missing = [
        ...block('SETTINGS_GROUPS').map((id) => `group.${id}`),
        ...block('SETTINGS_MENU').map((id) => `menu.${id}`),
        ...block('SETTINGS_MENU').map((id) => `menu.${id}.desc`),
    ].filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `missing key(s): ${missing.join(', ')}`);
});
