// @ts-check
'use strict';

// Fail-fast deps check in the IPC module constructors. The deps of `register*Ipc`/`create*Handlers` are untyped objects;
// a MISSING field (mistyped name, a key dropped from `main.js` during a refactor) would otherwise only surface on first use —
// hours later, inside an IPC call, where the self-update rollback (bootstrap.js) no longer protects. This way construction,
// i.e. STARTUP, throws. Only `undefined` counts as missing (`null` is an intentional "none" value, e.g. `safeModeReason: null`).

/**
 * @param {Record<string, any>} deps
 * @param {string[]} names the required fields (without a default)
 * @param {string} label the constructor name (for the error message)
 */
function requireDeps(deps, names, label) {
    if (!deps || typeof deps !== 'object') throw new TypeError(`${label}: missing deps object`);
    const missing = names.filter((n) => deps[n] === undefined);
    if (missing.length) throw new TypeError(`${label}: missing deps: ${missing.join(', ')}`);
}

module.exports = { requireDeps };
