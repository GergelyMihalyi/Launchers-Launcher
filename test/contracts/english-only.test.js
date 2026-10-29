'use strict';

// The repository is English — Hungarian lives only in the program's own UI table (renderer/i18n/i18n-hu.js). This test keeps
// it that way: no Hungarian-specific letters (ő ű Ő Ű) and none of a list of Hungarian words in any text file, except the files in
// ALLOWED (each with the reason). CLAUDE.md, the private planning-log folder and .claude/ are private working files and not scanned.
// The check is a heuristic: it cannot see Hungarian text written without those letters and words. If a new line is flagged and it is
// really a Hungarian *sample* (a locale output, a legacy log line, the HU UI table), add the file to ALLOWED with a reason — do not
// weaken the word list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

// Folders / files that are not scanned (private working files, dependencies, captured real command output).
const SKIP = new Set(['node_modules', '.git', '.claude', 'dev' + 'docs', 'CLAUDE.md', 'package-lock.json']);
const SKIP_PREFIX = ['test/fixtures/'];
// Private files that exist only in the development repository (see .public-exclude) — Hungarian is fine there, and they may be absent.
const PRIVATE_ONLY = new Set(['test/contracts/claude-md.test.js', 'tools/publish-public.sh', '.public-exclude']);
const TEXT_EXT = /\.(js|json|md|html|css|sh|service|desktop|svg|yml|yaml|d\.ts)$/;

// Deliberately Hungarian files → why.
const ALLOWED = {
    'renderer/i18n/i18n-hu.js': 'the program\'s Hungarian UI table',
    'lib/log-lines.js': 'older log lines are still classified by their Hungarian keywords',
    'lib/flatpak.js': 'recognises the error line of a Hungarian-locale flatpak',
    'lib/exec.js': 'a comment quoting the Hungarian field names of pactl',
    'renderer/games-panel/games-panel-search.js': 'a comment about ő/ű matching',
    'test/log-lines.test.js': 'legacy Hungarian log lines must keep their levels',
    'test/flatpak.test.js': 'Hungarian-locale flatpak output sample',
    'test/launch/window-to-output.test.js': 'Hungarian-locale kscreen output sample',
    'test/host-deps/format-drift.test.js': 'Hungarian-locale pactl output sample',
    'test/i18n/i18n.test.js': 'tests the Hungarian UI table itself',
    'test/e2e/harness.js': 'the e2e runs the UI in Hungarian and asserts the Hungarian labels',
    'test/games-panel/games-panel-search.test.js': 'accent folding of the Hungarian letters ő/ű',
    'test/apps/desktop-entries.test.js': 'a Name[hu] localized .desktop entry',
    'tools/new-emulator.js': 'generates an entry for the Hungarian UI table (i18n-hu.js)',
    'test/contracts/english-only.test.js': 'holds the word list',
};

const WORDS = [
    'nincs', 'nincsen', 'hiba', 'hibás', 'ismeretlen', 'sikertelen', 'érvénytelen', 'hiányzó', 'fájl', 'mappa', 'kimenet', 'mentés',
    'szöveg', 'kérés', 'ablak', 'gomb', 'kártya', 'játék', 'telepít', 'indítás', 'beállítás', 'csak', 'vagy', 'mert', 'hogy', 'után',
    'előtt', 'között', 'szerint', 'nélkül', 'helyett', 'újra', 'próba', 'törölve', 'mentve', 'felvéve', 'visszaállít',
];
const WORD_RE = new RegExp(`(?<![\\p{L}])(${WORDS.join('|')})(?![\\p{L}])`, 'iu');
const LETTER_RE = /[őűŐŰ]/;

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (SKIP_PREFIX.some((pre) => (rel + '/').startsWith(pre))) continue;
        if (e.isDirectory()) { walk(p, out); continue; }
        if (!TEXT_EXT.test(e.name) || fs.statSync(p).size > 2 * 1024 * 1024) continue;
        out.push(rel);
    }
    return out;
}

test('no Hungarian text outside the allowed files', () => {
    const hits = [];
    for (const rel of walk(root, [])) {
        if (ALLOWED[rel] || PRIVATE_ONLY.has(rel)) continue;
        fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
            if (LETTER_RE.test(line) || WORD_RE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
        });
    }
    assert.deepEqual(hits, [], `Hungarian text found (translate it, or allow the file with a reason):\n${hits.join('\n')}`);
});

test('every ALLOWED entry exists (no stale allowances)', () => {
    const missing = Object.keys(ALLOWED).filter((rel) => !fs.existsSync(path.join(root, rel)));
    assert.deepEqual(missing, [], `stale ALLOWED entries: ${missing.join(', ')}`);
});
