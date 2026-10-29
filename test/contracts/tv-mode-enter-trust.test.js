'use strict';

// bin/tv-mode-enter.sh — runs the sidecar's `cmd` lines (bash -lc) only from a trusted sidecar
// (owned by the user + not writable by group/others). Real script run with a
// temporary HOME (without `flatpak`/`native` lines there are no side effects; a socket send failure is only logged).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('../helpers/fs.js');

const script = path.join(__dirname, '..', '..', 'bin', 'tv-mode-enter.sh');

function run(mode) {
    const home = tmpDir('tventer-');
    fs.mkdirSync(path.join(home, '.local', 'share'), { recursive: true });
    const marker = path.join(home, 'marker');
    const sidecar = path.join(home, '.local', 'share', 'launchers-launcher-tvmode');
    fs.writeFileSync(sidecar, `cmd touch ${marker}\n`);
    fs.chmodSync(sidecar, mode);
    const res = spawnSync('bash', [script], {
        env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: home },
        encoding: 'utf8', timeout: 20000,
    });
    const log = fs.readFileSync(path.join(home, '.local', 'share', 'launchers-launcher-bt-trigger.log'), 'utf8');
    return { ran: fs.existsSync(marker), log, res };
}

test('0600 sidecar → the cmd line runs', { skip: process.platform === 'win32' }, () => {
    const r = run(0o600);
    assert.ok(r.ran, r.log);
});

test('sidecar writable by others (0666) → the cmd line is skipped', { skip: process.platform === 'win32' }, () => {
    const r = run(0o666);
    assert.ok(!r.ran, 'the cmd ran from a sidecar writable by others');
    assert.match(r.log, /not trusted/);
});
