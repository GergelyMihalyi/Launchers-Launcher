'use strict';

// The single source of flatpak app IDs. An app ID is not forever (Ryujinx became
// `io.github.ryubing.Ryujinx` after a fork) — if it is spelled out in 3-5 files, a rename
// misses one, and that place silently finds nothing. The rule:
//   - the data-side source is the `flathubId` in `data/launcher-catalog.json`;
//   - in code an app ID may appear as a string literal ONLY in its own `lib/launchers/<id>-library.js`
//     `<ID>_FLATPAK_ID` constant — everyone else imports it;
//   - the constant's value matches the catalog.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');

const root = path.join(__dirname, '..', '..');
const catalog = require(path.join(root, 'data', 'launcher-catalog.json'));
const libDir = path.join(root, 'lib');
// Comments are skipped (an app ID there is documentation, not use).
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((line) => !/^\s*\/\//.test(line)).join('\n');
const sources = [
    ...listJsFiles(libDir).map((rel) => ({ rel: path.join('lib', rel).split(path.sep).join('/'), src: stripComments(fs.readFileSync(path.join(libDir, rel), 'utf8')) })),
    { rel: 'main.js', src: stripComments(fs.readFileSync(path.join(root, 'main.js'), 'utf8')) },
];

test('the flatpak app ID appears as a string literal only in its own library module constant', () => {
    const offenders = [];
    for (const entry of catalog) {
        if (!entry.flathubId) continue;
        // only '…' / "…" — a `…` (markdown code) reference is allowed in comments
        const re = new RegExp(`['"]${entry.flathubId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'g');
        const home = `lib/launchers/${entry.id}-library.js`;
        for (const { rel, src } of sources) {
            const n = (src.match(re) || []).length;
            if (!n) continue;
            if (rel === home && n === 1) continue;
            offenders.push(`${rel}: '${entry.flathubId}' ×${n}`);
        }
    }
    assert.deepEqual(offenders, [],
        `import the <ID>_FLATPAK_ID constant from lib/launchers/<id>-library.js:\n  ${offenders.join('\n  ')}`);
});

test('the <ID>_FLATPAK_ID constant of the library modules matches the catalog flathubId', () => {
    const launchersDir = path.join(libDir, 'launchers');
    let checked = 0;
    for (const file of fs.readdirSync(launchersDir).filter((f) => f.endsWith('-library.js'))) {
        const mod = require(path.join(launchersDir, file));
        const key = Object.keys(mod).find((k) => /_FLATPAK_ID$/.test(k));
        if (!key) continue;
        const id = file.replace(/-library\.js$/, '');
        const entry = catalog.find((e) => e.id === id);
        assert.ok(entry, `${file}: ${key} is present, but there is no '${id}' in data/launcher-catalog.json`);
        assert.equal(mod[key], entry.flathubId, `${file} ${key} ≠ catalog '${id}'.flathubId`);
        checked++;
    }
    assert.ok(checked >= 10, `only ${checked} library constants — was the pattern lost?`);
});
