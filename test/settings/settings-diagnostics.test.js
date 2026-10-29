'use strict';

// renderer/settings/settings-diagnostics.js — mapping the result of installing missing system
// packages to a toast (`hostInstallToast`). The file registers into `SETTINGS_VIEWS` at top
// level, so an empty stub is needed before it.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.SETTINGS_VIEWS = {};
const { hostInstallToast } = require('../../renderer/settings/settings-diagnostics.js');

test('hostInstallToast — success / nothing was missing', () => {
    assert.deepEqual(hostInstallToast({ ok: true, packages: ['a', 'b'] }),
        { key: 'toast.hostInstallOk', params: { list: 'a, b' }, isError: false });
    assert.deepEqual(hostInstallToast({ ok: true, error: 'nothing-missing' }),
        { key: 'toast.hostInstallNothing', params: {}, isError: false });
});

test('hostInstallToast — errors: with the commands still missing', () => {
    assert.deepEqual(hostInstallToast({ ok: false, error: 'install-failed', missingAfter: ['pactl', 'git'] }),
        { key: 'toast.hostInstallFailed', params: { list: 'pactl, git' }, isError: true });
    assert.equal(hostInstallToast({ ok: false, error: 'unknown-distro', missingAfter: ['x'] }).key, 'toast.hostInstallUnknownDistro');
    assert.equal(hostInstallToast({ ok: false, error: 'no-installer' }).key, 'toast.hostInstallNoInstaller');
    assert.equal(hostInstallToast(null).isError, true, 'IPC error (null) is an error toast too');
});
