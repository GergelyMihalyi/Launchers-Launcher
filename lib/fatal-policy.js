// @ts-check
'use strict';

// When is an uncaught main-process error fatal? (asked by `bootstrap.js`) `uncaughtException` is ALWAYS fatal; `unhandledRejection`
// only within the STARTUP window (renderer's first load + grace period: the self-update rollback makes sense there), after that only
// log + counter (Diagnostics "Version"). Module-level instance `fatalPolicy` (bootstrap + diagnostics-ipc see the same one).

/**
 * @param {Object} [opts]
 * @param {(fn: () => void, ms: number) => any} [opts.schedule] timer, overridable for tests
 */
function createFatalPolicy({ schedule = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
} } = {}) {
    let settled = false;
    let nonFatal = 0;
    /** @type {string | null} */
    let last = null;

    return {
        /** Startup is over (the renderer has loaded) → after `graceMs` rejections are no longer fatal. */
        settleAfter(/** @type {number} */ graceMs) {
            schedule(() => { settled = true; }, graceMs);
        },
        isSettled: () => settled,
        /**
         * @param {'uncaughtException' | 'unhandledRejection' | string} source
         * @returns {boolean}
         */
        isFatal(source) {
            return source !== 'unhandledRejection' || !settled;
        },
        /** @param {unknown} reason */
        noteNonFatal(reason) {
            nonFatal++;
            last = String((reason && /** @type {any} */ (reason).message) || reason).slice(0, 300);
        },
        stats: () => ({ count: nonFatal, last }),
    };
}

const fatalPolicy = createFatalPolicy();

module.exports = { createFatalPolicy, fatalPolicy };
