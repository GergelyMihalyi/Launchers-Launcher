// @ts-check
'use strict';

// Transferring the settings to another machine / after a reinstall: a small JSON file with the PORTABLE preferences.
// Deliberately NOT the whole `config.json`: machine-specific or command-carrying keys (display profile, launcher list and paths,
// main-controller MAC, TV-mode close list, flatpak permissions, launch options, backup target folder, `usage`/`recentGames` stats,
// markers) are LEFT OUT — the setup wizard collects them on the new machine. Import also only accepts the whitelisted keys, type
// checked (`config.set` against `KEY_TYPES`); everything else is ignored (and reported).

const FORMAT = 'launchers-launcher-settings';
const FORMAT_VERSION = 1;
const FILE_NAME_RE = /^launchers-launcher-settings-\d{4}-\d{2}-\d{2}(?:_\d{6})?\.json$/;

/** The transferable (machine-independent, command-free) config keys. */
const PORTABLE_KEYS = [
    'theme', 'language', 'uiScale', 'feedback', 'recentGamesUi', 'background',
    'gamesViewMode', 'gamesSortMode', 'gamesHiddenSources', 'hiddenGames', 'favoriteGames', 'seenTips',
    'launcherAccents', 'coverDownload', 'doNotDisturb',
    'idleTimeout', 'volumeStep', 'volumeMax', 'tvExitHold', 'screenDim', 'nightMode', 'autoSuspend', 'idleDisconnect', 'playtimeReminder',
];

function exportFileName(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `launchers-launcher-settings-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`;
}

/**
 * @param {{ get: (key: string, fallback?: any) => any }} config
 * @param {{ version?: string, now?: Date }} [opts]
 * @returns {string} the JSON text
 */
function exportPortableSettings(config, { version = '', now = new Date() } = {}) {
    /** @type {Record<string, any>} */
    const settings = {};
    for (const key of PORTABLE_KEYS) {
        const v = config.get(key, undefined);
        if (v !== undefined) settings[key] = v;
    }
    return `${JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION, launcherVersion: version, exportedAt: now.toISOString(), settings }, null, 2)}\n`;
}

/**
 * Parses the file text. `{ ok, settings }` (whitelisted keys only) or `{ ok: false, error }`.
 * @param {string} text
 * @returns {{ ok: boolean, settings?: Record<string, any>, ignored?: string[], error?: string }}
 */
function parsePortableSettings(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, error: 'not-json' };
    }
    if (!parsed || typeof parsed !== 'object' || parsed.format !== FORMAT) return { ok: false, error: 'wrong-format' };
    if (parsed.formatVersion !== FORMAT_VERSION) return { ok: false, error: 'wrong-version' };
    if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) return { ok: false, error: 'no-settings' };
    /** @type {Record<string, any>} */
    const settings = {};
    const ignored = [];
    for (const [k, v] of Object.entries(parsed.settings)) {
        if (PORTABLE_KEYS.includes(k)) settings[k] = v; else ignored.push(k);
    }
    return { ok: true, settings, ignored };
}

/**
 * Writes the parsed settings into the config (per key, type checked — a value of the wrong type is
 * skipped, the rest go in).
 * @param {{ set: (key: string, value: any) => void }} config
 * @param {Record<string, any>} settings
 * @returns {{ applied: string[], skipped: string[] }}
 */
function applyPortableSettings(config, settings) {
    const applied = [];
    const skipped = [];
    for (const [k, v] of Object.entries(settings)) {
        try {
            config.set(k, v);
            applied.push(k);
        } catch {
            skipped.push(k);
        }
    }
    return { applied, skipped };
}

module.exports = {
    PORTABLE_KEYS, FILE_NAME_RE, FORMAT, exportFileName, exportPortableSettings, parsePortableSettings, applyPortableSettings,
};
