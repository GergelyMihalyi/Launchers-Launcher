'use strict';

// install.sh — portable smoke test: argument handling + `--help`. The `bash -n` syntax check
// + `shellcheck` are in `test/contracts/shell.test.js` (every `bin/*.sh` + `install.sh`). A real
// `--dry-run` run is machine-dependent (prerequisite checks), that must be checked by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { tmpDir, writeFile } = require('../helpers/fs.js');

const SCRIPT = path.join(__dirname, '..', '..', 'install.sh');

test('install.sh — exists and is executable', () => {
    const st = fs.statSync(SCRIPT);
    assert.ok(st.mode & 0o111, 'no +x bit');
});

test('install.sh --help — exits with 0, lists the 3 modes', () => {
    const out = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.match(out, /--dry-run/);
    assert.match(out, /--uninstall/);
    assert.match(out, /--help/);
});

test('install.sh --bogus — non-zero exit code for an unknown option', () => {
    assert.throws(() => execFileSync('bash', [SCRIPT, '--bogus'], { stdio: 'pipe' }));
});

test('install.sh --help — the package install options (--yes / --no-packages)', () => {
    const out = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.match(out, /--yes/);
    assert.match(out, /--no-packages/);
});

// The full `--dry-run` path with a narrowed PATH (no node / pactl / kscreen-doctor …) and a
// fake Debian os-release: the missing ones collect into ONE apt-get command, and Node goes to
// the per-user download. do_install expects the repo under $HOME/launchers-launcher → a TEMPORARY
// HOME with a `launchers-launcher` → repo symlink in it. (The real home would break the test on a
// machine that already has a per-user Node — `~/.local/share/launchers-launcher/node` — since the
// "download Node" branch would not run.)
const repoDir = path.join(__dirname, '..', '..');

function fakeHome() {
    const home = tmpDir('install-sh-home-');
    fs.symlinkSync(repoDir, path.join(home, 'launchers-launcher'));
    return home;
}

function fakeBin(tools, extra = {}) {
    const dir = tmpDir('install-sh-bin-');
    for (const t of tools) {
        const real = execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
        fs.symlinkSync(real, path.join(dir, t));
    }
    for (const [name, body] of Object.entries(extra)) {
        fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    return dir;
}

function dryRun(args, osRelease, extra) {
    const bin = fakeBin(['bash', 'dirname', 'readlink', 'sed', 'sort', 'head', 'uname', 'grep', 'tr', 'id', 'cat'], extra);
    const etc = tmpDir('install-sh-etc-');
    writeFile(etc, 'os-release', osRelease);
    return execFileSync(path.join(bin, 'bash'), [SCRIPT, '--dry-run', ...args], {
        encoding: 'utf8',
        env: {
            HOME: fakeHome(), PATH: bin, USER: 'tester',
            LAUNCHERS_LAUNCHER_OS_RELEASE: path.join(etc, 'os-release'),
        },
    });
}

test('install.sh --dry-run (Debian, empty machine) — one apt-get install + a user-level Node', () => {
    const out = dryRun([], 'ID=debian\nVERSION_ID="13"\n', { 'apt-get': 'exit 0' });
    const install = out.split('\n').find((l) => l.includes('+ sudo apt-get install -y'));
    assert.ok(install, out);
    for (const pkg of ['libkscreen-bin', 'pulseaudio-utils', 'bluez', 'libglib2.0-bin', 'git', 'curl', 'xz-utils', 'ncat', 'flatpak', 'zstd']) {
        assert.ok(install.split(' ').includes(pkg), `missing ${pkg}: ${install}`);
    }
    assert.ok(!install.includes('nodejs'), 'Node does NOT come from the distro package');
    assert.match(out, /\+ sudo apt-get update/);
    assert.match(out, /latest-v22\.x\/SHASUMS256\.txt/);
    assert.match(out, /\+ npm --prefix .* install/);
});

test('install.sh --dry-run --no-packages — only prints the missing ones', () => {
    const out = dryRun(['--no-packages'], 'ID=debian\n', { 'apt-get': 'exit 0' });
    assert.match(out, /--no-packages — install them by hand/);
    assert.doesNotMatch(out, /apt-get install/);
});

test('install.sh --dry-run — does not install a package on an unknown distro', () => {
    const out = dryRun([], 'ID=gentoo\n');
    assert.match(out, /distro: gentoo\) — install by hand: .*kscreen-doctor/);
    assert.doesNotMatch(out, /(apt-get|dnf|pacman) install/);
});
