'use strict';

// lib/ipc/finish-setup.js — body of the `finish-setup` IPC handler (the setup wizard stores
// its choices in one go). Tested with fake `deps` (modeled on
// `lib/launch/launch-controller.js`/`test/launch/launch-controller.test.js`) — no real
// file system/pactl/kscreen-doctor call, every lib module is mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinishSetup } = require('../../lib/ipc/finish-setup.js');
const realLaunchersLib = require('../../lib/launcher-list.js');

function fakeDeps(overrides = {}) {
    const customLaunchers = [];
    const calls = { writeDisplayConfig: [], setAudioSink: [], writeSidecar: [], setTheme: [], setLanguage: [] };
    return {
        calls,
        customLaunchers,
        launchersLib: {
            readCustomLaunchers: () => customLaunchers.slice(),
            writeCustomLaunchers: (list) => { customLaunchers.length = 0; customLaunchers.push(...list); },
            isAccentColor: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
            isDualCatalogEntry: realLaunchersLib.isDualCatalogEntry,
            variantSpec: realLaunchersLib.variantSpec,
            pickLauncherVariant: realLaunchersLib.pickLauncherVariant,
            detectLauncherInstall: async (e) => {
                const installed = (overrides.installed || {})[e.id] ?? false;
                return { installed, nativeCmd: installed === 'native' || installed === 'both' ? 'steam' : null };
            },
        },
        launcherCatalog: [
            { id: 'steam', name: 'Steam', hint: 'h', icon: 'i.svg', cmd: 'steam', args: [], accent: '#112233' },
            { id: 'heroic', name: 'Heroic', cmd: 'flatpak', args: ['run', 'x'] },
        ],
        displays: { writeDisplayConfig: (patch) => calls.writeDisplayConfig.push(patch) },
        audio: { setAudioSink: async (name) => { calls.setAudioSink.push(name); } },
        prefs: {
            setMainController: (entry) => entry,
            setTheme: (id) => calls.setTheme.push(id),
            setLanguage: (id) => calls.setLanguage.push(id),
            setSetupDone: () => {},
        },
        mainController: { writeSidecar: (mac) => calls.writeSidecar.push(mac) },
        log: () => {},
        loadLaunchers: () => {},
        launchersWithUsage: () => [],
        sendToRenderer: () => {},
        ...overrides,
    };
}

test('applyFinishSetup — empty payload: does not throw, setSetupDone(true) runs', async () => {
    let done = false;
    const deps = fakeDeps({ prefs: { setMainController: () => null, setTheme: () => {}, setLanguage: () => {}, setSetupDone: () => { done = true; } } });
    const apply = createFinishSetup(deps);
    await assert.doesNotReject(() => apply(null));
    assert.equal(done, true);
});

test('applyFinishSetup — addLaunchers: copies the known catalog ids into customLaunchers, skips an unknown one, writes + signals', async () => {
    const deps = fakeDeps();
    const apply = createFinishSetup(deps);
    await apply({ addLaunchers: ['steam', 'nonexistent', 'heroic'] });
    assert.deepEqual(deps.customLaunchers.map((l) => l.id), ['steam', 'heroic']);
    assert.equal(deps.customLaunchers[0].accent, '#112233');
    assert.equal(deps.customLaunchers[1].accent, undefined); // no accent in the catalog
});

test('applyFinishSetup — addLaunchers: does not duplicate an already added id', async () => {
    const deps = fakeDeps();
    deps.customLaunchers.push({ id: 'steam', name: 'Steam', cmd: 'steam', args: [] });
    const apply = createFinishSetup(deps);
    await apply({ addLaunchers: ['steam'] });
    assert.equal(deps.customLaunchers.filter((l) => l.id === 'steam').length, 1);
});

test('applyFinishSetup — monitor/sink: writeDisplayConfig only with the given fields, with a sink setAudioSink runs too', async () => {
    const deps = fakeDeps();
    const apply = createFinishSetup(deps);
    await apply({ monitor: 'DP-1', sink: 'alsa_output.x' });
    assert.deepEqual(deps.calls.writeDisplayConfig, [{ monitor: 'DP-1', sink: 'alsa_output.x' }]);
    assert.deepEqual(deps.calls.setAudioSink, ['alsa_output.x']);
});

test('applyFinishSetup — neither monitor nor sink: writeDisplayConfig/setAudioSink is not called', async () => {
    const deps = fakeDeps();
    const apply = createFinishSetup(deps);
    await apply({});
    assert.equal(deps.calls.writeDisplayConfig.length, 0);
    assert.equal(deps.calls.setAudioSink.length, 0);
});

test('applyFinishSetup — mainController: an object without mac/missing -> calls setMainController with null + writeSidecar(null)', async () => {
    const deps = fakeDeps();
    const apply = createFinishSetup(deps);
    await apply({ mainController: { name: 'Pad', type: 'xbox' } }); // no mac
    assert.deepEqual(deps.calls.writeSidecar, [null]);
});

test('applyFinishSetup — mainController: a valid mac -> calls it with writeSidecar(mac)', async () => {
    const deps = fakeDeps();
    const apply = createFinishSetup(deps);
    await apply({ mainController: { mac: 'AA:BB:CC:DD:EE:FF', name: 'Pad' } });
    assert.deepEqual(deps.calls.writeSidecar, ['AA:BB:CC:DD:EE:FF']);
});

test('applyFinishSetup — theme/language: sets only for a string', async () => {
    const deps = fakeDeps();
    const apply = createFinishSetup(deps);
    await apply({ theme: 'nintendo', language: 'en' });
    assert.deepEqual(deps.calls.setTheme, ['nintendo']);
    assert.deepEqual(deps.calls.setLanguage, ['en']);
});

test('applyFinishSetup — a lib call that throws does not propagate (best effort, logged)', async () => {
    const logs = [];
    const deps = fakeDeps({
        log: (msg) => logs.push(msg),
        displays: { writeDisplayConfig: () => { throw new Error('disk full'); } },
    });
    const apply = createFinishSetup(deps);
    await assert.doesNotReject(() => apply({ monitor: 'DP-1' }));
    assert.ok(logs.some((l) => l.includes('disk full')));
});

// Dual-path (native + flatpak) catalog entry
const DUAL_STEAM = {
    id: 'steam', name: 'Steam', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-gamepadui'],
    nativeCmd: 'steam', nativeArgs: ['-gamepadui'],
};

for (const [installed, requested, cmd] of [
    ['flatpak', undefined, 'flatpak'],   // flatpak only → that
    ['native', undefined, 'steam'],      // native only → that
    ['native', 'flatpak', 'steam'],      // the request only counts for 'both'
    ['both', undefined, 'flatpak'],      // both → flatpak by default (recommended)
    ['both', 'native', 'steam'],         // both → the user's choice
    [false, undefined, 'flatpak'],       // neither → the catalog default
]) {
    test(`applyFinishSetup — dual-path launcher: installed=${installed}, requested=${requested} → ${cmd}`, async () => {
        const deps = fakeDeps({ launcherCatalog: [DUAL_STEAM], installed: { steam: installed } });
        const apply = createFinishSetup(deps);
        await apply({ addLaunchers: ['steam'], launcherVariants: requested ? { steam: requested } : undefined });
        const l = deps.customLaunchers[0];
        assert.equal(l.cmd, cmd);
        assert.deepEqual(l.args, cmd === 'steam' ? ['-gamepadui'] : DUAL_STEAM.args);
    });
}
