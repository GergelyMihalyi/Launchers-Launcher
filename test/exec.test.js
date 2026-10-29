'use strict';

// lib/exec.js — `withTimeout` (timing) + `createLogger` (size-based rotation, on a temp file).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers/fs.js');
const { withTimeout, createLogger, sessionEnv, logError, toLogger } = require('../lib/exec.js');

test('withTimeout — the promise fulfills before the timeout', async () => {
    const result = await withTimeout(Promise.resolve('done'), 100, 'test');
    assert.equal(result, 'done');
});

test('withTimeout — the timeout fires before the promise', async () => {
    const neverResolves = new Promise(() => {});
    await assert.rejects(
        withTimeout(neverResolves, 20, 'slow-command'),
        /slow-command timeout/,
    );
});

test('withTimeout — the error of the rejected promise is passed on', async () => {
    await assert.rejects(
        withTimeout(Promise.reject(new Error('command error')), 100, 'test'),
        /command error/,
    );
});

function withEnv(patch, fn) {
    const saved = { ...process.env };
    try {
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        fn();
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
}

const NO_SESSION = {
    DISPLAY: undefined, WAYLAND_DISPLAY: undefined, XDG_RUNTIME_DIR: undefined, XDG_SESSION_TYPE: undefined,
    XDG_CURRENT_DESKTOP: undefined, XDG_SESSION_DESKTOP: undefined,
};

test('sessionEnv — base: the Wayland trio, from the real env if present', () => {
    withEnv({ ...NO_SESSION, DISPLAY: ':7' }, () => {
        const env = sessionEnv({ platform: 'wayland' });
        assert.equal(env.DISPLAY, ':7', 'the real DISPLAY wins');
        assert.equal(env.WAYLAND_DISPLAY, 'wayland-0', 'the missing one is supplied by the fallback');
        assert.equal(env.XDG_RUNTIME_DIR, `/run/user/${process.getuid()}`, 'from the UID, not hardcoded');
    });
});

test('sessionEnv — base, X11: does NOT supply the nonexistent wayland-0', () => {
    withEnv({ ...NO_SESSION, DISPLAY: ':2' }, () => {
        const env = sessionEnv({ platform: 'x11' });
        assert.equal(env.WAYLAND_DISPLAY, undefined);
        assert.equal(env.DISPLAY, ':2');
    });
});

test('sessionEnv — full, empty env (watcher): the KDE/Wayland profile supplies the missing one', () => {
    withEnv(NO_SESSION, () => {
        const env = sessionEnv({ full: true, platform: 'wayland' });
        assert.equal(env.XDG_SESSION_TYPE, 'wayland');
        assert.equal(env.XDG_CURRENT_DESKTOP, 'KDE');
        assert.equal(env.XDG_SESSION_DESKTOP, 'KDE');
        assert.ok('XAUTHORITY' in env);
    });
});

test('sessionEnv — full: does NOT overwrite the real session env (GNOME on Xorg)', () => {
    withEnv({ ...NO_SESSION, DISPLAY: ':2', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_DESKTOP: 'gnome-xorg' }, () => {
        const env = sessionEnv({ full: true, platform: 'x11' });
        assert.equal(env.XDG_SESSION_TYPE, 'x11');
        assert.equal(env.XDG_CURRENT_DESKTOP, 'GNOME');
        assert.equal(env.XDG_SESSION_DESKTOP, 'gnome-xorg');
    });
});

test('sessionEnv — full: missing/meaningless session type → from the platform (not blindly wayland)', () => {
    withEnv({ ...NO_SESSION, XDG_SESSION_TYPE: 'tty' }, () => {
        assert.equal(sessionEnv({ full: true, platform: 'x11' }).XDG_SESSION_TYPE, 'x11');
        assert.equal(sessionEnv({ full: true, platform: 'wayland' }).XDG_SESSION_TYPE, 'wayland');
    });
});

test('createLogger — the log is written to a file, with a timestamp prefix', async () => {
    const dir = tmpDir('gl-log-');
    const logFile = path.join(dir, 'test.log');
    const log = createLogger(logFile, 1024 * 1024);
    log('first message');
    await new Promise((resolve) => setTimeout(resolve, 50)); // fs.appendFile is asynchronous
    const content = fs.readFileSync(logFile, 'utf8');
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T.+\] first message\n$/);
});

test('createLogger — rotation: above the size limit the old content goes to .1', async () => {
    const dir = tmpDir('gl-log-');
    const logFile = path.join(dir, 'test.log');
    const log = createLogger(logFile, 10); // a trivially small limit - rotates after the first line
    log('aaaaaaaaaaaaaaaaaaaa');
    await new Promise((resolve) => setTimeout(resolve, 50));
    log('bbbbbbbbbbbbbbbbbbbb');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(`${logFile}.1`), 'the old content went to .1');
    assert.match(fs.readFileSync(logFile, 'utf8'), /bbbbbbbbbbbbbbbbbbbb/);
});

test('logError — `log` called with the "context: message" format', () => {
    const lines = [];
    logError((m) => lines.push(m), 'audio.applyStartupSink', new Error('pactl failed'));
    assert.deepEqual(lines, ['audio.applyStartupSink: pactl failed']);
});

test('createLogger — log.warn / log.error with an explicit level marker', async () => {
    const dir = tmpDir('gl-log-');
    const logFile = path.join(dir, 'test.log');
    const log = createLogger(logFile, 1024 * 1024);
    log.warn('figyelj');
    await new Promise((resolve) => setTimeout(resolve, 20));
    log.error('trouble');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.match(lines[0], /^\[[^\]]+\] WARN figyelj$/);
    assert.match(lines[1], /^\[[^\]]+\] ERROR trouble$/);
});

test('logError — if the logger has an .error, through that (ERROR level)', () => {
    const lines = [];
    const log = (m) => lines.push(`info:${m}`);
    log.error = (m) => lines.push(`error:${m}`);
    logError(log, 'ctx', new Error('x'));
    assert.deepEqual(lines, ['error:ctx: x']);
});

test('logError — a non-Error value is accepted too (String fallback)', () => {
    const lines = [];
    logError((m) => lines.push(m), 'ctx', 'raw string error');
    assert.deepEqual(lines, ['ctx: raw string error']);
});

test('logError — with a fake `log` (optional parameter) it is a no-op, does not throw', () => {
    assert.doesNotThrow(() => logError(undefined, 'ctx', new Error('x')));
    assert.doesNotThrow(() => logError(null, 'ctx', new Error('x')));
});

test('toLogger — returns a function unchanged, replaces anything else with a silent no-op', () => {
    const lines = [];
    const log = (m) => lines.push(m);
    assert.equal(toLogger(log), log);
    for (const bad of [undefined, null, 'x', 42, {}]) {
        const emit = toLogger(bad);
        assert.equal(typeof emit, 'function');
        assert.doesNotThrow(() => emit('nothing'));
    }
    assert.deepEqual(lines, []);
});

test('withTimeout — the losing timer is cleared (no live timer left after the race)', async () => {
    const count = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = count();
    await withTimeout(Promise.resolve('ok'), 60000, 'x');
    assert.equal(count(), before);
});
