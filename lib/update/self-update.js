// @ts-check
'use strict';

// Self-update: a state for renderer/settings/settings-update.js from the output of `git fetch` + `git status`/`rev-list`/`diff`. No
// `electron` reference. Side-effecting exports: `checkForUpdate` (body of `check-update`), `applyUpdate` (body of `apply-update`, with the
// rollback/changelog config markers) and `performPendingRollback` (the recovery path of `bootstrap.js`); `app.relaunch()`/`app.exit()` stay
// in `main.js`. Background: docs/dev/install-update.md#self-update-and-rollback

// Side-effect free (constants only) — does not burden the early require of `bootstrap.js`.
const { GIT_FETCH_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS, GIT_RESET_TIMEOUT_MS } = require('../timings.js');

// Number of non-empty lines of `git status --porcelain` (for the "how many files are dirty" signal).
function parsePorcelainCount(text) {
    if (typeof text !== 'string') return 0;
    return text.split('\n').filter((l) => l.trim() !== '').length;
}

// Decides from the incoming file list whether `npm install` is needed after the update (`package.json` or `package-lock.json` changed in
// the HEAD..upstream range).
function touchesPackageManifest(changedFiles) {
    const list = Array.isArray(changedFiles)
        ? changedFiles
        : (typeof changedFiles === 'string' ? changedFiles.split('\n') : []);
    return list.some((f) => /(^|\/)package(-lock)?\.json$/.test(String(f).trim()));
}

// From the raw git outputs -> { state, ... }. `state`:
//   'offline'     — `git fetch` failed (no network / auth error)
//   'dirty'       — the working tree is dirty -> the update is BLOCKED (the pull must not break halfway)
//   'up-to-date'  — HEAD == upstream
//   'available'   — there are N new commits (ahead) — `apply-update` on X
//   'no-upstream' — the current branch has no remote tracking branch (e.g. a local test branch) → nothing to update to; not an error
// `raw`: { fetchOk, hasUpstream, statusPorcelain, aheadCount|revCount, changedFiles, branch }
function deriveUpdateStatus(raw) {
    const r = raw || {};
    if (r.fetchOk === false) return { state: 'offline' };
    if (r.hasUpstream === false) return { state: 'no-upstream', branch: r.branch };

    const dirty = typeof r.statusPorcelain === 'string' && r.statusPorcelain.trim() !== '';
    if (dirty) {
        return { state: 'dirty', dirtyFiles: parsePorcelainCount(r.statusPorcelain), branch: r.branch };
    }

    const ahead = Number.isInteger(r.aheadCount)
        ? r.aheadCount
        : (parseInt(r.revCount, 10) || 0);
    if (ahead <= 0) return { state: 'up-to-date', branch: r.branch };

    return {
        state: 'available',
        ahead,
        needsNpmInstall: touchesPackageManifest(r.changedFiles),
        branch: r.branch,
    };
}

// Validity of the `pendingUpdateRollback` config key (`{ fromSha, appliedAt }`) — only a hex SHA is accepted (7-40 characters, short or
// full), so a hand-broken or incomplete marker never starts a `git reset --hard`.
function isValidRollbackTarget(pending) {
    return !!pending && typeof pending.fromSha === 'string' && /^[0-9a-f]{7,40}$/i.test(pending.fromSha);
}

// Actually performs the self-update rollback: if there is a valid `pendingUpdateRollback` marker, `git reset --hard <fromSha>` restores the
// repo to the commit BEFORE the update and clears the marker. Called from `bootstrap.js` (when `require('./main.js')` or a startup
// uncaughtException/unhandledRejection signals that the new code does not start properly). `false` = no (valid) marker, nothing to do.
// An error in `git reset` -> the marker STAYS, and the caller does NOT relaunch into a still broken state.
async function performPendingRollback(repoRoot, log) {
    const config = require('../config.js');
    const { execFileAsync } = require('../exec.js');
    const pending = config.get('pendingUpdateRollback', null);
    if (!isValidRollbackTarget(pending)) return false;
    try {
        await execFileAsync('git', ['reset', '--hard', pending.fromSha], { cwd: repoRoot, timeout: GIT_RESET_TIMEOUT_MS });
    } catch (err) {
        if (log) log(`performPendingRollback: git reset --hard error: ${err.message}`);
        throw err;
    }
    config.set('pendingUpdateRollback', null);
    if (log) log(`performPendingRollback: restored to ${pending.fromSha}`);
    return true;
}

// The npm call of `apply-update`. `--no-save`: NEVER writes `package-lock.json` (or `package.json`) — if the machine's npm serialized the
// lock differently, the repo would be dirty, and from then on EVERY update would silently stop in the `dirty` state.
// Deliberately NOT `npm ci`: that first deletes the whole `node_modules`, so after an offline / interrupted run the next start would have
// nothing left (`install` is incremental, on error the old tree mostly stays intact).
const NPM_INSTALL_ARGS = ['install', '--no-save', '--no-audit', '--no-fund'];

// `git` runs at the repo root (`repoRoot`). `check-update` is NOT automatic at startup — only when entering the subview (a network call;
// the launcher is otherwise offline-tolerant). `git fetch`/`pull` are network-bound (longer than EXEC_TIMEOUT_MS); npm install may also
// download the ~280 MB binary on an electron version change, hence generous — values in lib/timings.js.

// Body of the `check-update` (invoke) handler: `git fetch` + `status`/`rev-list`/`branch` → `deriveUpdateStatus`. `log` is optional
// (for error logging, the format is up to the caller).
async function checkForUpdate(repoRoot, log) {
    const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
    const gitInRepo = (args, timeout = EXEC_TIMEOUT_MS) =>
        execFileAsync('git', args, { cwd: repoRoot, timeout });
    const logFn = log || (() => {});

    try {
        await gitInRepo(['fetch', '--quiet'], GIT_FETCH_TIMEOUT_MS);
    } catch (err) {
        logFn(`check-update: git fetch error: ${err.message}`);
        return deriveUpdateStatus({ fetchOk: false });
    }
    let branchName = '';
    try {
        branchName = (await gitInRepo(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
        await gitInRepo(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch (err) {
        logFn(`check-update: no upstream (${branchName || '?'}) — nothing to update to`);
        return deriveUpdateStatus({ fetchOk: true, hasUpstream: false, branch: branchName });
    }
    try {
        const [{ stdout: status }, { stdout: rev }, { stdout: branch }] = await Promise.all([
            gitInRepo(['status', '--porcelain']),
            gitInRepo(['rev-list', '--count', 'HEAD..@{u}']),
            gitInRepo(['rev-parse', '--abbrev-ref', 'HEAD']),
        ]);
        const aheadCount = parseInt(rev.trim(), 10) || 0;
        let changedFiles = '';
        if (aheadCount > 0) {
            try {
                changedFiles = (await gitInRepo(['diff', '--name-only', 'HEAD..@{u}'])).stdout;
            } catch (err) { /* best effort — needsNpmInstall stays false */ }
        }
        return deriveUpdateStatus({
            fetchOk: true, statusPorcelain: status, aheadCount, changedFiles, branch: branch.trim(),
        });
    } catch (err) {
        logFn(`check-update error: ${err.message}`);
        return { state: 'error', message: err.message };
    }
}

// Body of the `apply-update` handler: `git pull --ff-only`, then `npm install` if `package.json`/`package-lock.json` changed too. The HEAD SHA
// from BEFORE the pull is saved as the `pendingUpdateRollback` marker (if the new code crashes at startup, `performPendingRollback` of
// `bootstrap.js` restores it). `{ ok: true }` → the caller calls `app.relaunch()`; `{ ok: false, message }` → `update-failed`, NO relaunch.
// `onProgress('npm-install')` at the start of the `npm install` phase. Background: docs/dev/install-update.md#self-update-and-rollback
/**
 * @param {string} repoRoot
 * @param {{ log?: import('../types.js').Logger, onProgress?: (phase: string) => void }} [opts]
 */
async function applyUpdate(repoRoot, { log, onProgress } = {}) {
    const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
    const config = require('../config.js');
    const gitInRepo = (args, timeout = EXEC_TIMEOUT_MS) =>
        execFileAsync('git', args, { cwd: repoRoot, timeout });
    const logFn = log || (() => {});

    let beforeSha;
    try {
        beforeSha = (await gitInRepo(['rev-parse', 'HEAD'])).stdout.trim();
    } catch (err) {
        logFn(`apply-update: cannot read the HEAD sha (before the pull): ${err.message}`);
        return { ok: false, message: err.message };
    }
    try {
        logFn('apply-update: git pull --ff-only');
        await gitInRepo(['pull', '--ff-only', '--quiet'], GIT_FETCH_TIMEOUT_MS);
    } catch (err) {
        logFn(`apply-update error (pull): ${err.message}`);
        return { ok: false, message: err.message };
    }

    let changedFiles = '';
    try {
        changedFiles = (await gitInRepo(['diff', '--name-only', beforeSha, 'HEAD'])).stdout;
    } catch (err) { logFn(`apply-update: changed-files diff error (best effort): ${err.message}`); }

    if (touchesPackageManifest(changedFiles)) {
        if (onProgress) onProgress('npm-install');
        try {
            logFn('apply-update: npm install (package.json/package-lock.json touched)');
            // The CURRENTLY RUNNING process has already loaded its node_modules into memory — a parallel npm install on disk is safe (on Linux the inode
            // of a deleted/overwritten file still held open/mapped by the running process stays alive, which also holds for replacing the
            // node_modules/electron binary); only the NEXT (post-relaunch) start sees the new node_modules.
            await execFileAsync('npm', NPM_INSTALL_ARGS,
                { cwd: repoRoot, timeout: NPM_INSTALL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
        } catch (err) {
            logFn(`apply-update: npm install error, git reset to ${beforeSha}: ${err.message}`);
            // git reset restores the TRACKED files — node_modules/ itself is gitignored, git does NOT repair it. The RUNNING instance stays fine (it
            // is already in memory), only a FUTURE start could find a broken node_modules — so we do NOT relaunch on this branch.
            try {
                await gitInRepo(['reset', '--hard', beforeSha]);
            } catch (resetErr) {
                logFn(`apply-update: git reset --hard error (after npm install): ${resetErr.message}`);
            }
            return { ok: false, message: `npm install: ${err.message}` };
        }
    }

    config.set('pendingUpdateRollback', { fromSha: beforeSha, appliedAt: Date.now() });
    // Marker for the next start: the "What's new" panel from the top of CHANGELOG.md.
    try {
        const { stdout: head } = await gitInRepo(['rev-parse', 'HEAD']);
        config.set('pendingChangelog', head.trim());
    } catch (err) { logFn(`apply-update: cannot read the HEAD sha (changelog): ${err.message}`); }

    return { ok: true };
}

module.exports = {
    parsePorcelainCount, touchesPackageManifest, deriveUpdateStatus,
    isValidRollbackTarget, performPendingRollback, checkForUpdate, applyUpdate, NPM_INSTALL_ARGS,
};
