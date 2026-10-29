'use strict';

// lib/update/dep-health.js — npm outdated / audit report.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNpmOutdated, parseNpmAudit, checkDependencyHealth } = require('../../lib/update/dep-health.js');

// Real output seen on the machine.
const OUTDATED = JSON.stringify({
    typescript: { current: '5.9.3', wanted: '5.9.3', latest: '7.0.2', dependent: 'launchers-launcher' },
    '@types/node': { current: '22.20.2', wanted: '22.20.4', latest: '22.20.9', dependent: 'launchers-launcher' },
});
const AUDIT = JSON.stringify({
    auditReportVersion: 2, vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 2, critical: 1, total: 4 } },
});

test('parseNpmOutdated — by name, the major-version lag marked', () => {
    assert.deepEqual(parseNpmOutdated(OUTDATED), [
        { name: '@types/node', current: '22.20.2', wanted: '22.20.4', latest: '22.20.9', major: false },
        { name: 'typescript', current: '5.9.3', wanted: '5.9.3', latest: '7.0.2', major: true },
    ]);
    assert.deepEqual(parseNpmOutdated(''), [], 'empty stdout = nothing outdated (exit 0)');
    assert.equal(parseNpmOutdated('{"error":{"code":"ENOTFOUND"}}'), null);
    assert.equal(parseNpmOutdated('not json'), null);
    assert.equal(parseNpmOutdated(null), null, 'the call itself failed');
});

test('parseNpmAudit — the numbers of metadata.vulnerabilities', () => {
    assert.deepEqual(parseNpmAudit(AUDIT), { total: 4, critical: 1, high: 2, moderate: 0, low: 1 });
    assert.equal(parseNpmAudit('{"error":{"code":"ENOAUDIT"}}'), null);
    assert.equal(parseNpmAudit(''), null);
});

test('checkDependencyHealth — a non-zero exit is not an error either, the stdout counts', async () => {
    const calls = [];
    const exec = async (cmd, args, opts) => {
        calls.push([cmd, args[0], opts.cwd]);
        if (args[0] === 'outdated') throw Object.assign(new Error('exit 1'), { code: 1, stdout: OUTDATED });
        return { stdout: AUDIT };
    };
    const res = await checkDependencyHealth('/repo', { exec });
    assert.equal(res.ok, true);
    assert.equal(res.outdated.length, 2);
    assert.equal(res.audit.total, 4);
    assert.deepEqual(calls.map((c) => c[1]).sort(), ['audit', 'outdated']);
    assert.ok(calls.every((c) => c[0] === 'npm' && c[2] === '/repo'));
});

test('checkDependencyHealth — offline / no npm: ok:false, does not throw', async () => {
    const exec = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    assert.deepEqual(await checkDependencyHealth('/repo', { exec }), { ok: false, outdated: null, audit: null });
});
