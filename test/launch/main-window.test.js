'use strict';

// lib/launch/main-window.js — the kiosk window + the navigation lock + the renderer crash guard.
// The source-level guard of `webPreferences`: test/contracts/window-hardening.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fakeLog } = require('../helpers/ipc.js');
const mw = require('../../lib/launch/main-window.js');

const INDEX = 'file:///repo/index.html';

function fakeContents() {
    const c = new EventEmitter();
    c.reloaded = 0;
    c.destroyed = false;
    c.reload = () => { c.reloaded++; };
    c.isDestroyed = () => c.destroyed;
    c.setWindowOpenHandler = (fn) => { c.openHandler = fn; };
    return c;
}

test('mainWindowOptions — hardened webPreferences, frameless fullscreen', () => {
    const o = mw.mainWindowOptions('/repo/preload.js');
    assert.equal(o.fullscreen, true);
    assert.equal(o.frame, false);
    assert.deepEqual(o.webPreferences, {
        preload: '/repo/preload.js', contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    });
});

test('mainWindowOptions — the icon (logo) is added to the options only when given', () => {
    assert.equal('icon' in mw.mainWindowOptions('/repo/preload.js'), false);
    assert.equal(mw.mainWindowOptions('/repo/preload.js', '/repo/assets/logo/logo-512.png').icon, '/repo/assets/logo/logo-512.png');
});

test('guardNavigation — window.open blocked, navigation to a foreign URL blocked, the index (with #hash too) allowed', () => {
    const c = fakeContents();
    const log = fakeLog();
    mw.guardNavigation(c, INDEX, log);
    assert.deepEqual(c.openHandler({ url: 'https://x' }), { action: 'deny' });
    let prevented = 0;
    const ev = { preventDefault: () => { prevented++; } };
    c.emit('will-navigate', ev, `${INDEX}#settings`);
    assert.equal(prevented, 0);
    c.emit('will-navigate', ev, 'https://example.com/');
    assert.equal(prevented, 1);
    assert.equal(log.lines.filter((l) => l.startsWith('WARN')).length, 2);
});

test('watchRendererCrashes — clean-exit does not count; reload up to the limit, then onGiveUp', () => {
    const c = fakeContents();
    let n = 0;
    let gaveUp = 0;
    const guard = { record: () => (++n < 3 ? 'reload' : 'giveup'), count: () => n };
    mw.watchRendererCrashes(c, { guard, limit: 3, log: fakeLog(), onGiveUp: () => { gaveUp++; } });
    c.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    assert.equal(n, 0);
    c.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
    c.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    assert.equal(c.reloaded, 2);
    c.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
    assert.equal(gaveUp, 1);
    assert.equal(c.reloaded, 2);
});

test('logChildProcessGone — GPU → ERROR, other → WARN, clean-exit → nothing', () => {
    const log = fakeLog();
    mw.logChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1 }, log);
    mw.logChildProcessGone({ type: 'Utility', reason: 'killed', exitCode: 9, name: 'audio' }, log);
    mw.logChildProcessGone({ type: 'GPU', reason: 'clean-exit', exitCode: 0 }, log);
    assert.equal(log.lines.length, 2);
    assert.match(log.lines[0], /^ERROR GPU process gone: crashed/);
    assert.match(log.lines[1], /^WARN Utility process gone: killed \(exit 9\) \[audio\]/);
});

test('createMainWindow — built with the hardened options, both guards are attached, the index is loaded', () => {
    const made = [];
    class FakeWindow {
        constructor(opts) { this.opts = opts; this.webContents = fakeContents(); made.push(this); }
        loadFile(p) { this.loaded = p; }
    }
    const win = mw.createMainWindow({
        BrowserWindow: FakeWindow, preloadPath: '/repo/preload.js', indexPath: '/repo/index.html', indexUrl: INDEX,
        log: fakeLog(), crash: { guard: { record: () => 'reload', count: () => 1 }, limit: 3, log: fakeLog(), onGiveUp: () => {} },
    });
    assert.equal(made.length, 1);
    assert.equal(win.opts.webPreferences.sandbox, true);
    assert.equal(win.loaded, '/repo/index.html');
    assert.equal(typeof win.webContents.openHandler, 'function');
    assert.equal(win.webContents.listenerCount('render-process-gone'), 1);
    assert.equal(win.webContents.listenerCount('will-navigate'), 1);
});
