// @ts-check
'use strict';

// "NEW" badge + "recently added" sort: the launcher's OWN "first seen" record of the games (not the library modules' mtimes, so it is
// source-independent). The `gamesFirstSeen` config key is `{ "<game-key>": <ms> }`, `gamesFirstSeenBase` is the time of the first check.
// A game seen within BASELINE_MS (the first run: the sources load one after another) gets `0` = "old" (not new, does not outrank others);
// after that a new key gets the time it was seen. "NEW" = appeared in the last NEW_DAYS days and not launched yet. The record holds at
// most MAX_ENTRIES keys (the oldest `ts > 0` dropped); the RetroArch ROM set (~16,000) does not go here — the renderer only sends the keys
// of non-RetroArch rows.

const NEW_DAYS = 7;
const MAX_ENTRIES = 5000;
const BASELINE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void }} config
 * @param {() => number} [now]
 */
function createGamesFirstSeen(config, now = Date.now) {
    /** @returns {Record<string, number>} */
    function read() {
        const raw = config.get('gamesFirstSeen', {});
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        /** @type {Record<string, number>} */
        const out = {};
        for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v) && v >= 0) out[k] = v;
        return out;
    }

    /**
     * Records the keys seen now; returns the "NEW" keys (from the argument list).
     * @param {string[]} keys @param {Record<string, any>} [usageMap] the `usage` map (a launched game is not "new")
     * @returns {{ newKeys: string[], added: Record<string, number> }}
     */
    function noteSeen(keys, usageMap = {}) {
        const t = now();
        let base = Number(config.get('gamesFirstSeenBase', 0)) || 0;
        if (!base) { base = t; config.set('gamesFirstSeenBase', base); }
        const map = read();
        let changed = false;
        for (const k of keys) {
            if (typeof k !== 'string' || !k || k in map) continue;
            map[k] = t - base < BASELINE_MS ? 0 : t;
            changed = true;
        }
        const size = Object.keys(map).length;
        if (size > MAX_ENTRIES) {
            const drop = Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]).slice(0, size - MAX_ENTRIES);
            for (const [k] of drop) delete map[k];
            changed = true;
        }
        if (changed) config.set('gamesFirstSeen', map);
        const newKeys = keys.filter((k) => {
            const ts = map[k];
            const launched = usageMap && usageMap[k] && Number(usageMap[k].count) > 0;
            return ts > 0 && t - ts < NEW_DAYS * DAY_MS && !launched;
        });
        return { newKeys, added: map };
    }

    return { noteSeen, read };
}

module.exports = { createGamesFirstSeen, NEW_DAYS, MAX_ENTRIES, BASELINE_MS };
