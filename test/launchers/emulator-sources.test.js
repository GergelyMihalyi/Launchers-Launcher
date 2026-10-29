'use strict';

// The descriptor fields main.js builds on without emulator names:
//   - `cover.configKey` → launch-time recorded recent + immediate cover fetch (main.js recordRecentGame)
//   - `onStartup({ log })` → one-time startup step (main.js whenReady)

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmulatorSources, DEFAULT_LIBS } = require('../../lib/launchers/emulator-sources.js');

function make(libsOver = {}, cfg = {}) {
    return createEmulatorSources({
        config: { get: (k, d) => (k in cfg ? cfg[k] : d) },
        workerScans: {},
        activeRpcs3ConfigRoot: () => '/x',
        libs: libsOver,
    });
}

test('cover.configKey — exactly the network-cover sources booked at launch time', () => {
    const src = make();
    const withKey = Object.keys(src).filter((id) => src[id].cover && src[id].cover.configKey).sort();
    assert.deepEqual(withKey, ['dolphin', 'ryujinx']);
    for (const id of withKey) assert.equal(typeof src[id].ensureCovers, 'function', `${id}: configKey without a network cover`);
});

test('onStartup — melonDS syncs the flatpak override of the manual ROM folders', async () => {
    const calls = [];
    const fakeMelonds = { ...DEFAULT_LIBS.melonds(), syncFlatpakOverrides: async (prev, next) => { calls.push([prev, next]); } };
    const src = make({ melonds: fakeMelonds }, { melondsRomDirs: ['/mnt/nds'] });
    await src.melonds.onStartup({ log: () => {} });
    assert.deepEqual(calls, [[[], ['/mnt/nds']]]);
});

test('onStartup — a function if present', () => {
    const src = make();
    for (const [id, s] of Object.entries(src)) {
        if ('onStartup' in s) assert.equal(typeof s.onStartup, 'function', id);
    }
});
