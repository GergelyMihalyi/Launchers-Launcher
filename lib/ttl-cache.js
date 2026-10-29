// @ts-check
'use strict';

// Simple time-based (TTL) memoization for an I/O-heavy, read-only function: the key is the JSON of the arguments, after expiry the
// first call recomputes, `invalidate()` clears immediately. TTL rather than `fs.watch` (installs are rare on a kiosk; freshness comes
// from explicit invalidations). Does NOT cache a throw (or a rejected Promise) — only a SUCCESSFUL result lives for the whole window.
// Background: docs/dev/infrastructure.md

// Shared TTL of the games-library queries: 10 minutes. `lib/games/games-warmup.js` warms these caches at
// startup, and a short TTL would waste the warmup if the panel is opened later. Freshness on return from a
// game/Steam is kept by an explicit invalidate + rewarm.
const GAMES_CACHE_TTL_MS = 10 * 60000;

/**
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ttlMs
 */
function createTtlCache(fn, ttlMs) {
    /** @type {Map<string, { at: number, value: any }>} */
    const store = new Map();
    /** @param {any[]} args */
    function cached(...args) {
        const key = JSON.stringify(args);
        const hit = store.get(key);
        const now = Date.now();
        if (hit && now - hit.at <= ttlMs) return hit.value;
        const value = fn(...args);
        const entry = { at: now, value };
        store.set(key, entry);
        // Async `fn`: do not keep a rejected Promise in the cache until the TTL expires — the
        // store.get(key) === entry check protects against an overwrite/`invalidate()` meanwhile.
        if (value && typeof value.then === 'function') {
            value.catch(() => {
                if (store.get(key) === entry) store.delete(key);
            });
        }
        return value;
    }
    return Object.assign(cached, { invalidate() { store.clear(); } });
}

module.exports = { createTtlCache, GAMES_CACHE_TTL_MS };
