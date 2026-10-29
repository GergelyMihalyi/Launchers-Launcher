'use strict';

// lib/recent/session-refresh.js — recent bookkeeping around a session + targeted invalidation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionRefresh } = require('../../lib/recent/session-refresh.js');

function setup({ wrote = true } = {}) {
    const calls = [];
    const sr = createSessionRefresh({
        usage: {
            recordRecentGame: () => wrote,
            invalidateDerivedRecent: (id) => calls.push(`derived:${id}`),
        },
        recentCovers: {
            RECENT_COVER_FETCHERS: { ryujinx: () => calls.push('cover:ryujinx') },
            DERIVED_MODULE_CACHE_INVALIDATORS: { pcsx2: () => calls.push('module:pcsx2') },
        },
        emulatorSources: { ryujinx: { cover: { configKey: 'ryujinx' } }, pcsx2: { cover: {} } },
        lutrisLibrary: { findInstalledGamesCached: { invalidate: () => calls.push('lutris') } },
        recentGamesMerge: { refreshLutrisRecentMirror: () => calls.push('mirror') },
        scheduleReturnWarmup: (appId) => calls.push(`warmup:${appId}`),
    });
    return { sr, calls };
}

test('recordRecentGame — network-cover emulator → cover download; other / not written → none', () => {
    const a = setup();
    assert.equal(a.sr.recordRecentGame({ launcherId: 'ryujinx' }), true);
    assert.equal(a.sr.recordRecentGame({ launcherId: 'pcsx2' }), true);
    assert.deepEqual(a.calls, ['cover:ryujinx']);
    const b = setup({ wrote: false });
    b.sr.recordRecentGame({ launcherId: 'ryujinx' });
    assert.deepEqual(b.calls, []);
});

test('afterSession — derived + module cache (if any) + Lutris + targeted warmup + mirror', () => {
    const { sr, calls } = setup();
    sr.afterSession('pcsx2');
    assert.deepEqual(calls, ['derived:pcsx2', 'module:pcsx2', 'lutris', 'warmup:pcsx2', 'mirror']);
    calls.length = 0;
    sr.afterSession(null);
    assert.deepEqual(calls, ['derived:null', 'lutris', 'warmup:null', 'mirror']);
});
