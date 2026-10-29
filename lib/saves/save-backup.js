// @ts-check
'use strict';

// Game save backup: the folders of `save-sources.js` into ONE tar archive (`launchers-launcher-saves-<date>.tar.zst`, `.tar.gz` without zstd)
// in a chosen folder (default: `~/launchers-launcher-saves`). Stores ABSOLUTE paths (relative to `/`) — restore: `tar -xf <file> -C /`. The
// latest `SAVE_BACKUP_KEEP` are kept. Atomic: writes into a `.partial` file and renames on success; GNU tar exit code 1 ("file changed as
// we read it") is NOT an error if the archive was created. Background: docs/dev/launchers/README.md

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
const { SAVE_BACKUP_TIMEOUT_MS } = require('../timings.js');

const SAVE_BACKUP_KEEP = 5;
const MANIFEST_NAME = 'launchers-launcher-saves.json';
const BACKUP_NAME_RE = /^launchers-launcher-saves-(\d{4}-\d{2}-\d{2}_\d{6})\.tar\.(zst|gz)$/;

function defaultSaveBackupDir(homeDir = os.homedir()) {
    return path.join(homeDir, 'launchers-launcher-saves');
}

// Local time, sortable: `launchers-launcher-saves-2026-09-25_140312.tar.zst`.
function backupFileName(date, compressor) {
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_`
        + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
    return `launchers-launcher-saves-${stamp}.tar.${compressor === 'zstd' ? 'zst' : 'gz'}`;
}

// The `tar` arguments: `-C /` + the paths relative to `/`, then the manifest from its own temp folder.
function tarArgs({ archivePath, compressor, paths, manifestDir }) {
    return [
        '-c', compressor === 'zstd' ? '--zstd' : '-z', '-f', archivePath,
        '-C', '/', ...paths.map((p) => path.resolve(p).replace(/^\/+/, '')),
        '-C', manifestDir, MANIFEST_NAME,
    ];
}

// The folder's `launchers-launcher-saves-*` archives, newest first. Missing folder → empty.
async function listSaveBackups(dir) {
    let names = [];
    try {
        names = await fsp.readdir(dir);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names.filter((n) => BACKUP_NAME_RE.test(n))) {
        try {
            const st = await fsp.stat(path.join(dir, name));
            if (st.isFile()) out.push({ name, path: path.join(dir, name), bytes: st.size, mtimeMs: st.mtimeMs });
        } catch { /* deleted meanwhile */ }
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
}

// Deletes the archives older than `keep` (the name is the date → sorting is chronological).
async function pruneSaveBackups(dir, keep = SAVE_BACKUP_KEEP) {
    const list = await listSaveBackups(dir);
    const removed = [];
    for (const b of list.slice(keep)) {
        try {
            await fsp.rm(b.path, { force: true });
            removed.push(b.name);
        } catch { /* best effort */ }
    }
    return removed;
}

// zstd if the `zstd` command is available (`tar --zstd` calls it), otherwise gzip. Cached.
let compressorCache = null;
async function detectCompressor(exec = execFileAsync) {
    if (compressorCache) return compressorCache;
    try {
        await exec('which', ['zstd'], { timeout: EXEC_TIMEOUT_MS });
        compressorCache = 'zstd';
    } catch {
        compressorCache = 'gzip';
    }
    return compressorCache;
}

/**
 * Creates a backup. Never throws: `{ ok: true, name, file, bytes, sources, pruned }` or `{ ok: false, error }`.
 * @param {Object} o
 * @param {string} o.destDir
 * @param {Array<{ id: string, name: string, paths: Array<{ path: string }> }>} o.sources
 * @param {'zstd'|'gzip'} o.compressor
 * @param {(cmd: string, args: string[], opts: Object) => Promise<any>} [o.exec]
 * @param {Date} [o.now]
 * @param {string} [o.version] the launcher version (into the manifest)
 * @param {number} [o.keep]
 */
async function createSaveBackup({ destDir, sources, compressor, exec = execFileAsync, now = new Date(), version = '', keep = SAVE_BACKUP_KEEP }) {
    const paths = sources.flatMap((s) => s.paths.map((p) => p.path));
    if (!paths.length) return { ok: false, error: 'no-sources' };
    const name = backupFileName(now, compressor);
    const file = path.join(destDir, name);
    const partial = path.join(destDir, `.${name}.partial`);
    let manifestDir = null;
    try {
        await fsp.mkdir(destDir, { recursive: true });
        manifestDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gl-saves-'));
        await fsp.writeFile(path.join(manifestDir, MANIFEST_NAME), `${JSON.stringify({
            createdAt: now.toISOString(),
            launcherVersion: version,
            restore: `tar -xf ${name} -C /`,
            sources: sources.map((s) => ({ id: s.id, name: s.name, paths: s.paths.map((p) => p.path) })),
        }, null, 2)}\n`);
        try {
            await exec('tar', tarArgs({ archivePath: partial, compressor, paths, manifestDir }), { timeout: SAVE_BACKUP_TIMEOUT_MS });
        } catch (err) {
            // GNU tar 1 = "file changed as we read it" — the archive was created, it is only a warning.
            if (!(err && err.code === 1 && fs.existsSync(partial))) throw err;
        }
        await fsp.rename(partial, file);
        const { size } = await fsp.stat(file);
        const pruned = await pruneSaveBackups(destDir, keep);
        return { ok: true, name, file, bytes: size, sources: sources.length, pruned };
    } catch (err) {
        await fsp.rm(partial, { force: true }).catch(() => { });
        const msg = err && (err.stderr || err.message) ? String(err.stderr || err.message).trim().split('\n').pop() : String(err);
        return { ok: false, error: msg };
    } finally {
        if (manifestDir) await fsp.rm(manifestDir, { recursive: true, force: true }).catch(() => { });
    }
}

// --- Restore ---

/** Filters the archive name to a valid name inside the folder (no path traversal). */
function isBackupName(name) {
    return typeof name === 'string' && BACKUP_NAME_RE.test(name);
}

/**
 * The archive's manifest (`launchers-launcher-saves.json`) — what it contains. Never throws: `null` on error.
 * @param {string} file @param {(cmd: string, args: string[], opts: Object) => Promise<any>} [exec]
 * @returns {Promise<{ createdAt: string, sources: Array<{ id: string, name: string, paths: string[] }> } | null>}
 */
async function readBackupManifest(file, exec = execFileAsync) {
    try {
        const { stdout } = await exec('tar', ['-xOf', file, MANIFEST_NAME], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
        const m = JSON.parse(String(stdout));
        if (!m || !Array.isArray(m.sources)) return null;
        return {
            createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
            sources: m.sources
                .filter((s) => s && typeof s.id === 'string' && Array.isArray(s.paths))
                .map((s) => ({ id: s.id, name: String(s.name || s.id), paths: s.paths.filter((p) => typeof p === 'string') })),
        };
    } catch {
        return null;
    }
}

/**
 * The paths to restore as archive member names relative to `/`: only normalized absolute paths UNDER `home` (all emulator data lives
 * there; even a hand-crafted archive must not write elsewhere).
 * @param {string[]} paths @param {string} home
 * @returns {string[]}
 */
function safeRestoreMembers(paths, home = os.homedir()) {
    const out = [];
    for (const p of paths) {
        if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p) continue;
        if (!p.startsWith(`${home}/`) || p.includes('\0')) continue;
        out.push(p.replace(/^\/+/, ''));
    }
    return out;
}

// The `tar` arguments for a restore: everything from `/`, the given members (empty = all, except the manifest). Does not restore the
// owner (`--no-same-owner`) — the user's files stay theirs.
function restoreArgs({ file, members }) {
    return ['-xf', file, '--no-same-owner', '-C', '/', ...(members.length ? members : ['--exclude', MANIFEST_NAME])];
}

/**
 * Restore from the archive. `sourceId` = one source id, or `'all'`. Never throws.
 * @param {Object} o
 * @param {string} o.file @param {string} o.sourceId
 * @param {{ sources: Array<{ id: string, paths: string[] }> }} o.manifest
 * @param {string} [o.home]
 * @param {(cmd: string, args: string[], opts: Object) => Promise<any>} [o.exec]
 * @returns {Promise<{ ok: boolean, restored?: number, error?: string }>}
 */
async function restoreSaveBackup({ file, sourceId, manifest, home = os.homedir(), exec = execFileAsync }) {
    const chosen = sourceId === 'all' ? manifest.sources : manifest.sources.filter((s) => s.id === sourceId);
    if (!chosen.length) return { ok: false, error: 'unknown-source' };
    const members = safeRestoreMembers(chosen.flatMap((s) => s.paths), home);
    if (!members.length) return { ok: false, error: 'no-safe-paths' };
    try {
        await exec('tar', restoreArgs({ file, members }), { timeout: SAVE_BACKUP_TIMEOUT_MS });
        return { ok: true, restored: chosen.length };
    } catch (err) {
        const msg = err && (err.stderr || err.message) ? String(err.stderr || err.message).trim().split('\n').pop() : String(err);
        return { ok: false, error: msg };
    }
}

module.exports = {
    isBackupName, readBackupManifest, safeRestoreMembers, restoreArgs, restoreSaveBackup,
    SAVE_BACKUP_KEEP, MANIFEST_NAME, BACKUP_NAME_RE, defaultSaveBackupDir, backupFileName, tarArgs,
    listSaveBackups, pruneSaveBackups, detectCompressor, createSaveBackup,
};
