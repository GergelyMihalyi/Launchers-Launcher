'use strict';

// lib/ipc/tv-mode-ipc.js — body of the "TV mode / CEC" IPC handlers, with fake deps. The point:
// TV-mode exit ALWAYS ends with `quit()` (even on error), the CEC calls are guarded by `cecAvailable()`,
// and saving the TV mode also writes the sidecar.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTvModeHandlers } = require('../../lib/ipc/tv-mode-ipc.js');

function makeHandlers(over = {}) {
    const calls = { sent: [], log: [], quit: 0, cleanup: 0, standby: [], userControl: [], sidecar: [] };
    let tvModePrefs = { closeFlatpak: ['org.old.App'], closeNative: [], preCommands: [] };
    const deps = {
        tvMode: {
            exitTvModeCleanup: over.exitTvModeCleanup || (async () => { calls.cleanup += 1; }),
        },
        cec: {
            cecAvailable: async () => over.cec !== false,
            standbyTv: over.standbyTv || (async (target) => { calls.standby.push(target); }),
            cecUserControl: async (cmd, target) => { calls.userControl.push({ cmd, target }); },
        },
        displays: { readDisplayConfig: () => ({ monitor: 'DP-3', sink: null, ...(over.displayCfg || {}) }) },
        flatpak: { listRunningFlatpakApps: async () => [{ appId: 'org.running.App', name: 'Running' }] },
        prefs: {
            getTvMode: () => ({ ...tvModePrefs }),
            setTvMode: over.setTvMode || ((patch) => { tvModePrefs = { ...tvModePrefs, ...patch }; return { ...tvModePrefs }; }),
        },
        tvModeEnter: { writeSidecar: (tv) => { calls.sidecar.push(tv); } },
        log: (m) => calls.log.push(m),
        sendToRenderer: (ch, payload) => calls.sent.push({ ch, payload }),
        quit: () => { calls.quit += 1; },
    };
    return { h: createTvModeHandlers(deps), calls };
}

test('exitTvMode — cleanup, then quit; without standbyOnExit no CEC standby', async () => {
    const { h, calls } = makeHandlers();
    await h.exitTvMode();
    assert.equal(calls.cleanup, 1);
    assert.deepEqual(calls.standby, []);
    assert.equal(calls.quit, 1);
});

test('exitTvMode — standbyOnExit + CEC: standby to the configured cecTarget', async () => {
    const { h, calls } = makeHandlers({ displayCfg: { standbyOnExit: true, cecTarget: 5 } });
    await h.exitTvMode();
    assert.deepEqual(calls.standby, [5]);
    assert.equal(calls.quit, 1);
});

test('exitTvMode — standbyOnExit, but no CEC on the machine: silent skip', async () => {
    const { h, calls } = makeHandlers({ cec: false, displayCfg: { standbyOnExit: true } });
    await h.exitTvMode();
    assert.deepEqual(calls.standby, []);
    assert.equal(calls.quit, 1);
});

test('exitTvMode — quits even if the cleanup OR the standby fails (the launcher must not get stuck)', async () => {
    const a = makeHandlers({ exitTvModeCleanup: async () => { throw new Error('kscreen-doctor failed'); } });
    await a.h.exitTvMode();
    assert.equal(a.calls.quit, 1);
    assert.match(a.calls.log.join(), /TV mode exit error: kscreen-doctor failed/);

    const b = makeHandlers({ displayCfg: { standbyOnExit: true }, standbyTv: async () => { throw new Error('cec-ctl error'); } });
    await b.h.exitTvMode();
    assert.equal(b.calls.quit, 1);
    assert.match(b.calls.log.join(), /cec-ctl error/);
});

test('tvVolume / tvMute — CEC user-control to the cecTarget; no-op without CEC', async () => {
    const { h, calls } = makeHandlers({ displayCfg: { cecTarget: 5 } });
    await h.tvVolume('up');
    await h.tvVolume('down');
    await h.tvVolume('anything else'); // not 'up' -> down
    await h.tvMute();
    assert.deepEqual(calls.userControl, [
        { cmd: 'volume-up', target: 5 },
        { cmd: 'volume-down', target: 5 },
        { cmd: 'volume-down', target: 5 },
        { cmd: 'mute', target: 5 },
    ]);

    const noCec = makeHandlers({ cec: false });
    await noCec.h.tvVolume('up');
    await noCec.h.tvMute();
    assert.deepEqual(noCec.calls.userControl, []);
});

test('getTvCapabilities — cec from cecAvailable(), ddc is always false for now', async () => {
    assert.deepEqual(await makeHandlers().h.getTvCapabilities(), { cec: true, ddc: false });
    assert.deepEqual(await makeHandlers({ cec: false }).h.getTvCapabilities(), { cec: false, ddc: false });
});

test('listTvModeApps — the running flatpak apps + the ALREADY selected (even non-running) entries', async () => {
    assert.deepEqual(await makeHandlers().h.listTvModeApps(), {
        running: [{ appId: 'org.running.App', name: 'Running' }],
        selected: ['org.old.App'],
    });
});

test('setTvMode — the non-app-ID items of closeFlatpak are dropped', () => {
    const { h, calls } = makeHandlers();
    h.setTvMode({ closeFlatpak: ['org.ok.App', '--help', 5, null, 'not an id', 'a;b.c'] });
    assert.deepEqual(calls.sidecar[0].closeFlatpak, ['org.ok.App']);
});

test('setTvMode — takes over only the closeFlatpak array, writes a sidecar, tv-mode-changed ok:true', () => {
    const { h, calls } = makeHandlers();
    h.setTvMode({ closeFlatpak: ['org.new.App'], closeNative: ['firefox'] });
    assert.deepEqual(calls.sidecar[0].closeFlatpak, ['org.new.App']);
    assert.deepEqual(calls.sidecar[0].closeNative, [], 'closeNative cannot be written from the UI (manual config.json)');
    assert.equal(calls.sent[0].ch, 'tv-mode-changed');
    assert.equal(calls.sent[0].payload.ok, true);
    assert.deepEqual(calls.sent[0].payload.closeFlatpak, ['org.new.App']);
});

test('setTvMode — non-array closeFlatpak / bad payload: empty patch, does not throw', () => {
    const { h, calls } = makeHandlers();
    h.setTvMode({ closeFlatpak: 'org.x' });
    h.setTvMode(null);
    assert.deepEqual(calls.sidecar.map((t) => t.closeFlatpak), [['org.old.App'], ['org.old.App']]);
});

test('setTvMode — save error: ok:false with the current (saved) state, no sidecar write', () => {
    const { h, calls } = makeHandlers({ setTvMode: () => { throw new Error('EACCES'); } });
    h.setTvMode({ closeFlatpak: ['org.new.App'] });
    assert.equal(calls.sidecar.length, 0);
    assert.deepEqual(calls.sent, [{
        ch: 'tv-mode-changed',
        payload: { closeFlatpak: ['org.old.App'], closeNative: [], preCommands: [], ok: false },
    }]);
    assert.match(calls.log.join(), /TV mode save error: EACCES/);
});
