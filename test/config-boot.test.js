'use strict';

// lib/config-boot.js — the startup config chain in one call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, useTempConfigHome } = require('./helpers/fs.js');
const { fakeLog } = require('./helpers/ipc.js');

const { dir, reset } = useTempConfigHome('gl-cfgboot-');
const config = require('../lib/config.js');
const { CONFIG_VERSION } = require('../lib/config-migrations.js');
const { bootConfig } = require('../lib/config-boot.js');

const catalog = require('../data/launcher-catalog.json');
const cfgFile = () => path.join(dir, 'launchers-launcher', 'config.json');

test('bootConfig — on a fresh machine: migrations run, the log shows the steps', () => {
    reset();
    const log = fakeLog();
    const res = bootConfig({ repoRoot: tmpDir('gl-repo-'), catalog, log });
    assert.equal(res.newerThanCode, false);
    assert.equal(config.get('configVersion', 0), CONFIG_VERSION);
    assert.ok(log.lines.some((l) => /Config migration: v0 →/.test(l)), log.lines.join('\n'));
});

test('bootConfig — corrupt config.json: set aside + logged, continues with a clean slate', () => {
    reset();
    fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
    fs.writeFileSync(cfgFile(), '{ this is not json');
    const log = fakeLog();
    bootConfig({ repoRoot: tmpDir('gl-repo-'), catalog, log });
    assert.ok(log.lines.some((l) => l.startsWith('Corrupt config.json set aside')));
    assert.equal(config.get('configVersion', 0), CONFIG_VERSION);
});

test('bootConfig — newer code schema (after a rollback): WARN, the migration is skipped', () => {
    reset();
    config.set('configVersion', CONFIG_VERSION + 5);
    const log = fakeLog();
    const res = bootConfig({ repoRoot: tmpDir('gl-repo-'), catalog, log });
    assert.equal(res.newerThanCode, true);
    assert.ok(log.lines.some((l) => l.startsWith('WARN Config: carries the schema of a newer launcher version')));
    assert.equal(config.get('configVersion', 0), CONFIG_VERSION + 5);
});
