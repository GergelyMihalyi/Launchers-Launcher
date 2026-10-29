// @ts-check
'use strict';

// SCHEMA evolution of config.json: numbered, run-once migrations + the `configVersion` key.
// NEW MIGRATION: a `{ to: <previous + 1>, name, run(ctx) }` row at the END of `MIGRATIONS`; `run` must be idempotent and THROW on
// error (the version does not advance then, the next start retries).
// DOWNGRADE (rollback): if `configVersion` is HIGHER than the code's, migrations are skipped and `normalizeConfig` drops nothing (`lenient`).
// Rule: NEVER change a key's type — a new shape = a new key name. Background: docs/dev/infrastructure.md#config-store

const config = require('./config.js');

/**
 * @typedef {Object} MigrationCtx
 * @property {any[]} catalog a `data/launcher-catalog.json`
 * @property {(msg: string) => void} logInfo
 * @property {(msg: string) => void} logError
 */

/** @type {Array<{ to: number, name: string, run: (ctx: MigrationCtx) => void }>} */
const MIGRATIONS = [
    {
        // v1 → v2 launcher model: the 3 old built-in launchers into `customLaunchers` (a no-op on an already
        // migrated config thanks to its own `_launcherModelV2` marker).
        to: 1,
        name: 'launcher-model-v2',
        run: ({ catalog, logInfo, logError }) => {
            const res = require('./launcher-list.js').migrateBuiltinLaunchers(catalog, { logInfo, logError });
            if (res && res.error) throw new Error(res.error);
        },
    },
];

const CONFIG_VERSION = MIGRATIONS[MIGRATIONS.length - 1].to;

/** The stored schema version (missing / invalid → 0 = config from before versioning). */
function storedConfigVersion() {
    const v = config.get('configVersion', 0);
    return Number.isInteger(v) && v >= 0 ? v : 0;
}

/** Was the config written by NEWER code (after a rollback / older checkout)? */
function isConfigNewerThanCode(codeVersion = CONFIG_VERSION) {
    return storedConfigVersion() > codeVersion;
}

/**
 * The pending migrations in order; `configVersion` advances after each.
 * @param {MigrationCtx} ctx
 * @param {{ steps?: typeof MIGRATIONS, codeVersion?: number }} [opts] for tests
 * @returns {{ from: number, to: number, ran: string[], failed: string | null, newerConfig: boolean }}
 */
function runMigrations(ctx, { steps = MIGRATIONS, codeVersion = CONFIG_VERSION } = {}) {
    const from = storedConfigVersion();
    if (from > codeVersion) {
        ctx.logError(`[migrate] the config carries the schema of a newer code version (configVersion ${from} > ${codeVersion}) — migration skipped`);
        return { from, to: from, ran: [], failed: null, newerConfig: true };
    }
    const ran = [];
    let current = from;
    for (const step of [...steps].sort((a, b) => a.to - b.to)) {
        if (step.to <= current || step.to > codeVersion) continue;
        try {
            step.run(ctx);
        } catch (err) {
            ctx.logError(`[migrate] ${step.name} (→ v${step.to}) error: ${err && err.message ? err.message : err} — the next start retries`);
            return { from, to: current, ran, failed: step.name, newerConfig: false };
        }
        config.set('configVersion', step.to);
        current = step.to;
        ran.push(step.name);
    }
    if (ran.length) ctx.logInfo(`[migrate] config v${from} → v${current} (${ran.join(', ')})`);
    return { from, to: current, ran, failed: null, newerConfig: false };
}

module.exports = { MIGRATIONS, CONFIG_VERSION, storedConfigVersion, isConfigNewerThanCode, runMigrations };
