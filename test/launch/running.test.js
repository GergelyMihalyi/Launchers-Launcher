'use strict';

// lib/launch/running.js — "is this launcher already running?" discovery.
// `parseProcessList` is a pure parser; `isLauncherRunning`/`detectRunningLaunchers` test the
// Steam branch with a temp `steam.pid`, the rest with "no such process" input (independent of
// whether the flatpak is installed on the test machine).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers/fs.js');
const { parseProcessList, createProbe, isLauncherRunning, detectRunningLaunchers } = require('../../lib/launch/running.js');

function tmpHomeWithSteamPid(pid) {
    const home = tmpDir('gl-running-');
    fs.mkdirSync(path.join(home, '.steam'), { recursive: true });
    fs.writeFileSync(path.join(home, '.steam', 'steam.pid'), String(pid));
    return home;
}

test('isLauncherRunning — Steam: with a live steam.pid { running, pid }', async () => {
    const home = tmpHomeWithSteamPid(process.pid);
    assert.deepEqual(
        await isLauncherRunning({ id: 'steam', name: 'Steam', cmd: 'steam', args: [] }, home),
        { running: true, pid: process.pid },
    );
});

test('isLauncherRunning — Steam: with a dead steam.pid not running', async () => {
    const home = tmpHomeWithSteamPid(999999999);
    assert.deepEqual(
        await isLauncherRunning({ id: 'steam', cmd: 'steam', args: [] }, home),
        { running: false, pid: null },
    );
});

test('isLauncherRunning — native binary: not running for a nonexistent command', async () => {
    const r = await isLauncherRunning({ id: 'x', name: 'X', cmd: 'gl-no-such-binary-xyz', args: [] });
    assert.deepEqual(r, { running: false, pid: null });
});

test('isLauncherRunning — flatpak: not running for a non-running appid', async () => {
    const r = await isLauncherRunning({
        id: 'y', name: 'Y', cmd: 'flatpak', args: ['run', 'com.example.definitely.not.running'],
    });
    assert.equal(r.running, false);
});

test('isLauncherRunning — does not throw for a null launcher', async () => {
    assert.deepEqual(await isLauncherRunning(null), { running: false, pid: null });
});

test('detectRunningLaunchers — returns only the running ones, id → { pid }', async () => {
    const home = tmpHomeWithSteamPid(process.pid);
    const found = await detectRunningLaunchers([
        { id: 'steam', cmd: 'steam', args: [] },
        { id: 'ghost', cmd: 'gl-no-such-binary-xyz', args: [] },
    ], home);
    assert.deepEqual([...found.keys()], ['steam']);
    assert.equal(found.get('steam').pid, process.pid);
});

test('parseProcessList — exact name match (cut to 15 characters), the first PID', () => {
    const ps = [
        '    1 systemd',
        '  812 steamwebhelper',
        ' 4242 retroarch',
        ' 5000 retroarch',
        ' 6001 averyveryverylo', // the kernel's comm is truncated to 15 characters
        ' 7000 Web Content',
    ].join('\n');
    assert.equal(parseProcessList(ps, 'retroarch'), 4242);
    assert.equal(parseProcessList(ps, 'retro'), null); // no partial match
    assert.equal(parseProcessList(ps, 'averyveryverylongname'), 6001);
    assert.equal(parseProcessList(ps, 'Web Content'), 7000); // name with a space
    assert.equal(parseProcessList('', 'x'), null);
    assert.equal(parseProcessList(ps, ''), null);
});

test('createProbe — the Promise of the external command is memoized within a round', () => {
    const probe = createProbe();
    assert.equal(probe.processList(), probe.processList());
    assert.equal(probe.flatpakPs(), probe.flatpakPs());
});

// The flatpak Steam's `steam.pid` is a number in the sandbox PID namespace (`103` on the T410) —
// meaningless on the host. The flatpak Steam is detected by `flatpak ps` (in production it did not show as running).
const FLATPAK_STEAM = { id: 'steam', name: 'Steam', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-gamepadui', '-tenfoot'] };

test('isLauncherRunning — flatpak Steam: flatpak ps decides, not steam.pid', async () => {
    const home = tmpHomeWithSteamPid(999999999); // dead native pid → do not look at it
    const probe = { flatpakPs: async () => 'com.valvesoftware.Steam\t4242\n', processList: async () => '' };
    assert.deepEqual(await isLauncherRunning(FLATPAK_STEAM, home, probe), { running: true, pid: 4242 });
    const none = { flatpakPs: async () => 'org.libretro.RetroArch\t77\n', processList: async () => '' };
    assert.deepEqual(await isLauncherRunning(FLATPAK_STEAM, home, none), { running: false, pid: null });
});
