'use strict';

// lib/config.js — the unified ~/.config/launchers-launcher/config.json store.
// XDG_CONFIG_HOME is pointed at a temp directory BEFORE the `require` (the module reads it at
// load time), so the test does not touch the real user config.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, useTempConfigHome } = require('./helpers/fs.js');

// Every get/set of the module reflects the current state on disk (cached by stat signature), so
// deleting the config folder between tests (`reset()`) is enough, no new XDG_CONFIG_HOME per test.
const { reset } = useTempConfigHome('gl-xdg-');
const config = require('../lib/config.js');

test('get — a missing key returns the fallback', () => {
    reset();
    assert.deepEqual(config.get('theme', { theme: 'neon' }), { theme: 'neon' });
});

test('set — full replace, get returns it', () => {
    reset();
    config.set('theme', { theme: 'nintendo' });
    assert.deepEqual(config.get('theme', { theme: 'neon' }), { theme: 'nintendo' });
});

test('patch — field merge, the other keys stay untouched', () => {
    reset();
    config.set('display', { monitor: 'DP-3' });
    config.set('theme', { theme: 'win31' });
    config.patch('display', { sink: 'alsa_output.x' });
    assert.deepEqual(config.get('display', {}), { monitor: 'DP-3', sink: 'alsa_output.x' });
    assert.deepEqual(config.get('theme', {}), { theme: 'win31' });
});

test('patch — usage key increment logic, starts from zero for a missing id', () => {
    reset();
    const prev = config.get('usage', {}).steam;
    config.patch('usage', { steam: { count: (prev?.count || 0) + 1, lastLaunchedAt: '2026-01-01T00:00:00.000Z' } });
    assert.deepEqual(config.get('usage', {}), {
        steam: { count: 1, lastLaunchedAt: '2026-01-01T00:00:00.000Z' },
    });

    const prev2 = config.get('usage', {}).steam;
    config.patch('usage', { steam: { count: (prev2?.count || 0) + 1, lastLaunchedAt: '2026-01-02T00:00:00.000Z' } });
    assert.deepEqual(config.get('usage', {}), {
        steam: { count: 2, lastLaunchedAt: '2026-01-02T00:00:00.000Z' },
    });
});

test('patch — usage key leaves other ids untouched', () => {
    reset();
    config.patch('usage', { steam: { count: 3, lastLaunchedAt: '2026-01-01T00:00:00.000Z' } });
    config.patch('usage', { heroic: { count: 1, lastLaunchedAt: '2026-01-02T00:00:00.000Z' } });
    assert.deepEqual(config.get('usage', {}), {
        steam: { count: 3, lastLaunchedAt: '2026-01-01T00:00:00.000Z' },
        heroic: { count: 1, lastLaunchedAt: '2026-01-02T00:00:00.000Z' },
    });
});

test('set — an array key (launcherOrder) works too', () => {
    reset();
    config.set('launcherOrder', ['steam', 'heroic']);
    assert.deepEqual(config.get('launcherOrder', []), ['steam', 'heroic']);
});

test('invalid JSON in config.json -> get falls back to the fallback (does not throw)', () => {
    reset();
    fs.mkdirSync(path.dirname(config.CONFIG_FILE), { recursive: true });
    fs.writeFileSync(config.CONFIG_FILE, '{ not valid json');
    assert.deepEqual(config.get('theme', { theme: 'neon' }), { theme: 'neon' });
});

test('after the write config.json is human-readable, real JSON', () => {
    reset();
    config.set('theme', { theme: 'nintendo' });
    const raw = fs.readFileSync(config.CONFIG_FILE, 'utf8');
    assert.deepEqual(JSON.parse(raw), { theme: { theme: 'nintendo' } });
});

test('migrateFromLegacy — assembles config.json from the old root files', () => {
    reset();
    const root = tmpDir('gl-root-');
    fs.writeFileSync(path.join(root, 'theme-config.json'), JSON.stringify({ theme: 'win31' }));
    fs.writeFileSync(path.join(root, 'launcher-order.json'), JSON.stringify(['steam', 'heroic']));
    fs.writeFileSync(path.join(root, 'launchers-custom.json'), JSON.stringify([
        { id: 'ryujinx', name: 'Ryujinx', cmd: 'flatpak', args: ['run', 'io.github.ryubing.Ryujinx'], custom: true },
    ]));
    fs.writeFileSync(path.join(root, 'display-config.json'), JSON.stringify({
        monitor: 'DP-3', desktop: { monitors: ['DP-3', 'DP-1'], sink: null, disableOthers: true },
    }));

    const result = config.migrateFromLegacy(root);
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files.sort(), [
        'display-config.json', 'launcher-order.json', 'launchers-custom.json', 'theme-config.json',
    ]);

    assert.deepEqual(config.get('theme'), { theme: 'win31' });
    assert.deepEqual(config.get('launcherOrder'), ['steam', 'heroic']);
    assert.equal(config.get('customLaunchers')[0].id, 'ryujinx');
    assert.equal(config.get('display').monitor, 'DP-3');
    assert.ok(config.get('_migratedFrom'), 'the _migratedFrom marker is recorded');
});

test('migrateFromLegacy — only takes over the old files that actually exist', () => {
    reset();
    const root = tmpDir('gl-root-');
    fs.writeFileSync(path.join(root, 'theme-config.json'), JSON.stringify({ theme: 'win31' }));
    // launcher-order.json / launchers-custom.json / display-config.json are not in this root.

    const result = config.migrateFromLegacy(root);
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files, ['theme-config.json']);
    assert.equal(config.get('launcherOrder'), undefined);
});

test('migrateFromLegacy — does not run again if config.json already exists', () => {
    reset();
    config.set('theme', { theme: 'neon' });
    const root = tmpDir('gl-root-');
    fs.writeFileSync(path.join(root, 'theme-config.json'), JSON.stringify({ theme: 'win31' }));

    const result = config.migrateFromLegacy(root);
    assert.equal(result.migrated, false);
    // Does not overwrite the existing config.json with the old file's content.
    assert.deepEqual(config.get('theme'), { theme: 'neon' });
});

test('migrateFromLegacy — a fresh clone (no old file either) creates an empty config.json', () => {
    reset();
    const root = tmpDir('gl-root-');

    const result = config.migrateFromLegacy(root);
    assert.equal(result.migrated, false);
    assert.ok(fs.existsSync(config.CONFIG_FILE));
    assert.deepEqual(config.get('theme', { theme: 'neon' }), { theme: 'neon' });

    // A second call (e.g. a restart) does not try to migrate again either.
    fs.writeFileSync(path.join(root, 'theme-config.json'), JSON.stringify({ theme: 'nintendo' }));
    const second = config.migrateFromLegacy(root);
    assert.equal(second.migrated, false);
    assert.deepEqual(config.get('theme', { theme: 'neon' }), { theme: 'neon' });
});

test('recoverCorruptConfig — no config.json -> nothing to do', () => {
    reset();
    assert.deepEqual(config.recoverCorruptConfig(), { recovered: false });
});

test('recoverCorruptConfig — leaves an intact config.json alone', () => {
    reset();
    config.set('theme', { theme: 'oled' });
    assert.deepEqual(config.recoverCorruptConfig(), { recovered: false });
    assert.deepEqual(config.get('theme', null), { theme: 'oled' });
});

test('recoverCorruptConfig — sets corrupt JSON aside, get starts with a clean slate', () => {
    reset();
    fs.mkdirSync(path.dirname(config.CONFIG_FILE), { recursive: true });
    fs.writeFileSync(config.CONFIG_FILE, '{ "theme": { "theme": "neon" }, THIS IS NOT JSON');
    const r = config.recoverCorruptConfig();
    assert.equal(r.recovered, true);
    assert.match(r.backup, /config\.json\.corrupt-\d+$/);
    assert.ok(fs.existsSync(r.backup), 'the backup was kept');
    assert.ok(!fs.existsSync(config.CONFIG_FILE), 'the corrupt file disappeared from its place');
    // the launcher starts from clean defaults here
    assert.equal(config.get('theme', 'FALLBACK'), 'FALLBACK');
});

test('recoverCorruptConfig — valid JSON but not an object (array / number) is set aside too', () => {
    reset();
    fs.mkdirSync(path.dirname(config.CONFIG_FILE), { recursive: true });
    fs.writeFileSync(config.CONFIG_FILE, '[1, 2, 3]');
    assert.equal(config.recoverCorruptConfig().recovered, true);
    assert.ok(!fs.existsSync(config.CONFIG_FILE));
});

// --- normalizeConfig / normalizeConfigObject ---

test('normalizeConfigObject — drops a known key of the wrong type, keeps the right one', () => {
    const { config: out, dropped } = config.normalizeConfigObject({
        display: 'DP-3',                 // string instead of { } -> drop
        launcherOrder: { steam: 1 },     // object instead of [] -> drop
        theme: { theme: 'oled' },        // OK
        setupDone: true,                 // OK
        _migratedFrom: { files: ['x'] }, // unknown key -> untouched
    });
    assert.deepEqual(dropped.sort(), ['display', 'launcherOrder']);
    assert.deepEqual(out, {
        theme: { theme: 'oled' },
        setupDone: true,
        _migratedFrom: { files: ['x'] },
    });
});

test('normalizeConfigObject — number key: a finite number stays, string / NaN / null dropped', () => {
    const { config: out, dropped } = config.normalizeConfigObject({
        idleTimeout: 10, volumeStep: '5', volumeMax: NaN, tvExitHold: null,
    });
    assert.deepEqual(dropped.sort(), ['tvExitHold', 'volumeMax', 'volumeStep']);
    assert.deepEqual(out, { idleTimeout: 10 });
});

test('normalizeConfigObject — mainController null is valid (not dropped)', () => {
    const { dropped } = config.normalizeConfigObject({ mainController: null });
    assert.deepEqual(dropped, []);
});

test('normalizeConfigObject — leaves a clean config alone (no dropped)', () => {
    const raw = {
        theme: { theme: 'neon' }, display: { monitor: 'DP-3' }, launcherOrder: ['steam'],
        customLaunchers: [], feedback: { sound: true }, mainController: { mac: 'x' },
        tvMode: {}, usage: {}, recentGames: {}, language: 'hu', setupDone: false,
    };
    const { config: out, dropped } = config.normalizeConfigObject(raw);
    assert.deepEqual(dropped, []);
    assert.deepEqual(out, raw);
});

test('normalizeConfig — deletes the bad key of the on-disk config.json + writes it back', () => {
    reset();
    fs.mkdirSync(path.dirname(config.CONFIG_FILE), { recursive: true });
    fs.writeFileSync(config.CONFIG_FILE, JSON.stringify({
        display: 'DP-3', theme: { theme: 'win31' }, language: ['hu'],
    }));
    const r = config.normalizeConfig();
    assert.equal(r.normalized, true);
    assert.deepEqual(r.dropped.sort(), ['display', 'language']);
    // the bad keys fall back to the default in the reader, the good key stays
    assert.equal(config.get('display', 'FALLBACK'), 'FALLBACK');
    assert.equal(config.get('language', 'FALLBACK'), 'FALLBACK');
    assert.deepEqual(config.get('theme'), { theme: 'win31' });
    // actually written back to the file (it does not just disappear on get)
    assert.deepEqual(JSON.parse(fs.readFileSync(config.CONFIG_FILE, 'utf8')), { theme: { theme: 'win31' } });
});

test('normalizeConfig — intact / missing config.json -> no write', () => {
    reset();
    assert.deepEqual(config.normalizeConfig(), { normalized: false, dropped: [], kept: [] });
    config.set('theme', { theme: 'neon' });
    const before = fs.readFileSync(config.CONFIG_FILE, 'utf8');
    assert.deepEqual(config.normalizeConfig(), { normalized: false, dropped: [], kept: [] });
    assert.equal(fs.readFileSync(config.CONFIG_FILE, 'utf8'), before);
});

// --- read cache (stat signature) ---

test('get — returns a deep copy: mutating the returned object does not leak back', () => {
    reset();
    config.set('recentGames', { ryujinx: [{ key: 'a', cover: null }] });
    const got = config.get('recentGames', {});
    got.ryujinx[0].cover = '/tmp/x.png';
    got.extra = true;
    assert.deepEqual(config.get('recentGames', {}), { ryujinx: [{ key: 'a', cover: null }] });
});

test('get — an EXTERNAL (manual) file edit is visible immediately (the cache is keyed on the stat signature)', () => {
    reset();
    config.set('language', 'hu');
    assert.equal(config.get('language', null), 'hu');
    // In-place overwrite (NOT temp+rename — same inode), like a text editor's save.
    fs.writeFileSync(config.CONFIG_FILE, JSON.stringify({ language: 'en' }));
    assert.equal(config.get('language', null), 'en');
});

test('get — after the file is deleted the fallback is returned (the cache does not keep stale data)', () => {
    reset();
    config.set('uiScale', 'large');
    assert.equal(config.get('uiScale', 'normal'), 'large');
    fs.rmSync(config.CONFIG_FILE);
    assert.equal(config.get('uiScale', 'normal'), 'normal');
});

test('KEY_TYPES — alwaysOnTop/disabledBuiltins/_launcherModelV2 are normalized too', () => {
    const { config: out, dropped } = config.normalizeConfigObject({
        alwaysOnTop: 'igen', disabledBuiltins: 'steam', _launcherModelV2: 1,
    });
    assert.deepEqual(dropped.sort(), ['_launcherModelV2', 'alwaysOnTop', 'disabledBuiltins']);
    assert.deepEqual(out, {});
});

// --- Daily snapshot + restore ---

const cfgDir = () => path.dirname(config.CONFIG_FILE);
const day = (s) => new Date(`${s}T12:00:00`);

test('backupDaily — no config.json -> does not back up', () => {
    reset();
    assert.deepEqual(config.backupDaily({ now: day('2026-09-20') }), { created: false });
});

test('backupDaily — one backup per day, no duplicate for identical content', () => {
    reset();
    config.set('language', 'neon');
    const a = config.backupDaily({ now: day('2026-09-20') });
    assert.equal(a.created, true);
    assert.equal(a.name, 'config.json.bak-2026-09-20');
    // same day again -> no new one
    assert.equal(config.backupDaily({ now: day('2026-09-20') }).created, false);
    // next day, unchanged content -> no new one
    assert.equal(config.backupDaily({ now: day('2026-09-21') }).created, false);
    // next day, changed content -> new one
    config.set('language', 'win31');
    assert.equal(config.backupDaily({ now: day('2026-09-22') }).created, true);
    assert.deepEqual(config.listBackups().map((b) => b.date), ['2026-09-22', '2026-09-20']);
});

test('backupDaily — the most recent `keep` ones remain', () => {
    reset();
    for (let d = 1; d <= 7; d++) {
        config.set('language', `t${d}`);
        config.backupDaily({ now: day(`2026-09-0${d}`), keep: 3 });
    }
    assert.deepEqual(config.listBackups().map((b) => b.date), ['2026-09-07', '2026-09-06', '2026-09-05']);
});

test('restoreBackup — restores + puts the current one into pre-restore (undoable)', () => {
    reset();
    config.set('language', 'old');
    config.backupDaily({ now: day('2026-09-20') });
    config.set('language', 'new');
    assert.deepEqual(config.restoreBackup('config.json.bak-2026-09-20'), { ok: true });
    assert.equal(config.get('language'), 'old');
    const list = config.listBackups();
    assert.equal(list[0].kind, 'pre-restore');
    // undo
    assert.deepEqual(config.restoreBackup(list[0].name), { ok: true });
    assert.equal(config.get('language'), 'new');
});

test('restoreBackup — unknown name / path traversal / bad content rejected', () => {
    reset();
    config.set('language', 'x');
    assert.equal(config.restoreBackup('../../etc/passwd').ok, false);
    assert.equal(config.restoreBackup('config.json').ok, false);
    assert.equal(config.restoreBackup('config.json.bak-2026-01-01').ok, false); // does not exist
    fs.writeFileSync(path.join(cfgDir(), 'config.json.bak-2026-01-02'), '[1,2]');
    assert.equal(config.restoreBackup('config.json.bak-2026-01-02').ok, false);
    assert.equal(config.get('language'), 'x');
});

// A KNOWN key with the wrong type does not go into the file (the next startup normalization
// would silently delete it); an unknown key is allowed.
test('set / patch — rejects a known key of the wrong type per KEY_TYPES, the file untouched', () => {
    reset();
    config.set('language', 'hu');
    assert.throws(() => config.set('language', 42), /type of key "language" is string, got: number/);
    assert.throws(() => config.set('customLaunchers', {}), /is array, got: object/);
    assert.throws(() => config.set('mainController', 'x'), /object-or-null/);
    assert.throws(() => config.patch('favoriteGames', { a: 1 }), /is array/);
    assert.equal(config.get('language'), 'hu');
    assert.equal(config.get('customLaunchers', 'missing'), 'missing');
    config.set('mainController', null); // object-or-null accepts null
    config.set('valamiUjKulcs', 42); // unknown key: allowed
    assert.equal(config.get('valamiUjKulcs'), 42);
});
