'use strict';

// share/launchers-launcher.desktop + bin/launchers-launcher-show.sh — the launcher's menu icon.
// install.sh replaces the `@REPO@` token with the repo's absolute path. Here we only check
// that the template is intact and the referenced files exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const desktop = fs.readFileSync(path.join(root, 'share', 'launchers-launcher.desktop'), 'utf8');

const kv = Object.fromEntries(
    desktop.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

test('.desktop — required keys + Type=Application', () => {
    assert.equal(kv['Type'], 'Application');
    assert.equal(kv['Name'], 'Launchers Launcher');
    assert.equal(kv['Terminal'], 'false');
    assert.match(kv['Categories'], /Game;/);
});

test('.desktop — Exec/Icon use the @REPO@ token (install.sh replaces it)', () => {
    assert.match(kv['Exec'], /^@REPO@\/bin\/launchers-launcher-show\.sh$/);
    assert.match(kv['Icon'], /^@REPO@\/assets\/logo\//);
});

test('.desktop — the referenced script + icon exist in the repo', () => {
    const script = kv['Exec'].replace('@REPO@/', '');
    const icon = kv['Icon'].replace('@REPO@/', '');
    assert.ok(fs.existsSync(path.join(root, script)), `missing: ${script}`);
    assert.ok(fs.existsSync(path.join(root, icon)), `missing: ${icon}`);
});

test('bin/launchers-launcher-show.sh — executable + messages the watcher socket', () => {
    const p = path.join(root, 'bin', 'launchers-launcher-show.sh');
    assert.ok(fs.statSync(p).mode & 0o111, 'no +x bit');
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /launchers-launcher\.sock/);
    assert.match(src, /ncat --send-only -U/);
    assert.match(src, /npm start/); // fallback / second-instance
});
