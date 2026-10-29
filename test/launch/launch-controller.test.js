'use strict';

// lib/launch/launch-controller.js — the launch/window-hide state machine. The full flow is
// GUI-bound, but `spawn`, the window and the timers are injectable: here we walk the main
// branches with fake EventEmitters + short `timings` (spawn OK, close,
// error, watchdog, blur-hide, switchToRunning).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLaunchController, childEnv } = require('../../lib/launch/launch-controller.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Short timers to keep the test fast (the real values are 1.5–8 s).
const TIMINGS = {
    hideFallbackMs: 60, hideMinMs: 10, spawnWatchdogMs: 25,
    bringToFrontMs: 10, externalWatchMs: 10, externalWatchMaxMs: 10000, quickExitMs: 5000,
};

function fakeWindow() {
    const win = new EventEmitter();
    win.calls = [];
    win._focused = true;
    win._visible = true;
    win.show = () => { win._visible = true; win.calls.push('show'); };
    win.showInactive = () => { win._visible = true; win.calls.push('showInactive'); };
    win.hide = () => { win._visible = false; win.calls.push('hide'); };
    win.focus = () => win.calls.push('focus');
    win.setFullScreen = (v) => win.calls.push(`setFullScreen:${v}`);
    win.isDestroyed = () => false;
    win.isFocused = () => win._focused;
    win.isVisible = () => win._visible;
    return win;
}

function makeController(over = {}) {
    const events = []; // sendToRenderer calls
    const win = over.window || fakeWindow();
    let child = null;
    const deps = {
        getWindow: () => win,
        log: () => {},
        sendToRenderer: (ch, payload) => events.push({ ch, payload }),
        recordUsage: (id) => events.push({ ch: '__recordUsage', payload: id }),
        recordUsageDuration: (id, ms) => events.push({ ch: '__recordUsageDuration', payload: { id, ms } }),
        recordRecentGame: over.recordRecentGame || (() => false),
        invalidateRecent: (appId) => events.push({ ch: '__invalidateRecent', payload: appId }),
        launchersPayload: () => ['launchers'],
        onLauncherShown: () => events.push({ ch: '__shown' }),
        onLauncherHidden: () => events.push({ ch: '__hidden' }),
        onLaunchSequenceStart: () => events.push({ ch: '__seqStart' }),
        onLaunchSequenceEnd: () => events.push({ ch: '__seqEnd' }),
        activateWindow: over.activateWindow || (async () => true),
        raiseSteamBigPicture: over.raiseSteamBigPicture || (async () => {}),
        killFlatpakApp: over.killFlatpakApp || (async () => false),
        spawn: () => { child = new EventEmitter(); return child; },
        timings: TIMINGS,
        ...over.deps,
    };
    const ctl = createLaunchController(deps);
    return { ctl, win, events, getChild: () => child };
}

const chans = (events) => events.map((e) => e.ch);

test('childEnv — supplies the session variables (type, desktop, DISPLAY)', () => {
    const env = childEnv();
    assert.ok(['wayland', 'x11'].includes(env.XDG_SESSION_TYPE));
    assert.ok(env.XDG_CURRENT_DESKTOP);
    assert.ok(env.DISPLAY);
});

test('spawnGame — app-launched + blur listener + the spawn watchdog sends an app-error', async () => {
    const { ctl, win, events } = makeController();
    ctl.spawnGame('steam', 'steam', ['-x']);
    assert.deepEqual(chans(events).filter((c) => !c.startsWith('__')), ['app-launched']);
    assert.equal(win.listenerCount('blur'), 1);

    await delay(TIMINGS.spawnWatchdogMs + 15);
    const err = events.find((e) => e.ch === 'app-error');
    assert.ok(err, 'the watchdog sent an app-error');
    assert.equal(err.payload.appId, 'steam');
});

test('spawnGame — child "spawn" → recordUsage, the watchdog does NOT fire', async () => {
    const { ctl, events, getChild } = makeController();
    ctl.spawnGame('heroic', 'flatpak', ['run', 'x']);
    getChild().emit('spawn');
    await delay(TIMINGS.spawnWatchdogMs + 15);
    assert.ok(chans(events).includes('__recordUsage'));
    assert.ok(!chans(events).includes('app-error'), 'no watchdog error after spawn');
});

test('spawnGame — meta + recordRecentGame:true → an extra running-changed at spawn time', () => {
    const { ctl, events, getChild } = makeController({ recordRecentGame: () => true });
    ctl.spawnGame('heroic-game-x', 'flatpak', ['run'], { launcherId: 'heroic', key: 'k' });
    getChild().emit('spawn');
    assert.ok(chans(events).includes('running-changed'));
});

test('spawnGame — onLaunchSequenceStart immediately, onLaunchSequenceEnd in bringToFront (foreground guard)', async () => {
    const { ctl, events, getChild } = makeController();
    ctl.spawnGame('x', 'x', []);
    assert.deepEqual(chans(events).filter((c) => c.startsWith('__seq')), ['__seqStart']);
    getChild().emit('spawn');
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    assert.deepEqual(chans(events).filter((c) => c.startsWith('__seq')), ['__seqStart', '__seqEnd']);
});

test('playtime — spawn → close: recordUsageDuration in bringToFront, positive ms', async () => {
    const { ctl, events, getChild } = makeController();
    ctl.spawnGame('steam-game-620', 'steam', ['-x']);
    getChild().emit('spawn');
    await delay(20);
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    const rec = events.find((e) => e.ch === '__recordUsageDuration');
    assert.ok(rec, 'bringToFront called recordUsageDuration');
    assert.equal(rec.payload.id, 'steam-game-620');
    assert.ok(rec.payload.ms >= 15, `the measured ms is plausible (${rec.payload.ms})`);
});

// The playtime comes from the injected MONOTONIC clock, not the wall clock (Date.now) — a
// wall-clock jump during sleep / a clock change does not end up in the playtime.
test('playtime — uses the monotonic clock (deps.now), a wall-clock jump does not count', async () => {
    let t = 1000;
    const { ctl, events, getChild } = makeController({ deps: { now: () => t } });
    const realNow = Date.now;
    ctl.spawnGame('steam-game-620', 'steam', ['-x']);
    getChild().emit('spawn');
    t += 42000; // 42 s of play on the monotonic clock
    Date.now = () => realNow() + 3600e3; // meanwhile the wall clock jumps an hour
    try {
        getChild().emit('close', 0, null);
        await delay(TIMINGS.bringToFrontMs + 15);
    } finally {
        Date.now = realNow;
    }
    const rec = events.find((e) => e.ch === '__recordUsageDuration');
    assert.equal(rec.payload.ms, 42000);
});

test('playtime — spawn-watchdog branch (no "spawn"): does NOT call recordUsageDuration', async () => {
    const { ctl, events } = makeController();
    ctl.spawnGame('x', 'x', []);
    await delay(TIMINGS.spawnWatchdogMs + TIMINGS.bringToFrontMs + 30);
    assert.ok(!chans(events).includes('__recordUsageDuration'), 'no measurement for a game that did not start');
});

test('spawnGame — child "close" → bringToFront (show + fullscreen + app-closed + shown)', async () => {
    const { ctl, win, events, getChild } = makeController();
    ctl.spawnGame('x', 'x', []);
    getChild().emit('spawn');
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    assert.ok(win.calls.includes('show'));
    assert.ok(win.calls.includes('setFullScreen:true'));
    assert.ok(chans(events).includes('app-closed'));
    assert.ok(chans(events).includes('__shown'));
    assert.equal(win.listenerCount('blur'), 0, 'the blur listener is removed');
});

test('app-closed payload — the summary of the closed session { appId, sessionMs, totalMs } (ux-ideas A3)', async () => {
    const { ctl, events, getChild } = makeController({ deps: { recordUsageDuration: (id, ms) => 5000 + ms } });
    ctl.spawnGame('steam-game-1', 'x', []);
    getChild().emit('spawn');
    await delay(20);
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    const closed = events.find((e) => e.ch === 'app-closed');
    assert.equal(closed.payload.appId, 'steam-game-1');
    assert.ok(closed.payload.sessionMs >= 15, String(closed.payload.sessionMs));
    assert.equal(closed.payload.totalMs, 5000 + closed.payload.sessionMs);
});

test('bringToFront — invalidateRecent is called with the appId of the session that actually closed (not without an argument)', async () => {
    const { ctl, events, getChild } = makeController();
    ctl.spawnGame('pcsx2-game-42', 'flatpak', ['run']);
    getChild().emit('spawn');
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    const inv = events.find((e) => e.ch === '__invalidateRecent');
    assert.ok(inv, 'invalidateRecent was called');
    assert.equal(inv.payload, 'pcsx2-game-42', 'the appId of the closed session reaches the caller, so only the affected source is invalidated');
});

test('bringToFront — on the spawn-watchdog branch (no "spawn") invalidateRecent is called with null, not with the appId of spawnGame', async () => {
    const { ctl, events } = makeController();
    ctl.spawnGame('pcsx2', 'flatpak', ['run']); // sose kap 'spawn'-t -> a watchdog visz haza
    await delay(TIMINGS.spawnWatchdogMs + TIMINGS.bringToFrontMs + 30);
    const inv = events.find((e) => e.ch === '__invalidateRecent');
    assert.ok(inv, 'invalidateRecent was called');
    assert.equal(inv.payload, null, 'a session that did not start -> nothing to invalidate');
});

test('child "close" — covers the hidden window IMMEDIATELY (showInactive), focus takeover delayed', async () => {
    const { ctl, win, events, getChild } = makeController();
    ctl.spawnGame('x', 'x', []);
    getChild().emit('spawn');
    await delay(TIMINGS.hideMinMs + 5);
    win.emit('blur'); // the app took the focus → the window is hidden
    assert.ok(win.calls.includes('hide'));
    win.calls.length = 0;
    events.length = 0;

    getChild().emit('close', 0, null);
    // IMMEDIATELY, BEFORE the bringToFrontMs delay: the desktop is covered, but without focus/app-closed.
    assert.ok(win.calls.includes('showInactive'), 'the hidden window comes back immediately');
    assert.ok(win.calls.includes('setFullScreen:true'));
    assert.ok(!win.calls.includes('focus'), 'it does not take over the focus yet');
    assert.ok(!chans(events).includes('app-closed'), 'app-closed has not been sent yet');

    await delay(TIMINGS.bringToFrontMs + 15);
    assert.ok(win.calls.includes('focus'));
    assert.ok(chans(events).includes('app-closed'));
});

test('the cover guard: for an already visible window (immediate spawn error) there is no showInactive', async () => {
    const { ctl, win, getChild } = makeController();
    ctl.spawnGame('x', 'x', []);
    getChild().emit('error', new Error('ENOENT')); // no blur → the window was never hidden
    assert.ok(!win.calls.includes('showInactive'), 'we do not mess with the focus on a visible window');
    await delay(TIMINGS.bringToFrontMs + 15);
    assert.ok(win.calls.includes('show')); // the delayed bringToFront brings it fully back
});

test('spawnGame — child "error" → app-error + bringToFront', async () => {
    const { ctl, win, events, getChild } = makeController();
    ctl.spawnGame('x', 'x', []);
    getChild().emit('error', new Error('ENOENT'));
    await delay(TIMINGS.bringToFrontMs + 15);
    const err = events.find((e) => e.ch === 'app-error');
    assert.equal(err.payload.error, 'ENOENT');
    assert.ok(win.calls.includes('show'));
});

test('blur after hideMinMs → hiding the window + onLauncherHidden', async () => {
    const { ctl, win, events, getChild } = makeController();
    ctl.spawnGame('x', 'x', []);
    getChild().emit('spawn');
    await delay(TIMINGS.hideMinMs + 5);
    win.emit('blur');
    assert.ok(win.calls.includes('hide'));
    assert.ok(chans(events).includes('__hidden'));
});

test('early blur (before hideMinMs) — does not hide immediately, only if the focus was lost', async () => {
    const win = fakeWindow();
    const { ctl, events, getChild } = makeController({ window: win });
    ctl.spawnGame('x', 'x', []);
    getChild().emit('spawn'); // the spawn watchdog stops, it does not "rescue" early
    win._focused = true;
    win.emit('blur'); // immediately, before hideMinMs
    assert.ok(!win.calls.includes('hide'), 'early blur does not hide immediately');
    win._focused = false; // meanwhile the app really took over
    await delay(TIMINGS.hideMinMs + 80); // the earlyBlurTimer runs about hideMinMs+50 ms later
    assert.ok(win.calls.includes('hide'));
    assert.ok(chans(events).includes('__hidden'));
});

test('re-entry: the "close" of a stale (overwritten) child does NOT close the OTHER, currently running session', async () => {
    // Two consecutive spawnGame() calls (`runningChild` overwritten) — the 'close' of a slowly
    // closing earlier wrapper process must not bring the launcher back / end the playtime
    // measurement under the SECOND game that is still actually running.
    const children = [];
    const { ctl, win, events } = makeController({ deps: { spawn: () => { const c = new EventEmitter(); children.push(c); return c; } } });

    ctl.spawnGame('game-a', 'a', []);
    children[0].emit('spawn');
    await delay(20);

    ctl.spawnGame('game-b', 'b', []); // overwrites runningChild
    children[1].emit('spawn');

    win.calls.length = 0;
    events.length = 0;

    // The old (game-a) wrapper closes only NOW — this is already a stale session.
    children[0].emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);

    assert.ok(!win.calls.includes('show'), 'the stale close does not bring the window back');
    assert.ok(!chans(events).includes('app-closed'), 'no app-closed for the stale session');
    assert.ok(!chans(events).includes('__recordUsageDuration'), 'it does not close the playtime of the running game-b');

    // game-b's close still ends the session properly.
    children[1].emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    assert.ok(win.calls.includes('show'));
    assert.ok(chans(events).includes('app-closed'));
    const rec = events.find((e) => e.ch === '__recordUsageDuration');
    assert.equal(rec.payload.id, 'game-b');
});

test('switchToRunning — Steam: raiseSteamBigPicture + recordUsage, no spawn', async () => {
    let raised = 0;
    const spawnCalls = [];
    const { ctl, events } = makeController({
        raiseSteamBigPicture: async () => { raised++; },
        deps: { spawn: (...a) => { spawnCalls.push(a); return new EventEmitter(); } },
    });
    await ctl.switchToRunning({ id: 'steam', cmd: 'steam' }, 1234);
    assert.equal(raised, 1);
    assert.ok(chans(events).includes('__recordUsage'));
    assert.equal(spawnCalls.length, 0);
});

test('switchToRunning — non-Steam, no activatable window → falls back to spawnGame', async () => {
    const spawnCalls = [];
    const { ctl } = makeController({
        activateWindow: async () => false,
        deps: { spawn: (...a) => { spawnCalls.push(a); return new EventEmitter(); } },
    });
    await ctl.switchToRunning({ id: 'heroic', cmd: 'flatpak', args: ['run', 'x'] }, null);
    assert.equal(spawnCalls.length, 1, 'fell back to spawnGame');
    assert.equal(spawnCalls[0][0], 'flatpak');
});

// --- Controller forced close ("kill-watch", melonDS only FOR NOW) ---
// Throttling the webContents background of a `hide()`-ed window did NOT WORK on the machine
// (with a controller), so the current solution SIMPLY DOES NOT CALL scheduleLauncherHide() for a
// killable session (the window stays "shown", melonDS's `--fullscreen` goes on top because of
// KWin stacking — see lib/launch/launch-controller.js).

test('spawnGame — meta.killable: does NOT subscribe to blur (does not hide the window), app-launched {killable:true}', () => {
    const { ctl, win, events } = makeController();
    ctl.spawnGame('melonds-game-x', 'flatpak', ['run'], { launcherId: 'melonds', killable: true, flatpakId: 'net.kuribo64.melonDS' });
    assert.equal(win.listenerCount('blur'), 0, 'a killable session does not call scheduleLauncherHide()');
    assert.ok(!win.calls.includes('hide'));
    const launched = events.find((e) => e.ch === 'app-launched');
    assert.deepEqual(launched.payload, { killable: true });
    // The "● RUNNING" poller still stops, as if we were hidden (saves resources).
    assert.ok(events.some((e) => e.ch === '__hidden'));
});

test('spawnGame — non-killable meta (e.g. heroic): the usual blur-listener hiding runs', () => {
    const { ctl, win, events } = makeController();
    ctl.spawnGame('heroic-game-x', 'flatpak', ['run'], { launcherId: 'heroic', key: 'k' });
    assert.equal(win.listenerCount('blur'), 1);
    const launched = events.find((e) => e.ch === 'app-launched');
    assert.equal(launched.payload, undefined);
});

test('killActiveGame — during a killable session: killFlatpakApp with the meta.flatpakId', async () => {
    const killCalls = [];
    const { ctl, getChild } = makeController({ killFlatpakApp: async (id) => { killCalls.push(id); return true; } });
    ctl.spawnGame('melonds-game-x', 'flatpak', ['run'], { launcherId: 'melonds', killable: true, flatpakId: 'net.kuribo64.melonDS' });
    getChild().emit('spawn');
    const ok = await ctl.killActiveGame();
    assert.equal(ok, true);
    assert.deepEqual(killCalls, ['net.kuribo64.melonDS']);
});

test('killActiveGame — native variant (flatpakId: null): the spawned process gets SIGTERM', async () => {
    const killCalls = [];
    const signals = [];
    const { ctl, getChild } = makeController({ killFlatpakApp: async (id) => { killCalls.push(id); return true; } });
    ctl.spawnGame('melonds-game-x', 'melonDS', ['--fullscreen', '/r.nds'], { launcherId: 'melonds', killable: true, flatpakId: null });
    const child = getChild();
    child.kill = (sig) => { signals.push(sig); return true; };
    child.emit('spawn');
    assert.equal(await ctl.killActiveGame(), true);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(killCalls.length, 0);
});

test('killActiveGame — after the "close" of the child (bringToFront) there is no active session anymore', async () => {
    const killCalls = [];
    const { ctl, getChild } = makeController({ killFlatpakApp: async (id) => { killCalls.push(id); return true; } });
    ctl.spawnGame('melonds-game-x', 'flatpak', ['run'], { launcherId: 'melonds', killable: true, flatpakId: 'net.kuribo64.melonDS' });
    getChild().emit('spawn');
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    const ok = await ctl.killActiveGame();
    assert.equal(ok, false);
    assert.equal(killCalls.length, 0);
});

test('killActiveGame — no active killable session → false, killFlatpakApp is NOT called', async () => {
    const killCalls = [];
    const { ctl } = makeController({ killFlatpakApp: async (id) => { killCalls.push(id); return true; } });
    const ok = await ctl.killActiveGame();
    assert.equal(ok, false);
    assert.equal(killCalls.length, 0);
});

// --- Cancelling a launch on the loader ---

test('cancelLaunch — live native child: SIGTERM, the launcher comes back immediately, the later close does not bring it back again', async () => {
    const signals = [];
    const { ctl, events, getChild } = makeController();
    ctl.spawnGame('game-x', 'game-bin', ['--x']);
    const child = getChild();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (sig) => { signals.push(sig); return true; };
    child.emit('spawn');
    const res = await ctl.cancelLaunch();
    assert.deepEqual(res, { killed: true });
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(chans(events).filter((c) => c === 'app-closed').length, 1);
    child.emit('close', null, 'SIGTERM'); // stale session: schedules no further bring-back, not an error
    await delay(TIMINGS.bringToFrontMs + 15);
    assert.equal(chans(events).filter((c) => c === 'app-closed').length, 1);
    assert.equal(chans(events).includes('app-error'), false);
});

test('cancelLaunch — on a flatpak launch `flatpak kill` with the app-id', async () => {
    const killCalls = [];
    const { ctl, getChild } = makeController({ killFlatpakApp: async (id) => { killCalls.push(id); return true; } });
    ctl.spawnGame('pcsx2-game-x', 'flatpak', ['run', 'net.pcsx2.PCSX2', '--x']);
    const child = getChild();
    child.exitCode = null;
    child.signalCode = null;
    child.emit('spawn');
    assert.deepEqual(await ctl.cancelLaunch(), { killed: true });
    assert.deepEqual(killCalls, ['net.pcsx2.PCSX2']);
});

test('cancelLaunch — for an already detached process (no live child) only the launcher comes back, killed: false', async () => {
    const { ctl, events, getChild } = makeController();
    ctl.spawnGame('steam', 'steam', ['steam://x']);
    const child = getChild();
    child.exitCode = 0; // the wrapper already exited
    child.signalCode = null;
    child.kill = () => { throw new Error('must not be called'); };
    const res = await ctl.cancelLaunch();
    assert.deepEqual(res, { killed: false });
    assert.equal(chans(events).filter((c) => c === 'app-closed').length, 1);
});

test('app-closed — today\'s playtime (todayMs) is in the payload too (the yardstick of the "Playtime reminder")', async () => {
    const { ctl, events, getChild } = makeController({ deps: { todayPlaytimeMs: () => 7200000 } });
    ctl.spawnGame('game-x', 'gamebin', [], { name: 'X' });
    getChild().emit('spawn');
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    const closed = events.find((e) => e.ch === 'app-closed');
    assert.equal(closed.payload.todayMs, 7200000);
});

// --- Running game: "BACK" on the home screen ---

test('activeSession — visible after spawn (name/cover), push goes out, bringToFront closes it', async () => {
    const { ctl, events, getChild } = makeController();
    assert.equal(ctl.getActiveSession(), null);
    ctl.spawnGame('steam-game-620', 'steam', ['steam://rungameid/620'], { name: 'Portal 2', cover: '/c.jpg' });
    assert.equal(ctl.getActiveSession(), null); // not there until the spawn event
    getChild().emit('spawn');
    assert.deepEqual(ctl.getActiveSession(), { appId: 'steam-game-620', name: 'Portal 2', cover: '/c.jpg' });
    assert.deepEqual(events.filter((e) => e.ch === 'active-session').at(-1).payload, { appId: 'steam-game-620', name: 'Portal 2', cover: '/c.jpg' });
    getChild().emit('close', 0, null);
    await delay(TIMINGS.bringToFrontMs + 15);
    assert.equal(ctl.getActiveSession(), null);
    assert.equal(events.filter((e) => e.ch === 'active-session').at(-1).payload, null);
});

test('resumeActiveSession — the game name, then tries the window of the flatpak app-id; the launcher hides', async () => {
    const tried = [];
    const { ctl, win, getChild } = makeController({ activateWindow: async (q) => { tried.push(q); return q === 'net.pcsx2.PCSX2'; } });
    assert.deepEqual(await ctl.resumeActiveSession(), { ok: false, activated: false }); // no session
    ctl.spawnGame('pcsx2-game-x', 'flatpak', ['run', 'net.pcsx2.PCSX2'], { name: 'Gran Turismo' });
    getChild().emit('spawn');
    win.calls.length = 0;
    assert.deepEqual(await ctl.resumeActiveSession(), { ok: true, activated: true });
    assert.deepEqual(tried, ['Gran Turismo', 'net.pcsx2.PCSX2']);
    assert.ok(win.calls.includes('hide'));
});

test('resumeActiveSession — if no window is activatable, the launcher hides anyway (activated: false)', async () => {
    const { ctl, win, getChild } = makeController({ activateWindow: async () => false });
    ctl.spawnGame('game-x', '/usr/bin/gamebin', [], { name: 'X' });
    getChild().emit('spawn');
    win.calls.length = 0;
    assert.deepEqual(await ctl.resumeActiveSession(), { ok: true, activated: false });
    assert.ok(win.calls.includes('hide'));
});

// --- Failed launch with a concrete reason ---

test('spawnGame — "error" ENOENT: app-error err.cmdNotFound with the command name', async () => {
    const { ctl, events, getChild } = makeController();
    ctl.spawnGame('x', '/usr/bin/missingilyen', []);
    getChild().emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const err = events.find((e) => e.ch === 'app-error');
    assert.equal(err.payload.errorKey, 'err.cmdNotFound');
    assert.deepEqual(err.payload.params, { cmd: 'missingilyen' });
});

test('spawnGame — quick exit with an error code + the flatpak is not installed: err.flatpakNotInstalled', async () => {
    const asked = [];
    const { ctl, events, getChild } = makeController({
        deps: { isFlatpakInstalled: async (id) => { asked.push(id); return false; } },
    });
    ctl.spawnGame('pcsx2-game-x', 'flatpak', ['run', 'net.pcsx2.PCSX2', '/r.iso']);
    getChild().emit('spawn');
    getChild().emit('close', 1, null);
    await delay(5);
    assert.deepEqual(asked, ['net.pcsx2.PCSX2']);
    const err = events.find((e) => e.ch === 'app-error');
    assert.equal(err.payload.errorKey, 'err.flatpakNotInstalled');
    assert.deepEqual(err.payload.params, { app: 'net.pcsx2.PCSX2' });
});

test('spawnGame — quick exit, installed flatpak: err.quickExit with the exit code', async () => {
    const { ctl, events, getChild } = makeController({ deps: { isFlatpakInstalled: async () => true } });
    ctl.spawnGame('dolphin-game-x', 'flatpak', ['run', 'org.DolphinEmu.dolphin-emu', '-e', '/r.iso']);
    getChild().emit('spawn');
    getChild().emit('close', 2, null);
    await delay(5);
    const err = events.find((e) => e.ch === 'app-error');
    assert.equal(err.payload.errorKey, 'err.quickExit');
    assert.deepEqual(err.payload.params, { name: 'dolphin-emu', code: 2 });
});

test('spawnGame — exit 0 (e.g. steam wrapper) / signal / forced close: NOT an error', async () => {
    for (const [code, signal] of [[0, null], [null, 'SIGTERM']]) {
        const { ctl, events, getChild } = makeController();
        ctl.spawnGame('steam', 'steam', ['-x']);
        getChild().emit('spawn');
        getChild().emit('close', code, signal);
        await delay(5);
        assert.equal(events.filter((e) => e.ch === 'app-error').length, 0, `code=${code} signal=${signal}`);
    }
    const { ctl, events, getChild } = makeController({ deps: { killFlatpakApp: async () => true } });
    ctl.spawnGame('melonds-game-x', 'flatpak', ['run', 'net.kuribo64.melonDS', '/r.nds'],
        { launcherId: 'melonds', killable: true, flatpakId: 'net.kuribo64.melonDS' });
    getChild().emit('spawn');
    await ctl.killActiveGame();
    getChild().emit('close', 137, null);
    await delay(5);
    assert.equal(events.filter((e) => e.ch === 'app-error').length, 0, '137 from a forced close is not an error');
});

test('spawnGame — slow (after quickExitMs) exit with an error code: NOT an error', async () => {
    const { ctl, events, getChild } = makeController({ deps: { timings: { ...TIMINGS, quickExitMs: 0 } } });
    ctl.spawnGame('x', 'flatpak', ['run', 'a.b.C']);
    getChild().emit('spawn');
    getChild().emit('close', 1, null);
    await delay(5);
    assert.equal(events.filter((e) => e.ch === 'app-error').length, 0);
});
