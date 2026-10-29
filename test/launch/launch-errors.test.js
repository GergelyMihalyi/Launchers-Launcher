'use strict';

// lib/launch/launch-errors.js — the reason of a failed launch → i18n key + parameters.

const test = require('node:test');
const assert = require('node:assert/strict');
const le = require('../../lib/launch/launch-errors.js');

test('appLabel — the last segment of the flatpak appid, otherwise the file name of the command', () => {
    assert.equal(le.appLabel('flatpak', ['run', 'org.DolphinEmu.dolphin-emu', '-e', 'x']), 'dolphin-emu');
    assert.equal(le.appLabel('/usr/bin/steam', ['-x']), 'steam');
    assert.equal(le.appLabel('flatpak', ['list']), 'flatpak');
});

test('spawnErrorInfo — ENOENT / EACCES / other', () => {
    assert.deepEqual(le.spawnErrorInfo({ code: 'ENOENT', message: 'x' }, '/opt/rpcs3').params, { cmd: 'rpcs3' });
    assert.equal(le.spawnErrorInfo({ code: 'ENOENT' }, 'rpcs3').errorKey, 'err.cmdNotFound');
    assert.equal(le.spawnErrorInfo({ code: 'EACCES' }, 'x').errorKey, 'err.cmdNoPermission');
    const other = le.spawnErrorInfo(new Error('something'), 'x');
    assert.equal(other.errorKey, 'err.spawnFailed');
    assert.deepEqual(other.params, { msg: 'something' });
});

test('quickExitInfo — flatpak not installed vs. generic quick exit', () => {
    const a = le.quickExitInfo({ cmd: 'flatpak', args: ['run', 'net.pcsx2.PCSX2'], code: 1, flatpakInstalled: false });
    assert.equal(a.errorKey, 'err.flatpakNotInstalled');
    const b = le.quickExitInfo({ cmd: 'flatpak', args: ['run', 'net.pcsx2.PCSX2'], code: 1, flatpakInstalled: null });
    assert.deepEqual([b.errorKey, b.params], ['err.quickExit', { name: 'PCSX2', code: 1 }]);
});

test('isQuickFailure — only a non-zero code, without a signal, within the window, without a request', () => {
    const base = { code: 1, signal: null, elapsedMs: 100, quickExitMs: 8000, killRequested: false };
    assert.equal(le.isQuickFailure(base), true);
    assert.equal(le.isQuickFailure({ ...base, code: 0 }), false);
    assert.equal(le.isQuickFailure({ ...base, code: null, signal: 'SIGKILL' }), false);
    assert.equal(le.isQuickFailure({ ...base, elapsedMs: 9000 }), false);
    assert.equal(le.isQuickFailure({ ...base, killRequested: true }), false);
});

test('fileMissingInfo — only the file name in the toast, the full path in the log', () => {
    const r = le.fileMissingInfo('/mnt/roms/nes/zelda.nes');
    assert.equal(r.errorKey, 'err.fileMissing');
    assert.deepEqual(r.params, { file: 'zelda.nes' });
    assert.match(r.error, /\/mnt\/roms\/nes\/zelda\.nes/);
});
