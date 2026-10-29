// @ts-check
'use strict';

// Shared input validators for (IPC) payloads coming from the renderer. The renderer is our own code, but a
// broken / old-format payload (e.g. a favorite saved by an older version) must not reach the config unchecked
// or throw in a handler. Every function is pure and never throws; invalid input gives `null` (or an empty object).

/**
 * Non-empty string of at most `max` length — otherwise `null`.
 * @param {unknown} v @param {number} [max]
 * @returns {string | null}
 */
function str(v, max = 300) {
    return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/**
 * One of `values` — otherwise `null`.
 * @template T @param {unknown} v @param {readonly T[]} values
 * @returns {T | null}
 */
function oneOf(v, values) {
    return values.includes(/** @type {any} */ (v)) ? /** @type {T} */ (v) : null;
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function plainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * A flat map holding only primitive values (e.g. a favorite's `params`): non-primitive values and too
 * long strings are dropped, at most `maxKeys` keys.
 * @param {unknown} v @param {{ maxKeys?: number, maxLen?: number }} [opts]
 * @returns {Record<string, string|number|boolean|null>}
 */
function primitiveMap(v, { maxKeys = 16, maxLen = 4096 } = {}) {
    /** @type {Record<string, string|number|boolean|null>} */
    const out = {};
    if (!plainObject(v)) return out;
    for (const [k, val] of Object.entries(v).slice(0, maxKeys)) {
        if (val === null || typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val))) out[k] = val;
        else if (typeof val === 'string' && val.length <= maxLen) out[k] = val;
    }
    return out;
}

/**
 * BT MAC address (`AA:BB:CC:DD:EE:FF`) — otherwise `null`. Goes into a `bluetoothctl` argument, hence strict.
 * @param {unknown} v
 * @returns {string | null}
 */
function macAddress(v) {
    return typeof v === 'string' && /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(v) ? v : null;
}

/**
 * Flatpak app ID (`org.example.App`: dot-separated identifier parts) — otherwise `null`. Cannot start with
 * `-`, so it can never be read as an option.
 * @param {unknown} v
 * @returns {string | null}
 */
function flatpakAppId(v) {
    return typeof v === 'string' && v.length <= 255 && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/.test(v) ? v : null;
}

/**
 * The items of an array that pass the `item` validator (the rest are dropped); empty array for a non-array.
 * @template T @param {unknown} v @param {(x: unknown) => T | null} item @param {number} [max] at most this many items
 * @returns {T[]}
 */
function arrayOf(v, item, max = 256) {
    if (!Array.isArray(v)) return [];
    /** @type {T[]} */
    const out = [];
    for (const x of v.slice(0, max)) {
        const ok = item(x);
        if (ok !== null) out.push(ok);
    }
    return out;
}

// Length limit of a file path / URL (second argument of `str`).
const PATH_MAX = 4096;

module.exports = { str, oneOf, plainObject, primitiveMap, macAddress, flatpakAppId, arrayOf, PATH_MAX };
