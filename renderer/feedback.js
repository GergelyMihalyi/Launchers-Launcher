// Navigation feedback: a quiet, synthesized sound (Web Audio — no asset, no CSP change) + a short controller rumble (`vibrationActuator`);
// toggled with the `feedback` config key. Load order: AFTER util.js + state.js, BEFORE every other renderer/*.js (`feedback(kind)` is called
// from closures). Background: docs/dev/renderer/overview.md#navigation-feedback

// State: mirror of the `feedback` config key (`feedbackState`, renderer/state.js — loaded by get-feedback / feedback-changed in
// renderer/ipc.js; the settings-feedback.js toggle writes it immediately too). Everything ON by default (`contrast` OFF) — the file works
// even before the query.

// Raw (IPC) feedback object → full, typed state. `sound`/`rumble`/`motion` default ON (`!== false`), `contrast` default OFF (`=== true`).
// All three load sites of renderer/ipc.js call this (no 3× duplicated inline object literal).
function normalizeFeedback(raw) {
    const r = raw || {};
    return {
        sound: r.sound !== false,
        rumble: r.rumble !== false,
        motion: r.motion !== false,
        contrast: r.contrast === true,
        slowRepeat: r.slowRepeat === true,
        screenReader: r.screenReader === true,
    };
}

// Synthesized blips: a short oscillator burst with exponential decay. `nav` is deliberately barely audible, `launch` the most pronounced,
// `back` muted/low.
const SFX = {
    nav: { freq: 380, type: 'sine', dur: 0.03, gain: 0.04 },
    launch: { freq: 560, type: 'triangle', dur: 0.14, gain: 0.09 },
    back: { freq: 200, type: 'sine', dur: 0.06, gain: 0.06 },
};

// dual-rumble effects. `nav` is very short + weak (the DualSense rumbles with a delay over BT, it must not pile up on fast scrolling);
// `launch` is a noticeable dual-motor bump.
const RUMBLE = {
    nav: { duration: 12, weakMagnitude: 0.2, strongMagnitude: 0 },
    launch: { duration: 90, weakMagnitude: 0.55, strongMagnitude: 0.7 },
    back: { duration: 18, weakMagnitude: 0.35, strongMagnitude: 0 },
};

// Throttle: on fast card scrolling / button repeat it must not sound on every frame.
const FEEDBACK_THROTTLE_MS = 55;
let _lastFeedbackAt = 0;

let _audioCtx = null;
function _ctx() {
    if (_audioCtx) return _audioCtx;
    if (typeof AudioContext === 'function') _audioCtx = new AudioContext();
    return _audioCtx;
}

function playSfx(kind) {
    const spec = SFX[kind];
    const ctx = _ctx();
    if (!spec || !ctx) return;
    try {
        if (ctx.state === 'suspended') ctx.resume();
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = spec.type;
        osc.frequency.setValueAtTime(spec.freq, t);
        gain.gain.setValueAtTime(spec.gain, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + spec.dur + 0.02);
    } catch (_) { /* audio is not critical */ }
}

function rumble(kind) {
    const spec = RUMBLE[kind];
    if (!spec || !navigator.getGamepads) return;
    for (const p of navigator.getGamepads()) {
        if (!p || !p.connected) continue;
        const act = p.vibrationActuator;
        if (act && typeof act.playEffect === 'function') {
            // playEffect() returns a Promise that may reject asynchronously (e.g. the actuator is busy / the effect is not supported by the hardware)
            // — try/catch only catches a SYNCHRONOUS throw. An uncaught async rejection would trigger `unhandledrejection` (often with an `undefined`
            // reason -> the global error overlay pops up with "unknown error" on EVERY button press, see renderer/errors.js) — the `.catch` silences
            // it, best effort (rumble is not a critical feature).
            try {
                const p2 = act.playEffect('dual-rumble', { startDelay: 0, ...spec });
                if (p2 && typeof p2.catch === 'function') p2.catch(() => { /* best effort */ });
            } catch (_) { /* best effort */ }
        }
    }
}

// The shared entry point - navList / gamepad.js call it ('nav' | 'launch' | 'back'). `opts.repeated` = repeat of a held direction
// (edgeRepeat): sound only, no rumble — a held button must not rumble the controller all the way.
function feedback(kind, opts) {
    const now = Date.now();
    if (now - _lastFeedbackAt < FEEDBACK_THROTTLE_MS) return;
    _lastFeedbackAt = now;
    if (feedbackState.sound) playSfx(kind);
    if (feedbackState.rumble && !(opts && opts.repeated)) rumble(kind);
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { normalizeFeedback });
}
