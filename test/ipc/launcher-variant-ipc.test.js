'use strict';

// lib/ipc/launcher-variant-ipc.js — the native ↔ flatpak variant of added launchers + the manual
// launcher path. With fake `deps` (test/helpers/launcher-list-deps.js); adding a not-yet-added
// launcher natively goes through the REAL launcher-manage `saveLauncherEntry`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLauncherVariantHandlers } = require('../../lib/ipc/launcher-variant-ipc.js');
const { createLauncherManageHandlers } = require('../../lib/ipc/launcher-manage-ipc.js');
const realLib = require('../../lib/launcher-list.js');
const { fakeDeps } = require('../helpers/launcher-list-deps.js');

const createLauncherVariantHandlersFor = (deps) => createLauncherVariantHandlers({
    ...deps, saveLauncherEntry: createLauncherManageHandlers(deps).saveLauncherEntry,
});

// --- Native / flatpak variant ---
const DUAL_STEAM = {
    id: 'steam', name: 'Steam', hint: '', icon: '', cmd: 'flatpak',
    args: ['run', 'com.valvesoftware.Steam', '-gamepadui'], flathubId: 'com.valvesoftware.Steam',
    nativeCmd: 'steam', nativeArgs: ['-gamepadui'], accent: '#112233',
};

function dualDeps(installed) {
    const deps = fakeDeps();
    Object.assign(deps.launchersLib, {
        isDualCatalogEntry: realLib.isDualCatalogEntry,
        variantSpec: realLib.variantSpec,
        launcherVariantOf: realLib.launcherVariantOf,
        planVariantRepairs: realLib.planVariantRepairs,
        detectLauncherInstall: async () => ({
            installed, nativeCmd: installed === 'native' || installed === 'both' ? 'steam' : null,
        }),
    });
    deps.launcherCatalog = [DUAL_STEAM];
    const nativeSteam = { id: 'steam', name: 'My Steam', hint: '', icon: 'x.svg', cmd: 'steam', args: ['-gamepadui'], custom: true, accent: '#abcdef' };
    deps.customLaunchers.push(nativeSteam);
    deps.seedRaw([nativeSteam]);
    return deps;
}

test('setLauncherVariant — native → flatpak: cmd/args swapped, name/icon/accent stay, reload + launchers-changed', () => {
    const deps = dualDeps('both');
    const handlers = createLauncherVariantHandlersFor(deps);
    handlers.setLauncherVariant({ id: 'steam', variant: 'flatpak' });
    const l = deps.customLaunchers[0];
    assert.equal(l.cmd, 'flatpak');
    assert.deepEqual(l.args, DUAL_STEAM.args);
    assert.equal(l.name, 'My Steam');
    assert.equal(l.accent, '#abcdef');
    assert.equal(deps.reloadCalls.length, 1);
    assert.equal(deps.sent[0].channel, 'launchers-changed');
});

test('setLauncherVariant — invalid variant / unknown id / same variant: does not write', () => {
    const deps = dualDeps('both');
    const handlers = createLauncherVariantHandlersFor(deps);
    handlers.setLauncherVariant({ id: 'steam', variant: 'bash' });
    handlers.setLauncherVariant({ id: 'nope', variant: 'flatpak' });
    handlers.setLauncherVariant({ id: 'steam', variant: 'native' });
    handlers.setLauncherVariant(null);
    assert.equal(deps.customLaunchers[0].cmd, 'steam');
    assert.equal(deps.reloadCalls.length, 0);
});

test('repairLauncherVariants — native added, only flatpak is present → rewrites it + launchers-changed', async () => {
    const deps = dualDeps('flatpak');
    const handlers = createLauncherVariantHandlersFor(deps);
    const done = await handlers.repairLauncherVariants();
    assert.deepEqual(done, [{ id: 'steam', from: 'native', to: 'flatpak' }]);
    assert.equal(deps.customLaunchers[0].cmd, 'flatpak');
    assert.equal(deps.sent.filter((m) => m.channel === 'launchers-changed').length, 1);
});

for (const installed of ['both', 'native', false]) {
    test(`repairLauncherVariants — installed=${installed}: does not touch it`, async () => {
        const deps = dualDeps(installed);
        const handlers = createLauncherVariantHandlersFor(deps);
        assert.deepEqual(await handlers.repairLauncherVariants(), []);
        assert.equal(deps.customLaunchers[0].cmd, 'steam');
        assert.equal(deps.sent.length, 0);
    });
}

// --- Manually specified native launcher ---
function pathDeps({ installed = false, active = true, executableOk = true } = {}) {
    const deps = dualDeps(installed);
    let paths = {};
    Object.assign(deps.launchersLib, {
        readLauncherPaths: () => ({ ...paths }),
        writeLauncherPath: (id, p) => { if (p) paths[id] = p; else delete paths[id]; },
        checkLauncherExecutable: () => (executableOk ? { ok: true } : { ok: false, reason: 'not executable' }),
        findLauncherExecutables: (dir) => ({ guess: false, items: [{ path: `${dir}/steam`, name: 'steam' }] }),
        detectLauncherInstall: async () => ({ installed, nativeCmd: null }),
    });
    if (!active) { deps.customLaunchers.length = 0; deps.seedRaw([]); }
    deps.getPaths = () => paths;
    return deps;
}

test('setLauncherPath — added launcher: switches to the manual path (name/accent stay), saves, launchers-changed', async () => {
    const deps = pathDeps();
    const h = createLauncherVariantHandlersFor(deps);
    assert.deepEqual(await h.setLauncherPath({ id: 'steam', path: '/opt/steam/steam' }), { ok: true });
    assert.deepEqual(deps.getPaths(), { steam: '/opt/steam/steam' });
    const l = deps.customLaunchers[0];
    assert.equal(l.cmd, '/opt/steam/steam');
    assert.deepEqual(l.args, ['-gamepadui']);
    assert.equal(l.name, 'My Steam');
    assert.equal(deps.sent.filter((m) => m.channel === 'launchers-changed').length, 1);
});

test('setLauncherPath — a launcher not yet added: adds it natively; apply:false → only saves', async () => {
    let deps = pathDeps({ active: false });
    let h = createLauncherVariantHandlersFor(deps);
    await h.setLauncherPath({ id: 'steam', path: '/opt/steam/steam' });
    assert.equal(deps.customLaunchers[0].cmd, '/opt/steam/steam');
    deps = pathDeps({ active: false });
    h = createLauncherVariantHandlersFor(deps);
    await h.setLauncherPath({ id: 'steam', path: '/opt/steam/steam', apply: false });
    assert.equal(deps.customLaunchers.length, 0);
    assert.deepEqual(deps.getPaths(), { steam: '/opt/steam/steam' });
});

test('setLauncherPath — not executable / unknown id: rejects, does not write', async () => {
    const deps = pathDeps({ executableOk: false });
    const h = createLauncherVariantHandlersFor(deps);
    assert.deepEqual(await h.setLauncherPath({ id: 'steam', path: '/tmp/x' }), { ok: false, reason: 'not executable' });
    assert.equal((await h.setLauncherPath({ id: 'nope', path: '/tmp/x' })).ok, false);
    assert.deepEqual(deps.getPaths(), {});
    assert.equal(deps.customLaunchers[0].cmd, 'steam');
});

test('setLauncherPath delete — the launcher using the manual path falls back to the detected flatpak', async () => {
    const deps = pathDeps({ installed: 'flatpak' });
    const h = createLauncherVariantHandlersFor(deps);
    await h.setLauncherPath({ id: 'steam', path: '/opt/steam/steam' });
    await h.setLauncherPath({ id: 'steam', path: null });
    assert.deepEqual(deps.getPaths(), {});
    assert.equal(deps.customLaunchers[0].cmd, 'flatpak');
    assert.deepEqual(deps.customLaunchers[0].args, DUAL_STEAM.args);
});

test('findExecutables — unknown id / missing folder: ok:false; otherwise the matches of the lib', () => {
    const h = createLauncherVariantHandlersFor(pathDeps());
    assert.equal(h.findExecutables({ id: 'nope', dir: '/x' }).ok, false);
    assert.equal(h.findExecutables({ id: 'steam' }).ok, false);
    assert.deepEqual(h.findExecutables({ id: 'steam', dir: '/opt/s' }), { ok: true, guess: false, items: [{ path: '/opt/s/steam', name: 'steam' }] });
});
