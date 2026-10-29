// @ts-check
'use strict';

// Warms the TTL caches of the Games panel's sources at startup / on return from a game. The module only provides the ORDER, fault
// tolerance, reentrancy and state reporting; the caller supplies the queries as `steps` (the same thunks as `GAME_LOADERS`).
// A `gapMs` pause between synchronous steps (the IPC queue can drain); async steps start FIRST and are awaited at the end.
// Background: docs/dev/games-panel.md#warm-up-and-caches

const { withTimeout } = require('../exec.js');
const { GAMES_WARMUP_STEP_TIMEOUT_MS } = require('../timings.js');

/**
 * @typedef {Object} WarmupStep
 * @property {string} id
 * @property {() => any} run                 the `*Cached` call (with the same arguments as its handler)
 * @property {() => void} [invalidate]       clears the cache (only if the run invalidates this step)
 * @property {boolean} [async]               non-blocking (CLI) step — starts first, awaited at the end
 */

/**
 * @typedef {Object} WarmupState
 * @property {boolean} running
 * @property {number} done
 * @property {number} total
 */

/**
 * @param {Object} deps
 * @param {WarmupStep[]} deps.steps
 * @param {import('../types.js').Logger} [deps.log]
 * @param {(state: WarmupState) => void} [deps.onState]
 * @param {number} [deps.gapMs]                                pause between two synchronous steps
 * @param {(ms: number) => Promise<void>} [deps.sleep]          overridable for tests
 * @param {() => number} [deps.now]                             overridable for tests
 * @param {number} [deps.stepTimeoutMs]                         upper bound of one step (overridable for tests)
 */
function createGamesWarmup({
    steps, log = () => {}, onState = () => {}, gapMs = 40,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => performance.now(), // monotonic (only for the logged step times)
    stepTimeoutMs = GAMES_WARMUP_STEP_TIMEOUT_MS,
}) {
    // A programming error (e.g. a step given with another key instead of `run`) should fail at construction, not silently as per-step log
    // lines when the warmup runs.
    for (const step of steps) {
        if (!step || typeof step.id !== 'string' || typeof step.run !== 'function') {
            throw new TypeError(`createGamesWarmup: invalid step (${step && step.id}) — { id, run } required`);
        }
    }
    const total = steps.length;
    /** @type {WarmupState} */
    let state = { running: false, done: 0, total };
    /** @type {Promise<void> | null} */
    let current = null;
    /**
     * An invalidating request arrived while running → one more round at the end. `null` = none;
     * `true` = every step; `Set` = only these ids.
     * @type {true | Set<string> | null}
     */
    let pendingInvalidate = null;

    // Normalizes the `invalidate` option: `true` = every step, array/Set = only these ids, anything else (false/undefined/empty) = none.
    /** @returns {true | Set<string> | null} */
    function normInvalidate(v) {
        if (v === true) return true;
        if (v && typeof v[Symbol.iterator] === 'function') {
            const set = new Set(v);
            return set.size ? set : null;
        }
        return null;
    }

    // Union of two pending invalidations (`true` swallows everything).
    function mergeInvalidate(a, b) {
        if (a === true || b === true) return true;
        if (!a) return b;
        if (!b) return a;
        return new Set([...a, ...b]);
    }

    /** @param {WarmupState} next */
    function setState(next) {
        state = next;
        try { onState({ ...state }); } catch (err) { /* a reporting error must not stop the warmup */ }
    }

    /**
     * One step: (optional) invalidate + run in the same tick — there is no window where the cache is empty but the warmup has not
     * reached it yet. The `run()` of a non-invalidated step is cheap if the cache is still fresh (within TTL), it only rewarms an
     * expired cache.
     * @param {WarmupStep} step
     * @param {boolean} invalidate
     * @param {string[]} timings
     */
    async function runStep(step, invalidate, timings) {
        const t0 = now();
        try {
            if (invalidate && typeof step.invalidate === 'function') step.invalidate();
            // Timeout: a stuck step must not hold up the end of the warmup — the manual "Refresh" and the `warmupDone` timeline point wait for it.
            await withTimeout(Promise.resolve().then(() => step.run()), stepTimeoutMs, `[warmup] ${step.id}`);
        } catch (err) {
            log(`[warmup] ${step.id} error: ${err && err.message}`);
        }
        timings.push(`${step.id} ${now() - t0}ms`);
        setState({ ...state, done: state.done + 1 });
    }

    /** @param {string} reason @param {true | Set<string> | null} invalidate */
    async function runOnce(reason, invalidate) {
        const t0 = now();
        /** @type {string[]} */
        const timings = [];
        const inv = (/** @type {WarmupStep} */ s) => invalidate === true || (!!invalidate && invalidate.has(s.id));
        setState({ running: true, done: 0, total });
        const asyncSteps = steps.filter((s) => s.async);
        const syncSteps = steps.filter((s) => !s.async);
        const asyncRuns = asyncSteps.map((s) => runStep(s, inv(s), timings));
        for (let i = 0; i < syncSteps.length; i++) {
            if (i > 0 && gapMs > 0) await sleep(gapMs);
            await runStep(syncSteps[i], inv(syncSteps[i]), timings);
        }
        await Promise.all(asyncRuns); // a runStep sosem dob
        setState({ running: false, done: total, total });
        log(`[warmup] ${reason}: ${timings.join(', ')} — total ${now() - t0}ms`);
    }

    /**
     * Starts the warmup. No parallel run while one is running: a plain call returns the running Promise, an invalidating request
     * schedules an extra round at the end (the extra rounds' invalidations add up). The returned Promise resolves together with the
     * extra rounds. Never throws. `invalidate`: `true` = clears every step's cache (manual "Refresh"); id array/Set = only these (return
     * from a game — the other steps only rewarm an expired cache).
     * @param {string} [reason]
     * @param {{ invalidate?: boolean | Iterable<string> }} [opts]
     * @returns {Promise<void>}
     */
    function run(reason = 'manual', { invalidate = false } = {}) {
        const inv = normInvalidate(invalidate);
        if (current) {
            if (inv) pendingInvalidate = mergeInvalidate(pendingInvalidate, inv);
            return current;
        }
        current = (async () => {
            try {
                await runOnce(reason, inv);
                while (pendingInvalidate) {
                    const next = pendingInvalidate;
                    pendingInvalidate = null;
                    await runOnce(`${reason}+`, next);
                }
            } catch (err) {
                log(`[warmup] unexpected error: ${err && err.message}`);
                setState({ running: false, done: state.done, total });
            } finally {
                current = null;
            }
        })();
        return current;
    }

    return { run, getState: () => ({ ...state }) };
}

module.exports = { createGamesWarmup };
