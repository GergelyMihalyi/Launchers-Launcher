// @ts-check
'use strict';

// Automatic GPU fallback: if Chromium's GPU process cannot start (e.g. ThinkPad T410, Intel Ironlake), we remember it
// (`gpuFallback` key) and from the NEXT start `main.js` calls `app.disableHardwareAcceleration()` up front. The record is bound to a
// "signature" (Electron version + Mesa DRI folder mtime) — after an update it is retried once. Override:
// `LAUNCHERS_LAUNCHER_DISABLE_GPU=0|1`. Background: docs/dev/infrastructure.md#stability-safe-mode-fatal-errors-gpu-fallback

const fs = require('fs');
const config = require('./config.js');

// Usual location of the Mesa DRI drivers per distro — a driver package update also changes the folder's
// mtime (files are replaced by renaming).
const DRI_DIRS = ['/usr/lib/x86_64-linux-gnu/dri', '/usr/lib64/dri', '/usr/lib/dri', '/usr/lib/aarch64-linux-gnu/dri'];

/**
 * Signature of the machine's GPU environment. Pure if the caller supplies `statFn`.
 * @param {{ electronVersion: string, driDirs?: string[], statFn?: (p: string) => { mtimeMs: number } }} o
 */
function gpuSignature({ electronVersion, driDirs = DRI_DIRS, statFn = fs.statSync }) {
    let mtime = 0;
    for (const d of driDirs) {
        try { mtime = Math.max(mtime, Math.floor(statFn(d).mtimeMs)); } catch (err) { /* no such folder */ }
    }
    return `electron ${electronVersion} · dri ${mtime}`;
}

/**
 * The startup decision (BEFORE `whenReady`). `env` = the value of `LAUNCHERS_LAUNCHER_DISABLE_GPU`.
 * @param {{ stored: any, signature: string, env?: string }} o
 * @returns {{ disable: boolean, reason: 'env'|'auto'|null, clear: boolean }}
 *   `clear`: the record is stale (different signature) or overridden by the user (`env === '0'`) → delete it.
 */
function decideGpu({ stored, signature, env }) {
    if (env === '1') return { disable: true, reason: 'env', clear: false };
    const has = !!(stored && typeof stored === 'object' && typeof stored.signature === 'string');
    if (env === '0') return { disable: false, reason: null, clear: has };
    if (has && stored.signature === signature) return { disable: true, reason: 'auto', clear: false };
    return { disable: false, reason: null, clear: has };
}

// GPU compositing status after the renderer has loaded: anything other than `enabled…` means the GPU did
// not start (or is blocklisted) — Chromium draws in software.
/** @param {any} status `app.getGPUFeatureStatus().gpu_compositing` */
function gpuFailed(status) {
    return typeof status === 'string' && !status.startsWith('enabled');
}

function readGpuFallback() {
    const v = config.get('gpuFallback', null);
    return v && typeof v === 'object' ? v : null;
}

/** @param {string} signature @param {string} status */
function recordGpuFallback(signature, status) {
    config.set('gpuFallback', { signature, status, at: new Date().toISOString() });
}

function clearGpuFallback() {
    config.set('gpuFallback', null);
}

/**
 * The startup GPU decision with its log line (BEFORE `whenReady`; the caller calls
 * `app.disableHardwareAcceleration()` when `disabled`). Always off in safe mode. Deletes a stale record.
 * `reason`: `'safe'` / `'env'` / `'auto'` / `null` — the `gpuReason` of Diagnostics.
 * @param {{ safe: boolean, electronVersion: string, env?: string, log: (msg: string) => void }} o
 * @returns {{ disabled: boolean, reason: 'safe'|'env'|'auto'|null, signature: string }}
 */
function decideAtStartup({ safe, electronVersion, env = process.env.LAUNCHERS_LAUNCHER_DISABLE_GPU, log }) {
    const signature = gpuSignature({ electronVersion });
    const d = decideGpu({ stored: readGpuFallback(), signature, env });
    if (d.clear) clearGpuFallback();
    const disabled = safe || d.disable;
    if (disabled) {
        const why = safe ? 'safe mode'
            : d.reason === 'auto' ? 'automatic: the GPU failed to start on this machine at an earlier start'
                : 'LAUNCHERS_LAUNCHER_DISABLE_GPU=1';
        log(`GPU acceleration OFF (${why}) — software rendering`);
    } else if (d.clear) {
        log('[gpu] the recorded GPU failure is stale (Electron/driver update or manual override) — trying the GPU again');
    }
    return { disabled, reason: safe ? 'safe' : d.reason, signature };
}

/**
 * After the renderer has loaded: if we tried the GPU but Chromium fell back to software rendering,
 * record it → skipped up front from the NEXT start. `true` = recorded now.
 * @param {{ decision: { disabled: boolean, signature: string }, status: any, log: { warn: (msg: string) => void } }} o
 */
function checkAfterLoad({ decision, status, log }) {
    if (decision.disabled || !gpuFailed(status)) return false;
    recordGpuFallback(decision.signature, status);
    log.warn(`[gpu] GPU acceleration did not start (${status}) — software rendering from the next start on (${decision.signature})`);
    return true;
}

module.exports = {
    DRI_DIRS, gpuSignature, decideGpu, gpuFailed, readGpuFallback, recordGpuFallback, clearGpuFallback,
    decideAtStartup, checkAfterLoad,
};
