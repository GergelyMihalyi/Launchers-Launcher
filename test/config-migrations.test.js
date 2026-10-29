'use strict';

// lib/config-migrations.js — numbered schema migrations + the downgrade guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempConfigHome, writeRawConfigKey } = require('./helpers/fs.js');

const { reset } = useTempConfigHome('gl-migr-');
const config = require('../lib/config.js');
const {
    MIGRATIONS, CONFIG_VERSION, storedConfigVersion, isConfigNewerThanCode, runMigrations,
} = require('../lib/config-migrations.js');

const quiet = { catalog: [], logInfo: () => {}, logError: () => {} };

test('MIGRATIONS — strictly increasing `to` with no gaps from 1; CONFIG_VERSION = the last one', () => {
    MIGRATIONS.forEach((m, i) => assert.equal(m.to, i + 1, `${m.name}: to=${m.to}, expected ${i + 1}`));
    assert.equal(CONFIG_VERSION, MIGRATIONS[MIGRATIONS.length - 1].to);
    assert.equal(new Set(MIGRATIONS.map((m) => m.name)).size, MIGRATIONS.length);
});

test('storedConfigVersion — missing / invalid → 0', () => {
    reset();
    assert.equal(storedConfigVersion(), 0);
    config.set('configVersion', -3);
    assert.equal(storedConfigVersion(), 0);
    config.set('configVersion', 2);
    assert.equal(storedConfigVersion(), 2);
});

test('runMigrations — runs in order, advances the version step by step, no-op the second time', () => {
    reset();
    const order = [];
    const steps = [
        { to: 2, name: 'b', run: () => order.push(['b', storedConfigVersion()]) },
        { to: 1, name: 'a', run: () => order.push(['a', storedConfigVersion()]) },
    ];
    const res = runMigrations(quiet, { steps, codeVersion: 2 });
    assert.deepEqual(order, [['a', 0], ['b', 1]]);
    assert.deepEqual(res, { from: 0, to: 2, ran: ['a', 'b'], failed: null, newerConfig: false });
    assert.equal(storedConfigVersion(), 2);
    assert.deepEqual(runMigrations(quiet, { steps, codeVersion: 2 }).ran, []);
});

test('runMigrations — stops at a failing step, the version does NOT advance past it (the next start retries)', () => {
    reset();
    const errors = [];
    const steps = [
        { to: 1, name: 'ok', run: () => {} },
        { to: 2, name: 'bad', run: () => { throw new Error('boom'); } },
        { to: 3, name: 'never', run: () => assert.fail('must not run after the failing one') },
    ];
    const res = runMigrations({ ...quiet, logError: (m) => errors.push(m) }, { steps, codeVersion: 3 });
    assert.equal(res.failed, 'bad');
    assert.equal(storedConfigVersion(), 1);
    assert.match(errors[0], /bad.*boom/);
});

test('downgrade — config of newer code: migration skipped, normalizeConfig in lenient mode does not delete', () => {
    reset();
    config.set('configVersion', CONFIG_VERSION + 5);
    writeRawConfigKey(config.CONFIG_FILE, 'uiScale', { future: 'object-shape' }); // suppose a newer version changed its type
    assert.equal(isConfigNewerThanCode(), true);
    const res = runMigrations(quiet, { steps: [{ to: 1, name: 'x', run: () => assert.fail('must not run') }] });
    assert.equal(res.newerConfig, true);

    const lenient = config.normalizeConfig({ lenient: true });
    assert.deepEqual(lenient, { normalized: false, dropped: [], kept: ['uiScale'] });
    assert.deepEqual(config.get('uiScale', null), { future: 'object-shape' });

    const strict = config.normalizeConfig();
    assert.deepEqual(strict.dropped, ['uiScale']);
});

test('the real v1 migration (launcher-model-v2) — on a fresh config sets the marker and the version too', () => {
    reset();
    const res = runMigrations(quiet);
    assert.deepEqual(res.ran, ['launcher-model-v2']);
    assert.equal(config.get('_launcherModelV2', false), true);
    assert.equal(storedConfigVersion(), CONFIG_VERSION);
});
