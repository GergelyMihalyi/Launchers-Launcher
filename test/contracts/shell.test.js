'use strict';

// Smoke test of the shell scripts:
//   - `bash -n` (syntax) on every script — always runs (bash is guaranteed).
//   - `shellcheck -S warning -x` on every script — `t.skip()` without shellcheck.
//
// Why: the bash `case` glob of `matches_connect()` in `bin/launchers-launcher-bt-trigger.sh` mirrors
// the tested contract of `lib/bluetooth/bt-trigger-parse.js`, and the sidecar format of
// `bin/tv-mode-enter.sh` mirrors `lib/sidecars/tv-mode-enter.js` — a typo in shell is otherwise silent.
// Every `bin/*.sh` + `install.sh` script in the repo is shellcheck-`warning`-clean.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const binDir = path.join(root, 'bin');

const SCRIPTS = [
    ...fs.readdirSync(binDir).filter((f) => f.endsWith('.sh')).map((f) => path.join('bin', f)),
    ...fs.readdirSync(path.join(root, '.githooks')).map((f) => path.join('.githooks', f)),
    'install.sh',
    'get-launchers-launcher.sh',
    // tools/*.sh: some exist only in the development repository (see .public-exclude)
    ...fs.readdirSync(path.join(root, 'tools')).filter((f) => f.endsWith('.sh')).map((f) => path.join('tools', f)),
].sort();

const hasShellcheck = spawnSync('shellcheck', ['--version'], { stdio: 'ignore' }).status === 0;

test('there are at least 4 shell scripts in the repo', () => {
    assert.ok(SCRIPTS.length >= 4, `only ${SCRIPTS.length} scripts`);
});

for (const rel of SCRIPTS) {
    test(`bash -n ${rel} (syntax)`, () => {
        execFileSync('bash', ['-n', path.join(root, rel)], { stdio: 'pipe' });
    });

    test(`shellcheck -S warning ${rel}`, (t) => {
        if (!hasShellcheck) {
            t.skip('shellcheck is not installed (dnf install ShellCheck / apt install shellcheck; or: npm run lint:shell)');
            return;
        }
        const res = spawnSync('shellcheck', ['-S', 'warning', '-x', path.join(root, rel)], {
            encoding: 'utf8',
        });
        assert.equal(
            res.status, 0,
            `shellcheck found a problem of warning+ level:\n${res.stdout || ''}${res.stderr || ''}`,
        );
    });
}

// Every `npm install` enables the git hooks (package.json `prepare`) — in the installer, the
// self-update and a fresh clone alike, with no manual step. A no-op outside a git repo.
test('the prepare script of package.json enables .githooks, and does not fail outside a repo either', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.prepare || '', /git config core\.hooksPath \.githooks/);
    const res = spawnSync('sh', ['-c', pkg.scripts.prepare], { cwd: require('node:os').tmpdir(), stdio: 'ignore' });
    assert.equal(res.status, 0);
});
