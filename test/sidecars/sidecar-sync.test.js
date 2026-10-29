'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resyncSidecars } = require('../../lib/sidecars/sidecar-sync.js');

function makeDeps(over = {}) {
    const calls = [];
    const deps = {
        prefs: {
            getMainController: () => ({ mac: 'AA:BB' }),
            getTvMode: () => ({ closeFlatpak: ['x'] }),
            getControllerAutostart: () => true,
            getStartWithSystem: () => true,
        },
        mainController: { writeSidecar: (mac) => calls.push(['main', mac]) },
        tvModeEnter: { writeSidecar: (cfg) => calls.push(['tv', cfg]) },
        autostart: { writeSidecar: (v) => calls.push(['auto', v]) },
        xdgAutostart: {
            isAutostartEntryPresent: () => false,
            writeAutostartEntry: (root) => calls.push(['xdg-write', root]),
            removeAutostartEntry: () => calls.push(['xdg-remove']),
        },
        repoRoot: '/repo',
        log: (m) => calls.push(['log', m]),
        ...over,
    };
    return { deps, calls };
}

test('resyncSidecars — writes every sidecar per the config, the XDG entry only on a mismatch', () => {
    const { deps, calls } = makeDeps();
    assert.deepEqual(resyncSidecars(deps), []);
    assert.deepEqual(calls, [
        ['main', 'AA:BB'], ['tv', { closeFlatpak: ['x'] }], ['auto', true], ['xdg-write', '/repo'],
    ]);
});

test('resyncSidecars — with a matching XDG state it does not touch the entry', () => {
    const { deps, calls } = makeDeps();
    deps.xdgAutostart.isAutostartEntryPresent = () => true;
    resyncSidecars(deps);
    assert.ok(!calls.some((c) => c[0].startsWith('xdg-')));
});

test('resyncSidecars — one failing step logs, but the others run', () => {
    const { deps, calls } = makeDeps();
    deps.mainController.writeSidecar = () => { throw new Error('EACCES'); };
    const failed = resyncSidecars(deps);
    assert.deepEqual(failed, ['Main controller sidecar write']);
    assert.ok(calls.some((c) => c[0] === 'log' && /EACCES/.test(c[1])));
    assert.ok(calls.some((c) => c[0] === 'tv') && calls.some((c) => c[0] === 'xdg-write'));
});
