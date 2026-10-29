'use strict';

// Guards the public documentation, docs/dev/. The per-module details live in `docs/dev/**.md`. This test fails if:
//   - an internal docs/dev link (file or #anchor) points nowhere,
//   - a `lib/**/*.js` module is documented nowhere in docs/dev,
//   - the name of the retired planning-log folder shows up anywhere in the repo,
//   - a docs/dev page or #anchor referenced from the code does not exist.
// (The checks of the repo-root CLAUDE.md are in test/contracts/claude-md.test.js — private, CLAUDE.md is not public.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');

const root = path.join(__dirname, '..', '..');
const docsDir = path.join(root, 'docs', 'dev');

/** @param {string} dir @returns {string[]} every .md file in the folder (absolute paths) */
function mdFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? mdFiles(p) : (e.name.endsWith('.md') ? [p] : []);
    });
}
const docFiles = mdFiles(docsDir);
const docText = docFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** GitHub-style anchor slug from a heading. @param {string} h */
function slug(h) {
    return h.trim().toLowerCase().replace(/[`*]/g, '').replace(/[^\w\s-]/gu, '').replace(/ /g, '-');
}

test('the internal links of docs/dev/ (file + #anchor) are valid', () => {
    const anchors = new Map(docFiles.map((f) => [f, new Set(
        fs.readFileSync(f, 'utf8').split('\n').map((l) => l.match(/^#{1,6}\s+(.*)/)).filter(Boolean).map((m) => slug(m[1])),
    )]));
    const bad = [];
    for (const f of docFiles) {
        const text = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
        for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
            const url = m[1];
            if (/^[a-z]+:/i.test(url)) continue;
            const [rel, frag] = url.split('#');
            const target = rel ? path.normalize(path.join(path.dirname(f), rel)) : f;
            if (!fs.existsSync(target)) { bad.push(`${path.relative(root, f)} → ${url}`); continue; }
            if (frag && target.endsWith('.md') && !(anchors.get(target) || new Set()).has(frag)) {
                bad.push(`${path.relative(root, f)} → ${url} (no such heading)`);
            }
        }
    }
    assert.deepEqual(bad, [], `broken docs/dev link: ${bad.join(' | ')}`);
});

test('every lib/**/*.js module is documented in docs/dev', () => {
    const undocumented = listJsFiles(path.join(root, 'lib'))
        .map((rel) => rel.split(path.sep).join('/'))
        .filter((rel) => {
            const base = path.basename(rel);
            return !docText.includes(base);
        });
    assert.deepEqual(undocumented, [], `undocumented module(s): ${undocumented.join(', ')}`);
});

// The name of the retired planning-log folder must not appear anywhere in the source / docs.
test('no reference to the discontinued plan-log folder', () => {
    const gone = 'dev' + 'docs';
    const skip = new Set(['node_modules', '.git', gone]);
    // Files that exist only in the private repository (see .public-exclude) and name the folder on purpose.
    const privateOnly = new Set(['.public-exclude', 'tools/publish-public.sh', 'CLAUDE.md']);
    const hits = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.(js|json|md|html|css|sh|service|desktop|d\.ts)$/.test(e.name) && !e.name.startsWith('.')) continue;
            if (fs.statSync(p).size > 2 * 1024 * 1024) continue;
            if (privateOnly.has(path.relative(root, p))) continue;
            if (fs.readFileSync(p, 'utf8').includes(gone)) hits.push(path.relative(root, p));
        }
    })(root);
    assert.deepEqual(hits, [], `file(s) referencing the discontinued folder: ${hits.join(', ')}`);
});

// The `docs/dev/<page>.md[#anchor]` paths referenced in source code (comments/strings) exist, and so does the anchor.
test('the docs/dev pages and #anchors referenced from code comments exist', () => {
    const anchorsOf = (file) => new Set(fs.readFileSync(file, 'utf8').split('\n')
        .map((l) => l.match(/^#{1,6}\s+(.*)/)).filter(Boolean).map((m) => slug(m[1])));
    const skip = new Set(['node_modules', '.git', 'docs', 'img']);
    const bad = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.(js|json|html|css|sh|service|desktop|ts)$/.test(e.name) || e.name === 'docs-links.test.js' || e.name === 'new-emulator.test.js') continue;
            const src = fs.readFileSync(p, 'utf8');
            for (const m of src.matchAll(/docs\/dev\/([\w./-]+?\.md)(?:#([\w-]+))?/g)) {
                const target = path.join(docsDir, m[1]);
                if (!fs.existsSync(target)) { bad.push(`${path.relative(root, p)} → ${m[0]}`); continue; }
                if (m[2] && !anchorsOf(target).has(m[2])) bad.push(`${path.relative(root, p)} → ${m[0]} (no such heading)`);
            }
        }
    })(root);
    assert.deepEqual(bad, [], `broken docs/dev reference in the code: ${bad.join(' | ')}`);
});
