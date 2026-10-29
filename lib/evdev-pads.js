// @ts-check
'use strict';

// EXACT controller identification for the PS combos (PS + Circle/Triangle/Square): the Gamepad API shows no MAC, but the kernel puts the
// BT MAC into the input device's `uniq` sysfs field, and `/dev/input/eventN` is readable through logind's `uaccess` ACL (no sudo).
// On NON-BLOCKING (`O_NONBLOCK`) fds, on the main thread, it drains the events every `pollMs` (synchronous `fs.readSync` → EAGAIN) and
// tracks per device: is PS (`BTN_MODE`) held, and when was a face button last pressed. `resolveComboPad()` drains once more before
// deciding. It does not "grab". The face-button match DELIBERATELY does not filter on specific codes (driver mappings differ).
// Background: docs/dev/devices.md#which-pad-pressed-the-ps-combo-evdev

const fs = require('fs');
const path = require('path');

const EV_SYN = 0;
const EV_KEY = 1;
const SYN_DROPPED = 3;
const BTN_GAMEPAD = 0x130; // = BTN_SOUTH — the gamepad-class marker in the capabilities
const BTN_MODE = 0x13c;    // PS / Xbox / Home button
const FACE_MIN = 0x130;    // BTN_SOUTH..BTN_WEST (0x130..0x134)
const FACE_MAX = 0x134;
const EVENT_SIZE = 24;     // struct input_event x86_64-en: timeval (16) + u16 type + u16 code + s32 value
const COMBO_WINDOW_MS = 600;

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

/**
 * Is `bit` set in the sysfs `capabilities/key` bitmask of hex words (most significant word first,
 * 64 bits per word).
 * @param {string} capsHex
 * @param {number} bit
 */
function hasKeyBit(capsHex, bit) {
    const words = String(capsHex || '').trim().split(/\s+/).filter(Boolean).reverse();
    const word = words[Math.floor(bit / 64)];
    if (!word) return false;
    try {
        return ((BigInt('0x' + word) >> BigInt(bit % 64)) & 1n) === 1n;
    } catch {
        return false;
    }
}

/** @param {string} s @returns {string|null} uppercase MAC or null (empty / 000000000000 / not a MAC) */
function normalizeUniq(s) {
    const v = String(s || '').trim().toUpperCase();
    if (!MAC_RE.test(v) || v === '00:00:00:00:00:00') return null;
    return v;
}

/**
 * @param {Buffer} buf
 * @param {number} [len]
 * @returns {{ type: number, code: number, value: number }[]}
 */
function parseInputEvents(buf, len = buf.length) {
    const out = [];
    for (let off = 0; off + EVENT_SIZE <= len; off += EVENT_SIZE) {
        out.push({
            type: buf.readUInt16LE(off + 16),
            code: buf.readUInt16LE(off + 18),
            value: buf.readInt32LE(off + 20),
        });
    }
    return out;
}

/** @returns {{ ps: boolean, lastFaceAt: number }} */
function emptyPadState() {
    return { ps: false, lastFaceAt: 0 };
}

/**
 * @param {{ ps: boolean, lastFaceAt: number }} state  (mutated in place)
 * @param {{ type: number, code: number, value: number }[]} events
 * @param {number} now
 */
function applyEvents(state, events, now) {
    for (const ev of events) {
        if (ev.type === EV_SYN && ev.code === SYN_DROPPED) {
            // The kernel buffer overflowed — the button state is uncertain, reset conservatively.
            state.ps = false;
            state.lastFaceAt = 0;
        } else if (ev.type === EV_KEY) {
            if (ev.code === BTN_MODE) state.ps = ev.value !== 0;
            else if (ev.code >= FACE_MIN && ev.code <= FACE_MAX && ev.value === 1) state.lastFaceAt = now;
        }
    }
    return state;
}

/**
 * On which device is PS held NOW, with a face button pressed within `windowMs`?
 * Exactly 1 match → `{ matched: true, mac }` (`mac` may be `null`: a pad without a MAC, e.g. a
 * generic USB pad); 0 or 2+ → `{ matched: false, mac: null }` (no guessing).
 * @param {{ mac: string|null, state: { ps: boolean, lastFaceAt: number } }[]} devices
 * @param {number} now
 * @param {number} [windowMs]
 */
function pickComboPad(devices, now, windowMs = COMBO_WINDOW_MS) {
    const hits = (devices || []).filter((d) => d.state.ps && d.state.lastFaceAt > 0 && now - d.state.lastFaceAt <= windowMs);
    if (hits.length !== 1) return { matched: false, mac: null };
    return { matched: true, mac: hits[0].mac };
}

/**
 * The gamepad-class input devices (BTN_GAMEPAD AND BTN_MODE in the key capabilities — this drops
 * the DualSense "Motion Sensors"/"Touchpad" sub-devices) + their MACs.
 * @param {string} [sysRoot]
 * @param {string} [devRoot]
 * @returns {{ eventPath: string, mac: string|null, name: string }[]}
 */
function listGamepadInputs(sysRoot = '/sys/class/input', devRoot = '/dev/input') {
    let entries;
    try {
        entries = fs.readdirSync(sysRoot).filter((n) => /^input\d+$/.test(n));
    } catch {
        return [];
    }
    const out = [];
    for (const n of entries) {
        const dir = path.join(sysRoot, n);
        try {
            const caps = fs.readFileSync(path.join(dir, 'capabilities', 'key'), 'utf8');
            if (!hasKeyBit(caps, BTN_GAMEPAD) || !hasKeyBit(caps, BTN_MODE)) continue;
            const ev = fs.readdirSync(dir).find((x) => /^event\d+$/.test(x));
            if (!ev) continue;
            let uniq = '';
            let name = '';
            try { uniq = fs.readFileSync(path.join(dir, 'uniq'), 'utf8'); } catch { /* no uniq */ }
            try { name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim(); } catch { /* no name */ }
            out.push({ eventPath: path.join(devRoot, ev), mac: normalizeUniq(uniq), name });
        } catch {
            // vanished meanwhile / unreadable — skipped
        }
    }
    return out;
}

/**
 * @param {Object} [deps]
 * @param {import('./types.js').Logger} [deps.log]
 * @param {string} [deps.sysRoot]
 * @param {string} [deps.devRoot]
 * @param {number} [deps.pollMs]
 * @param {number} [deps.rescanMs]
 * @param {() => number} [deps.now]
 */
function createEvdevPads({
    log = () => {}, sysRoot = '/sys/class/input', devRoot = '/dev/input',
    pollMs = 50, rescanMs = 2000, now = Date.now,
} = {}) {
    /** @type {Map<string, { fd: number, mac: string|null, name: string, state: { ps: boolean, lastFaceAt: number } }>} */
    const devices = new Map(); // eventPath -> open device
    /** @type {Set<string>} */
    const failedPaths = new Set(); // already failed to open once (e.g. EACCES) — do not log on every rescan
    const buf = Buffer.alloc(EVENT_SIZE * 64);
    /** @type {any} */
    let pollTimer = null;
    let lastRescan = 0;

    /** @param {string} p */
    function closeDevice(p) {
        const d = devices.get(p);
        if (!d) return;
        try { fs.closeSync(d.fd); } catch { /* already closed */ }
        devices.delete(p);
    }

    function rescan() {
        lastRescan = now();
        const found = listGamepadInputs(sysRoot, devRoot);
        const foundPaths = new Set(found.map((f) => f.eventPath));
        for (const p of Array.from(devices.keys())) {
            if (!foundPaths.has(p)) closeDevice(p);
        }
        for (const f of found) {
            if (devices.has(f.eventPath)) continue;
            try {
                const fd = fs.openSync(f.eventPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
                devices.set(f.eventPath, { fd, mac: f.mac, name: f.name, state: emptyPadState() });
                failedPaths.delete(f.eventPath);
                log(`[evdev-pads] watching: ${f.name || '?'} (${f.mac || 'no MAC'}) — ${f.eventPath}`);
            } catch (err) {
                if (!failedPaths.has(f.eventPath)) {
                    failedPaths.add(f.eventPath);
                    log(`[evdev-pads] cannot open: ${f.eventPath}: ${err && err.message}`);
                }
            }
        }
    }

    function drain() {
        const t = now();
        for (const [p, d] of Array.from(devices.entries())) {
            for (;;) {
                let n;
                try {
                    n = fs.readSync(d.fd, buf, 0, buf.length, null);
                } catch (err) {
                    if (err && err.code === 'EAGAIN') break;
                    closeDevice(p); // ENODEV — disconnected
                    break;
                }
                if (!n) break;
                applyEvents(d.state, parseInputEvents(buf, n), t);
                if (n < buf.length) break;
            }
        }
    }

    function tick() {
        if (now() - lastRescan >= rescanMs) rescan();
        drain();
    }

    function start() {
        if (pollTimer) return;
        rescan();
        pollTimer = setInterval(tick, pollMs);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
    }

    function stop() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        for (const p of Array.from(devices.keys())) closeDevice(p);
    }

    /** @returns {{ ok: boolean, matched: boolean, mac: string|null }} */
    function resolveComboPad() {
        if (!devices.size) rescan();
        drain();
        const list = Array.from(devices.values()).map((d) => ({ mac: d.mac, state: d.state }));
        if (!list.length) return { ok: false, matched: false, mac: null };
        return { ok: true, ...pickComboPad(list, now()) };
    }

    return { start, stop, resolveComboPad, tick };
}

module.exports = {
    EV_KEY, EV_SYN, SYN_DROPPED, BTN_GAMEPAD, BTN_MODE, EVENT_SIZE, COMBO_WINDOW_MS,
    hasKeyBit, normalizeUniq, parseInputEvents, emptyPadState, applyEvents, pickComboPad,
    listGamepadInputs, createEvdevPads,
};
