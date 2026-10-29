'use strict';

// lib/evdev-pads.js — the pure parts of the PS-combo controller identification + the watcher on a
// temp sysfs/dev tree (a plain file readable in non-blocking mode instead of the /dev node).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers/fs.js');
const ev = require('../lib/evdev-pads.js');

// DualSense key capabilities measured on the machine (input39).
const DUALSENSE_CAPS = '7fdb000000000000 0 0 0 0';

function evBuf(events) {
    const b = Buffer.alloc(ev.EVENT_SIZE * events.length);
    events.forEach(([type, code, value], i) => {
        b.writeUInt16LE(type, i * 24 + 16);
        b.writeUInt16LE(code, i * 24 + 18);
        b.writeInt32LE(value, i * 24 + 20);
    });
    return b;
}

test('hasKeyBit: DualSense caps — BTN_GAMEPAD + BTN_MODE yes, BTN_C no', () => {
    assert.equal(ev.hasKeyBit(DUALSENSE_CAPS, ev.BTN_GAMEPAD), true);
    assert.equal(ev.hasKeyBit(DUALSENSE_CAPS, ev.BTN_MODE), true);
    assert.equal(ev.hasKeyBit(DUALSENSE_CAPS, 0x132), false);
    assert.equal(ev.hasKeyBit('0', ev.BTN_GAMEPAD), false);
    assert.equal(ev.hasKeyBit('', ev.BTN_MODE), false);
    assert.equal(ev.hasKeyBit('zz', 0), false);
});

test('normalizeUniq: MAC uppercased, empty/null/garbage → null', () => {
    assert.equal(ev.normalizeUniq('02:00:00:00:00:a1\n'), '02:00:00:00:00:A1');
    assert.equal(ev.normalizeUniq(''), null);
    assert.equal(ev.normalizeUniq('000000000000'), null);
    assert.equal(ev.normalizeUniq('00:00:00:00:00:00'), null);
    assert.equal(ev.normalizeUniq('usb-0000:00:14.0-1'), null);
});

test('parseInputEvents + applyEvents: PS down/up, face-button timestamp, SYN_DROPPED resets', () => {
    const events = ev.parseInputEvents(evBuf([[1, ev.BTN_MODE, 1], [1, 0x134, 1], [0, 0, 0]]));
    assert.deepEqual(events[0], { type: 1, code: ev.BTN_MODE, value: 1 });
    const st = ev.applyEvents(ev.emptyPadState(), events, 1000);
    assert.deepEqual(st, { ps: true, lastFaceAt: 1000 });
    ev.applyEvents(st, [{ type: 1, code: 0x134, value: 0 }], 1100); // release does not update
    assert.equal(st.lastFaceAt, 1000);
    ev.applyEvents(st, [{ type: 1, code: 0x130, value: 2 }], 1200); // nor autorepeat
    assert.equal(st.lastFaceAt, 1000);
    ev.applyEvents(st, [{ type: 0, code: ev.SYN_DROPPED, value: 0 }], 1300);
    assert.deepEqual(st, { ps: false, lastFaceAt: 0 });
    // Truncated buffer: only the complete 24-byte records.
    assert.equal(ev.parseInputEvents(Buffer.alloc(30)).length, 1);
});

test('pickComboPad: exactly 1 hit → MAC; 0 / 2+ / expired window → none', () => {
    const a = { mac: 'AA:AA:AA:AA:AA:AA', state: { ps: true, lastFaceAt: 900 } };
    const b = { mac: 'BB:BB:BB:BB:BB:BB', state: { ps: false, lastFaceAt: 950 } };
    assert.deepEqual(ev.pickComboPad([a, b], 1000), { matched: true, mac: a.mac });
    assert.deepEqual(ev.pickComboPad([a, { ...b, state: { ps: true, lastFaceAt: 990 } }], 1000), { matched: false, mac: null });
    assert.deepEqual(ev.pickComboPad([a], 900 + ev.COMBO_WINDOW_MS + 1), { matched: false, mac: null });
    assert.deepEqual(ev.pickComboPad([{ mac: 'CC:CC:CC:CC:CC:CC', state: { ps: true, lastFaceAt: 0 } }], 1000), { matched: false, mac: null });
    assert.deepEqual(ev.pickComboPad([{ mac: null, state: { ps: true, lastFaceAt: 990 } }], 1000), { matched: true, mac: null });
    assert.deepEqual(ev.pickComboPad([], 1000), { matched: false, mac: null });
});

function makeTree() {
    const root = tmpDir('evdev-');
    const sys = path.join(root, 'sys');
    const dev = path.join(root, 'dev');
    fs.mkdirSync(dev, { recursive: true });
    const add = (n, { caps, uniq, name, event }) => {
        const d = path.join(sys, n);
        fs.mkdirSync(path.join(d, 'capabilities'), { recursive: true });
        fs.writeFileSync(path.join(d, 'capabilities', 'key'), caps + '\n');
        if (uniq != null) fs.writeFileSync(path.join(d, 'uniq'), uniq + '\n');
        fs.writeFileSync(path.join(d, 'name'), name + '\n');
        if (event) {
            fs.mkdirSync(path.join(d, event));
            fs.writeFileSync(path.join(dev, event), '');
        }
    };
    add('input39', { caps: DUALSENSE_CAPS, uniq: '02:00:00:00:00:a1', name: 'DualSense Wireless Controller', event: 'event20' });
    add('input40', { caps: '0', uniq: '02:00:00:00:00:a1', name: 'DualSense Wireless Controller Motion Sensors', event: 'event27' });
    add('input3', { caps: '1000 0 0', uniq: '000000000000', name: 'Headset', event: 'event3' });
    add('input50', { caps: DUALSENSE_CAPS, uniq: '', name: 'Generic USB Pad', event: 'event30' });
    fs.writeFileSync(path.join(sys, 'notinput'), '');
    return { root, sys, dev };
}

test('listGamepadInputs: only the gamepad class, with / without MAC', () => {
    const t = makeTree();
    try {
        const list = ev.listGamepadInputs(t.sys, t.dev).sort((x, y) => x.eventPath.localeCompare(y.eventPath));
        assert.deepEqual(list, [
            { eventPath: path.join(t.dev, 'event20'), mac: '02:00:00:00:00:A1', name: 'DualSense Wireless Controller' },
            { eventPath: path.join(t.dev, 'event30'), mac: null, name: 'Generic USB Pad' },
        ]);
        assert.deepEqual(ev.listGamepadInputs(path.join(t.root, 'missing'), t.dev), []);
    } finally {
        fs.rmSync(t.root, { recursive: true, force: true });
    }
});

test('createEvdevPads.resolveComboPad: the MAC of the pressing device from the event file', () => {
    const t = makeTree();
    let clock = 5000;
    const pads = ev.createEvdevPads({ sysRoot: t.sys, devRoot: t.dev, now: () => clock });
    try {
        assert.deepEqual(pads.resolveComboPad(), { ok: true, matched: false, mac: null });
        fs.appendFileSync(path.join(t.dev, 'event20'), evBuf([[1, ev.BTN_MODE, 1], [1, 0x133, 1], [0, 0, 0]]));
        assert.deepEqual(pads.resolveComboPad(), { ok: true, matched: true, mac: '02:00:00:00:00:A1' });
        clock += ev.COMBO_WINDOW_MS + 10; // the window has expired
        assert.deepEqual(pads.resolveComboPad(), { ok: true, matched: false, mac: null });
    } finally {
        pads.stop();
        fs.rmSync(t.root, { recursive: true, force: true });
    }
});

test('createEvdevPads: no gamepad → ok:false', () => {
    const root = tmpDir('evdev-empty-');
    const pads = ev.createEvdevPads({ sysRoot: root, devRoot: root });
    try {
        assert.deepEqual(pads.resolveComboPad(), { ok: false, matched: false, mac: null });
    } finally {
        pads.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
