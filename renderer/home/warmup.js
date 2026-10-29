// The spinning launcher icon in the bottom-left corner (`#warmupSpinner`) showing the startup warmup of the Games panel (main:
// `lib/games/games-warmup.js`). Flicker guard: only appears if the warmup takes longer than `WARMUP_SHOW_DELAY_MS`. `renderer/ipc.js` wires
// it to the `games-warmup-state` push + queries the current state at startup. The top level does not touch `window`/`document`
// (test/home/warmup.test.js).

const WARMUP_SHOW_DELAY_MS = 400;

let warmupTimer = null;
let warmupVisible = false;

// Pure decision: what to do with the new `running` value, given the scheduled-show (`timerPending`) and the visible (`visible`) state.
function warmupAction(running, timerPending, visible) {
    if (running) return (timerPending || visible) ? 'none' : 'schedule';
    if (timerPending) return 'cancel';
    if (visible) return 'hide';
    return 'none';
}

function setWarmupVisible(on) {
    warmupVisible = on;
    const el = $('warmupSpinner');
    if (el) el.hidden = !on;
}

// `state` = `{ running, done, total }` from main's `games-warmup-state` push / invoke.
function applyWarmupState(state) {
    const running = !!(state && state.running);
    const action = warmupAction(running, warmupTimer !== null, warmupVisible);
    if (action === 'schedule') {
        warmupTimer = setTimeout(() => {
            warmupTimer = null;
            setWarmupVisible(true);
        }, WARMUP_SHOW_DELAY_MS);
    } else if (action === 'cancel') {
        clearTimeout(warmupTimer);
        warmupTimer = null;
    } else if (action === 'hide') {
        setWarmupVisible(false);
    }
}

if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { warmupAction, WARMUP_SHOW_DELAY_MS });
