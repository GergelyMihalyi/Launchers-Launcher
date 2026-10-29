// @ts-check
'use strict';

// The startup config chain in one place: recoverCorruptConfig → migrateFromLegacy → normalizeConfig → backupDaily → runMigrations.
// Sync, call BEFORE any other config read; every step logs in place. A corrupt config.json is set aside (.corrupt-<ts>), the legacy
// migration runs AFTER it; for a config written by NEWER code (after a rollback) normalization drops nothing; the daily backup runs
// BEFORE the migrations (the snapshot keeps the pre-migration state). Background: docs/dev/infrastructure.md#config-store

const config = require('./config.js');
const configMigrations = require('./config-migrations.js');

/**
 * @param {Object} o
 * @param {string} o.repoRoot location of the legacy root JSONs (main.js `__dirname`)
 * @param {Array<object>} o.catalog the launcher catalog (passed to the migrations)
 * @param {((msg: string) => void) & { warn: (msg: string) => void, error: (msg: string) => void }} o.log
 * @returns {{ newerThanCode: boolean }}
 */
function bootConfig({ repoRoot, catalog, log }) {
    const recovery = config.recoverCorruptConfig();
    if (recovery.recovered) log(`Corrupt config.json set aside: ${recovery.backup} — starting with a clean config`);

    const legacy = config.migrateFromLegacy(repoRoot);
    if (legacy.migrated) log(`Config migrated to ~/.config/launchers-launcher/config.json (${legacy.files.join(', ')})`);

    const newerThanCode = configMigrations.isConfigNewerThanCode();
    const normalization = config.normalizeConfig({ lenient: newerThanCode });
    if (newerThanCode) {
        log.warn(`Config: carries the schema of a newer launcher version (configVersion ${configMigrations.storedConfigVersion()} > ${configMigrations.CONFIG_VERSION}) — normalization/migration skipped${normalization.kept.length ? `, affected key(s): ${normalization.kept.join(', ')}` : ''}`);
    }
    if (normalization.normalized) {
        log(`Config normalized: wrongly typed key(s) dropped — ${normalization.dropped.join(', ')}`);
    }

    // Daily snapshot — source of the "Restore settings" subview. Never throws.
    const backup = config.backupDaily();
    if (backup.created) {
        log(`Config backup: ${backup.name}${backup.pruned.length ? ` (pruned: ${backup.pruned.join(', ')})` : ''}`);
    } else if (backup.error) {
        log(`Config backup error: ${backup.error}`);
    }

    const schema = configMigrations.runMigrations({ catalog, logInfo: log, logError: log.error });
    if (schema.ran.length) log(`Config migration: v${schema.from} → v${schema.to} (${schema.ran.join(', ')})`);
    if (schema.failed) log.error(`Config migration error: ${schema.failed} — the next start retries`);

    return { newerThanCode };
}

module.exports = { bootConfig };
