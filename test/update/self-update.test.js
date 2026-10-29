'use strict';

// lib/update/self-update.js — the update state derived from git outputs (pure) + the
// rollback mechanism (`isValidRollbackTarget` pure, `performPendingRollback` with side
// effects — tested below with a real temp git repo + temp XDG_CONFIG_HOME).
// XDG_CONFIG_HOME is pointed at a temp directory before the `performPendingRollback` tests
// (like test/prefs.test.js) — self-update.js requires lib/config.js only AT THE MOMENT of
// the call (lazily), so it can also be set at the top of this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir, useTempConfigHome } = require('../helpers/fs.js');

const { reset } = useTempConfigHome('gl-selfupdate-cfg-');

const {
    parsePorcelainCount, touchesPackageManifest, deriveUpdateStatus,
    isValidRollbackTarget, performPendingRollback, checkForUpdate, applyUpdate, NPM_INSTALL_ARGS,
} = require('../../lib/update/self-update.js');
const config = require('../../lib/config.js');

test('parsePorcelainCount — the number of non-empty lines', () => {
    assert.equal(parsePorcelainCount(' M a.js\n?? b.js\n'), 2);
    assert.equal(parsePorcelainCount(''), 0);
    assert.equal(parsePorcelainCount('\n\n'), 0);
    assert.equal(parsePorcelainCount(null), 0);
});

test('touchesPackageManifest — package.json / package-lock.json (anywhere in the tree)', () => {
    assert.equal(touchesPackageManifest('main.js\npackage.json\n'), true);
    assert.equal(touchesPackageManifest('package-lock.json'), true);
    assert.equal(touchesPackageManifest(['sub/dir/package.json']), true);
    assert.equal(touchesPackageManifest('main.js\nlib/foo.js\n'), false);
    assert.equal(touchesPackageManifest('mypackage.json'), false); // not the manifest
    assert.equal(touchesPackageManifest(''), false);
});

test('deriveUpdateStatus — offline (the fetch failed)', () => {
    assert.deepEqual(deriveUpdateStatus({ fetchOk: false }), { state: 'offline' });
});

test('deriveUpdateStatus — dirty working tree -> the update is blocked', () => {
    const s = deriveUpdateStatus({ fetchOk: true, statusPorcelain: ' M main.js\n M lib/x.js\n', aheadCount: 3, branch: 'main' });
    assert.equal(s.state, 'dirty');
    assert.equal(s.dirtyFiles, 2);
    assert.equal(s.branch, 'main');
});

test('deriveUpdateStatus — up-to-date (ahead 0, clean tree)', () => {
    assert.equal(deriveUpdateStatus({ fetchOk: true, statusPorcelain: '', aheadCount: 0 }).state, 'up-to-date');
    assert.equal(deriveUpdateStatus({ fetchOk: true, statusPorcelain: '', revCount: '0\n' }).state, 'up-to-date');
});

test('deriveUpdateStatus — available + needsNpmInstall from a package.json change', () => {
    const s = deriveUpdateStatus({
        fetchOk: true, statusPorcelain: '', aheadCount: 5,
        changedFiles: 'README.md\npackage.json\npackage-lock.json\n', branch: 'main',
    });
    assert.equal(s.state, 'available');
    assert.equal(s.ahead, 5);
    assert.equal(s.needsNpmInstall, true);
});

test('deriveUpdateStatus — available, only code changed -> needsNpmInstall false; a string revCount is fine too', () => {
    const s = deriveUpdateStatus({ fetchOk: true, statusPorcelain: '', revCount: '2', changedFiles: 'main.js\nrenderer/x.js\n' });
    assert.equal(s.state, 'available');
    assert.equal(s.ahead, 2);
    assert.equal(s.needsNpmInstall, false);
});

test('isValidRollbackTarget — a valid full/short SHA, everything else -> false', () => {
    assert.equal(isValidRollbackTarget({ fromSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' }), true);
    assert.equal(isValidRollbackTarget({ fromSha: 'a1b2c3d' }), true); // short (7 chars) is fine too
    assert.equal(isValidRollbackTarget({ fromSha: 'A1B2C3D' }), true); // uppercase hex is fine too
    assert.equal(isValidRollbackTarget(null), false);
    assert.equal(isValidRollbackTarget(undefined), false);
    assert.equal(isValidRollbackTarget({}), false);
    assert.equal(isValidRollbackTarget({ fromSha: null }), false);
    assert.equal(isValidRollbackTarget({ fromSha: 123 }), false);
    assert.equal(isValidRollbackTarget({ fromSha: 'zzzzzzz' }), false); // not hex
    assert.equal(isValidRollbackTarget({ fromSha: 'abc12' }), false); // too short (< 7)
});

// performPendingRollback — with a real temp git repo + temp config.json.
function makeTempRepo() {
    const dir = tmpDir('gl-selfupdate-repo-');
    const git = (args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git(['init', '--quiet']);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'v1\n');
    git(['add', 'file.txt']);
    git(['commit', '--quiet', '-m', 'v1']);
    const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'v2 (broken)\n');
    git(['add', 'file.txt']);
    git(['commit', '--quiet', '-m', 'v2']);
    return { dir, firstSha };
}

test('performPendingRollback — no pendingUpdateRollback marker -> false, does not touch the repo', async () => {
    const { dir } = makeTempRepo();
    config.set('pendingUpdateRollback', null);
    const result = await performPendingRollback(dir, () => {});
    assert.equal(result, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('performPendingRollback — valid marker -> git reset --hard to the given SHA + the marker is deleted', async () => {
    const { dir, firstSha } = makeTempRepo();
    config.set('pendingUpdateRollback', { fromSha: firstSha, appliedAt: Date.now() });
    const result = await performPendingRollback(dir, () => {});
    assert.equal(result, true);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    assert.equal(head, firstSha);
    assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'v1\n');
    assert.equal(config.get('pendingUpdateRollback', 'sentinel'), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('performPendingRollback — invalid marker (wrong type/missing fromSha) -> false, the marker stays untouched', async () => {
    const { dir } = makeTempRepo();
    config.set('pendingUpdateRollback', { appliedAt: Date.now() }); // no fromSha
    const result = await performPendingRollback(dir, () => {});
    assert.equal(result, false);
    assert.deepEqual(Object.keys(config.get('pendingUpdateRollback', {})), ['appliedAt']);
    fs.rmSync(dir, { recursive: true, force: true });
});

// checkForUpdate/applyUpdate — a real origin + tracking-clone repo pair. The `work` clone tracks
// `origin` (`@{u}`), so `git fetch`/`rev-list HEAD..@{u}` see a real branch.
function makeRemoteRepoPair() {
    const base = tmpDir('gl-selfupdate-remote-');
    const originDir = path.join(base, 'origin');
    const workDir = path.join(base, 'work');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const gitIn = (dir, args) => execFileSync('git', args, { cwd: dir, env });

    fs.mkdirSync(originDir);
    gitIn(originDir, ['init', '--quiet', '-b', 'main']);
    fs.writeFileSync(path.join(originDir, 'file.txt'), 'v1\n');
    gitIn(originDir, ['add', 'file.txt']);
    gitIn(originDir, ['commit', '--quiet', '-m', 'v1']);

    gitIn(base, ['clone', '--quiet', originDir, workDir]);
    gitIn(workDir, ['config', 'user.name', 't']);
    gitIn(workDir, ['config', 'user.email', 't@t']);

    return { base, originDir, workDir, gitIn };
}

function advanceOrigin(gitIn, originDir, content) {
    fs.writeFileSync(path.join(originDir, 'file.txt'), content);
    gitIn(originDir, ['add', 'file.txt']);
    gitIn(originDir, ['commit', '--quiet', '-m', 'advance']);
}

test('checkForUpdate — fresh clone, no upstream difference -> up-to-date', async () => {
    const { base, workDir } = makeRemoteRepoPair();
    const status = await checkForUpdate(workDir, () => {});
    assert.equal(status.state, 'up-to-date');
    fs.rmSync(base, { recursive: true, force: true });
});

test('checkForUpdate — origin is ahead -> available + ahead count', async () => {
    const { base, originDir, workDir, gitIn } = makeRemoteRepoPair();
    advanceOrigin(gitIn, originDir, 'v2\n');
    const status = await checkForUpdate(workDir, () => {});
    assert.equal(status.state, 'available');
    assert.equal(status.ahead, 1);
    assert.equal(status.needsNpmInstall, false);
    fs.rmSync(base, { recursive: true, force: true });
});

test('checkForUpdate — dirty working tree -> dirty (the update is blocked)', async () => {
    const { base, workDir } = makeRemoteRepoPair();
    fs.writeFileSync(path.join(workDir, 'file.txt'), 'local change\n');
    const status = await checkForUpdate(workDir, () => {});
    assert.equal(status.state, 'dirty');
    assert.equal(status.dirtyFiles, 1);
    fs.rmSync(base, { recursive: true, force: true });
});

test('checkForUpdate — no remote/upstream -> no-upstream (not error), does not throw', async () => {
    const { dir } = makeTempRepo(); // standalone repo, no remote
    const status = await checkForUpdate(dir, () => {});
    assert.equal(status.state, 'no-upstream');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('checkForUpdate — local test branch without a tracking branch (e.g. electron-44) -> no-upstream + branch name', async () => {
    const { base, workDir, gitIn } = makeRemoteRepoPair();
    gitIn(workDir, ['checkout', '--quiet', '-b', 'electron-44']);
    const status = await checkForUpdate(workDir, () => {});
    assert.deepEqual(status, { state: 'no-upstream', branch: 'electron-44' });
    fs.rmSync(base, { recursive: true, force: true });
});

test('deriveUpdateStatus — hasUpstream:false -> no-upstream (before dirty)', () => {
    assert.deepEqual(deriveUpdateStatus({ fetchOk: true, hasUpstream: false, statusPorcelain: ' M x', branch: 'b' }),
        { state: 'no-upstream', branch: 'b' });
});

test('applyUpdate — successful fast-forward pull, package.json not affected -> ok, pendingUpdateRollback + pendingChangelog set to the SHA BEFORE/AFTER the pull', async () => {
    const { base, originDir, workDir, gitIn } = makeRemoteRepoPair();
    const beforeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir }).toString().trim();
    advanceOrigin(gitIn, originDir, 'v2\n');
    const afterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originDir }).toString().trim();

    const progressPhases = [];
    const result = await applyUpdate(workDir, { log: () => {}, onProgress: (p) => progressPhases.push(p) });

    assert.deepEqual(result, { ok: true });
    assert.equal(fs.readFileSync(path.join(workDir, 'file.txt'), 'utf8'), 'v2\n');
    assert.deepEqual(progressPhases, []); // no package.json change -> no npm-install phase
    assert.equal(config.get('pendingUpdateRollback', null).fromSha, beforeSha);
    assert.equal(config.get('pendingChangelog', null), afterSha);
    fs.rmSync(base, { recursive: true, force: true });
});

test('applyUpdate — no upstream (pull failed) -> { ok: false, message }, no config write', async () => {
    const { dir } = makeTempRepo(); // standalone repo, no upstream/@{u}
    config.set('pendingUpdateRollback', null);
    const result = await applyUpdate(dir, { log: () => {} });
    assert.equal(result.ok, false);
    assert.ok(typeof result.message === 'string' && result.message.length > 0);
    assert.equal(config.get('pendingUpdateRollback', null), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('NPM_INSTALL_ARGS — never writes the lock (--no-save), and is not `npm ci` (that would delete node_modules)', () => {
    assert.equal(NPM_INSTALL_ARGS[0], 'install');
    assert.ok(NPM_INSTALL_ARGS.includes('--no-save'));
});
