// @ts-check
'use strict';

// Safe mode: if the launcher fails to reach the "healthy" state several times in a row, the next start runs in safe mode
// (no monitor/audio switch, CEC, cache warmup, evdev — only the basic UI + a warning bar). Counting happens on the LAUNCHER side
// (not in the watcher). Manual: `LAUNCHERS_LAUNCHER_SAFE=1 npm start`. State: `startup-attempts.json` = `{ count, firstAt }`;
// a streak older than `WINDOW_MS` resets. Background: docs/dev/infrastructure.md#stability-safe-mode-fatal-errors-gpu-fallback

const fs = require('fs');
const path = require('path');
const { dataHome } = require('./xdg.js');
const { writeFileAtomic } = require('./fs-atomic.js');

const SAFE_THRESHOLD = 3;
const WINDOW_MS = 10 * 60 * 1000;
const HEALTHY_AFTER_MS = 20 * 1000;

function attemptsPath() {
    return path.join(dataHome(), 'launchers-launcher', 'startup-attempts.json');
}

// Pure decision: previous (unfinished) starts + env → safe mode now or not, and the new counter state.
// `prev` may be null / corrupt.
/**
 * @param {any} prev
 * @param {number} now
 * @param {{ threshold?: number, windowMs?: number, env?: Record<string, string|undefined> }} [opts]
 */
function nextAttempts(prev, now, { threshold = SAFE_THRESHOLD, windowMs = WINDOW_MS, env = {} } = {}) {
    const valid = prev && Number.isInteger(prev.count) && prev.count > 0
        && Number.isFinite(prev.firstAt) && now - prev.firstAt <= windowMs;
    const prevCount = valid ? prev.count : 0;
    const forced = env.LAUNCHERS_LAUNCHER_SAFE === '1';
    // A `forceNext('renderer')` mark (repeated renderer crash) shows up with its own reason — the bar then
    // says "the display crashed", not "stuck startup".
    const crashReason = valid && prev.reason === 'renderer' ? 'renderer' : 'crashes';
    return {
        safe: forced || prevCount >= threshold,
        reason: forced ? 'env' : (prevCount >= threshold ? crashReason : null),
        prevCount,
        state: { count: prevCount + 1, firstAt: valid ? prev.firstAt : now },
    };
}

// Once at startup (sync, AFTER the config init). Never throws.
function beginStartup({ now = Date.now(), env = process.env } = {}) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(attemptsPath(), 'utf8')); } catch (err) { /* none / corrupt */ }
    const r = nextAttempts(prev, now, { env });
    try { writeFileAtomic(attemptsPath(), JSON.stringify(r.state) + '\n'); } catch (err) { /* best effort */ }
    return { safe: r.safe, reason: r.reason, prevCount: r.prevCount };
}

// Healthy start / normal exit — the streak is closed. Never throws.
function markHealthy() {
    try { fs.rmSync(attemptsPath(), { force: true }); } catch (err) { /* best effort */ }
}

// The NEXT start should run in safe mode (the counter is set to the threshold). Called by the renderer
// crash guard before a relaunch: a renderer dying after 10 minutes was already a "healthy" start (the
// counter was reset), so plain counting would not catch it. Never throws.
function forceNext(reason, { now = Date.now() } = {}) {
    const state = { count: SAFE_THRESHOLD, firstAt: now, reason };
    try { writeFileAtomic(attemptsPath(), JSON.stringify(state) + '\n'); } catch (err) { /* best effort */ }
}

// --- Renderer/GPU crash guard ---
// After `render-process-gone` main reloads the page; if `RENDERER_CRASH_LIMIT` crashes arrive within
// `RENDERER_CRASH_WINDOW_MS`, it gives up (relaunch in safe mode, i.e. without GPU — with repeated crashes
// the GPU driver is the main suspect).
const RENDERER_CRASH_LIMIT = 3;
const RENDERER_CRASH_WINDOW_MS = 2 * 60 * 1000;

// Pure counter: `record(now)` → `'reload'` | `'give-up'`.
function createRendererCrashGuard({ limit = RENDERER_CRASH_LIMIT, windowMs = RENDERER_CRASH_WINDOW_MS } = {}) {
    /** @type {number[]} */
    let crashes = [];
    return {
        record(now = Date.now()) {
            crashes = crashes.filter((t) => now - t < windowMs);
            crashes.push(now);
            return crashes.length >= limit ? 'give-up' : 'reload';
        },
        count: () => crashes.length,
    };
}

module.exports = {
    beginStartup, markHealthy, forceNext, nextAttempts, attemptsPath, createRendererCrashGuard,
    SAFE_THRESHOLD, WINDOW_MS, HEALTHY_AFTER_MS, RENDERER_CRASH_LIMIT, RENDERER_CRASH_WINDOW_MS,
};
