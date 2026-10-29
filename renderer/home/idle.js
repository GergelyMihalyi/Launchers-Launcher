// Idle screensaver: after X minutes of gamepad inactivity a black overlay where the icons of the active launchers spin and bounce + a faint,
// ALSO bouncing clock (a static overlay is itself a burn-in risk on OLED). `lastInputAt`/`noteActivity(gp)` run at the start of
// `pollGamepad()` every frame — any button/stick movement resets it immediately. FOCUS-DEPENDENT: only starts and counts with a focused
// window; on focus return it counts FROM ZERO (`resolveIdleFocus()` detects the edge). `isIdle`/`stepAxis`/`resolveIdleFocus` are pure
// (test/home/idle.test.js). Background: docs/dev/renderer/home.md#screensaver

// The idle time is the Settings → Appearance → "Screensaver" picker (`idleTimeout` pref, in minutes, 0 = off) — loaded and refreshed by
// renderer/ipc.js through `setIdleTimeoutMinutes()`. Default: 3 minutes.
let idleMs = 3 * 60 * 1000;

function setIdleTimeoutMinutes(minutes) {
    idleMs = minutes > 0 ? minutes * 60 * 1000 : 0;
}

const ATTRACT_ICON_SIZE = 64; // px, see .attract-icon (styles/*.css)
const ATTRACT_SPEED_MIN = 80; // px/s
const ATTRACT_SPEED_MAX = 150;
const ATTRACT_SPIN_MIN = 30; // deg/s
const ATTRACT_SPIN_MAX = 60;
const ATTRACT_CLOCK_SPEED = 55; // px/s - the clock floats slower than the icons

let idleVisible = false;
let idleHadFocus = true; // whether the window was focused in the previous checkIdle() round (for edge detection)
let attractIcons = [];
let attractClock = null; // { el, x, y, vx, vy, w, h } - the bouncing clock (does not spin, readable)
let attractClockText = '';
let attractFrameHandle = null;
let attractLastTs = null;

function isIdle(lastInputAt, now, thresholdMs) {
    return now - lastInputAt >= thresholdMs;
}

// Processes the focus state transition (pure function): returns whether the screensaver logic should RUN this round (`run`), the next
// round's `hadFocus`, and `lastInputAt` - which is reset to `now` on focus RETURN (`!hadFocus -> hasFocus`), so the time spent in the
// background (while playing) does not count toward the screensaver time.
function resolveIdleFocus(hasFocus, hadFocus, now, lastInputAt) {
    if (!hasFocus) return { run: false, hadFocus: false, lastInputAt };
    if (!hadFocus) return { run: true, hadFocus: true, lastInputAt: now };
    return { run: true, hadFocus: true, lastInputAt };
}

// One axis (x OR y) step + "DVD logo" wall bounce: if the move would take the icon out of [0, boundMax - size], the position is clamped to
// the bound and the velocity flips sign. Pure function (no DOM/Date.now) - `dt` and the velocity (`v`, px/s) are explicit parameters, so
// it is deterministically testable.
function stepAxis(pos, v, dt, size, boundMax) {
    let next = pos + v * dt;
    const max = Math.max(0, boundMax - size);
    if (next < 0) { next = 0; v = -v; }
    else if (next > max) { next = max; v = -v; }
    return { pos: next, v };
}

function randRange(min, max) {
    return min + Math.random() * (max - min);
}

function randSigned(min, max) {
    return (Math.random() < 0.5 ? -1 : 1) * randRange(min, max);
}

// The icons of the active (actually launchable) launchers - `launchers` is the global of renderer/home/carousel.js; the "Games" pseudo
// card (GAMES_CARD) is deliberately left out, since it is not a launcher.
function spawnAttractIcons() {
    const overlay = $('idleOverlay');
    const w = window.innerWidth;
    const h = window.innerHeight;
    attractIcons = launchers.map((l) => {
        const el = document.createElement('img');
        el.className = 'attract-icon';
        el.src = l.icon;
        el.alt = '';
        el.addEventListener('error', () => { el.src = FALLBACK_ICON; }, { once: true });
        overlay.appendChild(el);
        return {
            el,
            x: randRange(0, Math.max(0, w - ATTRACT_ICON_SIZE)),
            y: randRange(0, Math.max(0, h - ATTRACT_ICON_SIZE)),
            vx: randSigned(ATTRACT_SPEED_MIN, ATTRACT_SPEED_MAX),
            vy: randSigned(ATTRACT_SPEED_MIN, ATTRACT_SPEED_MAX),
            rot: randRange(0, 360),
            vr: randSigned(ATTRACT_SPIN_MIN, ATTRACT_SPIN_MAX),
        };
    });
    spawnAttractClock(overlay, w, h);
    attractLastTs = null;
    attractFrameHandle = requestAnimationFrame(attractTick);
}

// A discreet, faint clock next to the spinning icons - it BOUNCES too (a static clock would itself be a burn-in risk on OLED), but does
// NOT spin (readability) and moves slower. Its size is measured after rendering (the font/`vh` clamp decides it), like the carousel's
// measured card width.
function spawnAttractClock(overlay, w, h) {
    const el = document.createElement('div');
    el.className = 'attract-clock';
    attractClockText = formatClock(new Date());
    el.textContent = attractClockText;
    overlay.appendChild(el);
    const cw = el.offsetWidth || 200;
    const ch = el.offsetHeight || 80;
    attractClock = {
        el,
        x: randRange(0, Math.max(0, w - cw)),
        y: randRange(0, Math.max(0, h - ch)),
        vx: randSigned(ATTRACT_CLOCK_SPEED * 0.8, ATTRACT_CLOCK_SPEED * 1.2),
        vy: randSigned(ATTRACT_CLOCK_SPEED * 0.8, ATTRACT_CLOCK_SPEED * 1.2),
        w: cw,
        h: ch,
    };
}

function attractTick(ts) {
    if (attractLastTs === null) attractLastTs = ts;
    // A possible big frame drop (tab switch, GC pause) is counted as at most 50 ms, so the icon does not "teleport" after a long pause.
    const dt = Math.min(0.05, (ts - attractLastTs) / 1000);
    attractLastTs = ts;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const icon of attractIcons) {
        const stepX = stepAxis(icon.x, icon.vx, dt, ATTRACT_ICON_SIZE, w);
        icon.x = stepX.pos;
        icon.vx = stepX.v;
        const stepY = stepAxis(icon.y, icon.vy, dt, ATTRACT_ICON_SIZE, h);
        icon.y = stepY.pos;
        icon.vy = stepY.v;
        icon.rot = (icon.rot + icon.vr * dt) % 360;
        icon.el.style.transform = `translate(${icon.x}px, ${icon.y}px) rotate(${icon.rot}deg)`;
    }
    if (attractClock) {
        const c = attractClock;
        const sx = stepAxis(c.x, c.vx, dt, c.w, w);
        c.x = sx.pos; c.vx = sx.v;
        const sy = stepAxis(c.y, c.vy, dt, c.h, h);
        c.y = sy.pos; c.vy = sy.v;
        c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
        const t = formatClock(new Date());
        if (t !== attractClockText) { attractClockText = t; c.el.textContent = t; }
    }
    attractFrameHandle = requestAnimationFrame(attractTick);
}

function stopAttractIcons() {
    if (attractFrameHandle) { cancelAnimationFrame(attractFrameHandle); attractFrameHandle = null; }
    $('idleOverlay').innerHTML = '';
    attractIcons = [];
    attractClock = null;
}

function showIdleOverlay() {
    idleVisible = true;
    spawnAttractIcons();
    $('idleOverlay').classList.add('visible');
}

function hideIdleOverlay() {
    idleVisible = false;
    stopAttractIcons();
    $('idleOverlay').classList.remove('visible');
}

// The launcher window lost the focus (blur - hiding on a game launch, or another window came forward). `checkIdle()` is a no-op from
// here anyway, BUT while the window is hidden requestAnimationFrame (and with it pollGamepad/checkIdle) is paused, so no round would notice
// the focus loss -> the `blur` event explicitly signals that the first `checkIdle()` on return should count from zero. Wired by
// renderer/main.js.
function onLauncherBlur() {
    idleHadFocus = false;
    if (idleVisible) hideIdleOverlay();
}

function checkIdle() {
    // The screensaver ONLY counts/starts with a focused window. `document.hasFocus()` covers both the "hidden (game running)" AND the "another
    // window is in front" cases; on focus return `resolveIdleFocus` resets `lastInputAt` to `now` -> a fresh count.
    const f = resolveIdleFocus(document.hasFocus(), idleHadFocus, Date.now(), lastInputAt);
    idleHadFocus = f.hadFocus;
    lastInputAt = f.lastInputAt;
    // Idle suspend / controller disconnect (renderer/home/idle-power.js) — the same focus decision and timestamp, regardless of whether the
    // screensaver is on or off.
    checkIdlePower(f.run, Date.now(), lastInputAt);
    if (!f.run || !idleMs) {
        if (idleVisible) hideIdleOverlay();
        return;
    }
    const idle = isIdle(lastInputAt, Date.now(), idleMs);
    if (idle && !idleVisible) showIdleOverlay();
    else if (!idle && idleVisible) hideIdleOverlay();
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { isIdle, stepAxis, resolveIdleFocus });
}
