'use strict';

// lib/config-transfer.js — export/import of the portable settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PORTABLE_KEYS, FILE_NAME_RE, exportFileName, exportPortableSettings, parsePortableSettings, applyPortableSettings,
} = require('../lib/config-transfer.js');

const fakeConfig = (data) => ({ get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } });

test('exportPortableSettings — only the allowlisted keys; machine-specific / command-carrying ones are left out', () => {
    const json = JSON.parse(exportPortableSettings(fakeConfig({
        theme: { theme: 'neon' }, language: 'hu', volumeMax: 80, favoriteGames: [{ key: 'k' }],
        display: { startup: 'HDMI-1' }, customLaunchers: [{ cmd: 'rm' }], launcherPaths: { x: '/y' }, mainController: { mac: 'AA' },
        gameLaunchOptions: { k: 'A=1' }, flatpakGrants: [{ appId: 'a.b', path: '/mnt/x' }], usage: { steam: { count: 1 } },
    }), { version: '1.0.0', now: new Date('2026-10-01T10:00:00Z') }));
    assert.equal(json.format, 'launchers-launcher-settings');
    assert.equal(json.launcherVersion, '1.0.0');
    assert.deepEqual(Object.keys(json.settings).sort(), ['favoriteGames', 'language', 'theme', 'volumeMax']);
});

test('PORTABLE_KEYS — contains no machine-specific / command-carrying key', () => {
    for (const bad of ['display', 'customLaunchers', 'launcherPaths', 'mainController', 'tvMode', 'gameLaunchOptions', 'flatpakGrants', 'saveBackup', 'usage', 'recentGames', 'configVersion', 'setupDone', 'melondsRomDirs', 'customGameSources', 'pendingUpdateRollback']) {
        assert.equal(PORTABLE_KEYS.includes(bad), false, bad);
    }
});

test('parsePortableSettings — format/version check, unknown keys reported and skipped', () => {
    assert.equal(parsePortableSettings('not json').error, 'not-json');
    assert.equal(parsePortableSettings('{"format":"x"}').error, 'wrong-format');
    assert.equal(parsePortableSettings('{"format":"launchers-launcher-settings","formatVersion":9}').error, 'wrong-version');
    assert.equal(parsePortableSettings('{"format":"launchers-launcher-settings","formatVersion":1,"settings":[]}').error, 'no-settings');
    const ok = parsePortableSettings(JSON.stringify({
        format: 'launchers-launcher-settings', formatVersion: 1, settings: { language: 'en', customLaunchers: [{ cmd: 'x' }], display: {} },
    }));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.settings, { language: 'en' });
    assert.deepEqual(ok.ignored.sort(), ['customLaunchers', 'display']);
});

test('applyPortableSettings — the key for which config.set throws on a bad type is skipped, the rest are applied', () => {
    const data = {};
    const config = { set: (k, v) => { if (k === 'volumeMax' && typeof v !== 'number') throw new TypeError('bad type'); data[k] = v; } };
    const res = applyPortableSettings(config, { language: 'en', volumeMax: 'sok', uiScale: 'large' });
    assert.deepEqual(res.applied.sort(), ['language', 'uiScale']);
    assert.deepEqual(res.skipped, ['volumeMax']);
    assert.deepEqual(data, { language: 'en', uiScale: 'large' });
});

test('exportFileName — sortable, the name pattern matches; path traversal does not', () => {
    assert.match(exportFileName(new Date(2026, 9, 1, 9, 5, 3)), FILE_NAME_RE);
    assert.equal(exportFileName(new Date(2026, 9, 1, 9, 5, 3)), 'launchers-launcher-settings-2026-10-01_090503.json');
    assert.equal(FILE_NAME_RE.test('../launchers-launcher-settings-2026-10-01.json'), false);
});
