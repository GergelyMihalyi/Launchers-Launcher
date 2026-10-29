'use strict';

// lib/launch/do-not-disturb.js — the "Do not disturb" while gaming state machine. The actual
// `kde-inhibit`/`which` call is NOT tested (like the repo's other libs calling real system
// binaries, e.g. lib/output/cec.js / lib/bluetooth/bluetooth.js) — with fake
// `execFileAsync`/`spawn` the state machine: guard when there is no `kde-inhibit`, a double start
// does not spawn twice, the race (stop during the async probe) does not spawn, stop() kills
// the process group.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDoNotDisturb } = require('../../lib/launch/do-not-disturb.js');

function fakeDeps({ hasKdeInhibit = true } = {}) {
    const logs = [];
    const spawnCalls = [];
    const killCalls = [];
    const origKill = process.kill;
    return {
        logs, spawnCalls, killCalls,
        log: (msg) => logs.push(msg),
        execFileAsync: async (cmd, args) => {
            if (cmd === 'which' && args[0] === 'kde-inhibit') {
                if (hasKdeInhibit) return { stdout: '/usr/bin/kde-inhibit\n' };
                throw new Error('no such command');
            }
            throw new Error(`unexpected execFileAsync call: ${cmd}`);
        },
        spawn: (cmd, args, opts) => {
            spawnCalls.push({ cmd, args, opts });
            const child = new EventEmitter();
            child.pid = 424242; // a PID that never exists — process.kill(-pid) throws ESRCH, which the module swallows
            child.unref = () => {};
            return child;
        },
        execTimeoutMs: 8000,
        restoreProcessKill: () => { process.kill = origKill; },
    };
}

test('start() — no kde-inhibit: logs, does not spawn', async () => {
    const deps = fakeDeps({ hasKdeInhibit: false });
    const dnd = createDoNotDisturb(deps);
    await dnd.start();
    assert.equal(deps.spawnCalls.length, 0);
    assert.ok(deps.logs.some((l) => l.includes('no kde-inhibit')));
});

test('start() — kde-inhibit present: spawns once, a repeated start() does not spawn again', async () => {
    const deps = fakeDeps();
    const dnd = createDoNotDisturb(deps);
    await dnd.start();
    await dnd.start();
    assert.equal(deps.spawnCalls.length, 1);
    assert.deepEqual(deps.spawnCalls[0].args, ['--notifications', 'sleep', '86400']);
    assert.equal(deps.spawnCalls[0].cmd, 'kde-inhibit');
    assert.ok(deps.logs.some((l) => l.includes('BE')));
});

test('stop() before start() — no-op, does not throw', () => {
    const deps = fakeDeps();
    const dnd = createDoNotDisturb(deps);
    assert.doesNotThrow(() => dnd.stop());
    assert.equal(deps.logs.length, 0);
});

test('start() then stop() — tries to kill the process group (process.kill), logs', async () => {
    const deps = fakeDeps();
    const killArgs = [];
    process.kill = (pid, sig) => { killArgs.push([pid, sig]); throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
    try {
        const dnd = createDoNotDisturb(deps);
        await dnd.start();
        dnd.stop();
        // two attempts: -pid (process group) then plain pid (fallback), both swallowed
        assert.deepEqual(killArgs, [[-424242, 'SIGTERM'], [424242, 'SIGTERM']]);
        assert.ok(deps.logs.some((l) => l.includes('KI')));
    } finally {
        deps.restoreProcessKill();
    }
});

test('race: stop() during the `which` probe (`wanted=false` by the time the probe returns) — does not spawn', async () => {
    const deps = fakeDeps();
    let resolveWhich;
    deps.execFileAsync = () => new Promise((res) => { resolveWhich = res; });
    const dnd = createDoNotDisturb(deps);
    const starting = dnd.start(); // starts, stops at the `which` await
    dnd.stop(); // meanwhile the sequence ends — `wanted` becomes false
    resolveWhich({ stdout: '/usr/bin/kde-inhibit\n' });
    await starting;
    assert.equal(deps.spawnCalls.length, 0);
});

// --- GNOME: `show-banners` gsetting + marker file (re-enable after a crash) ---

const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('../helpers/fs.js');

function gnomeDeps({ banners = 'true', failSet = false } = {}) {
    const calls = [];
    const spawned = [];
    const logs = [];
    const markerFile = path.join(tmpDir('dnd-'), 'sub', 'gnome-dnd-active');
    return {
        calls, spawned, logs, markerFile,
        desktop: 'gnome',
        log: (m) => logs.push(m),
        execTimeoutMs: 8000,
        execFileAsync: async (cmd, args) => {
            calls.push([cmd, ...args]);
            if (args[0] === 'get') return { stdout: `${banners}\n` };
            if (failSet) throw new Error('dconf error');
            return { stdout: '' };
        },
        spawn: (cmd, args, opts) => {
            spawned.push({ cmd, args, opts });
            const c = new EventEmitter();
            c.unref = () => {};
            return c;
        },
    };
}

test('GNOME start() — show-banners true → false, marker file; stop() → detached gsettings set true, marker removed', async () => {
    const deps = gnomeDeps();
    const dnd = createDoNotDisturb(deps);
    await dnd.start();
    assert.deepEqual(deps.calls, [
        ['gsettings', 'get', 'org.gnome.desktop.notifications', 'show-banners'],
        ['gsettings', 'set', 'org.gnome.desktop.notifications', 'show-banners', 'false'],
    ]);
    assert.ok(fs.existsSync(deps.markerFile));
    await dnd.start(); // repeated start: does not set again
    assert.equal(deps.calls.length, 2); // active → the get does not run again either
    dnd.stop();
    assert.equal(deps.spawned.length, 1);
    assert.deepEqual(deps.spawned[0].args, ['set', 'org.gnome.desktop.notifications', 'show-banners', 'true']);
    assert.equal(deps.spawned[0].opts.detached, true);
    assert.ok(!fs.existsSync(deps.markerFile));
});

test('GNOME start() — the user-set "Do Not Disturb" (show-banners false) stays untouched', async () => {
    const deps = gnomeDeps({ banners: 'false' });
    const dnd = createDoNotDisturb(deps);
    await dnd.start();
    dnd.stop();
    assert.equal(deps.calls.length, 1); // only the get
    assert.equal(deps.spawned.length, 0);
    assert.ok(!fs.existsSync(deps.markerFile));
});

test('GNOME — stop() during the get: does not switch anything off', async () => {
    const deps = gnomeDeps();
    const dnd = createDoNotDisturb(deps);
    const p = dnd.start();
    dnd.stop();
    await p;
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.spawned.length, 0);
});

test('GNOME — failure of the set: no marker file, stop() is a no-op', async () => {
    const deps = gnomeDeps({ failSet: true });
    const dnd = createDoNotDisturb(deps);
    await dnd.start();
    assert.ok(!fs.existsSync(deps.markerFile));
    dnd.stop();
    assert.equal(deps.spawned.length, 0);
    assert.ok(deps.logs.some((l) => l.includes('gsettings error')));
});

test('GNOME recover() — the marker file of an earlier run → switches back + deletes it; without a marker a no-op', () => {
    const deps = gnomeDeps();
    const dnd = createDoNotDisturb(deps);
    dnd.recover();
    assert.equal(deps.spawned.length, 0);
    fs.mkdirSync(path.dirname(deps.markerFile), { recursive: true });
    fs.writeFileSync(deps.markerFile, 'x');
    dnd.recover();
    assert.equal(deps.spawned.length, 1);
    assert.ok(!fs.existsSync(deps.markerFile));
});

test('KDE recover() — no-op (kde-inhibit is bound to the process)', () => {
    const deps = fakeDeps();
    assert.doesNotThrow(() => createDoNotDisturb(deps).recover());
});
