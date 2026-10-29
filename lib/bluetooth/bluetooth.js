// @ts-check
'use strict';

// Bluetooth device handling (`bluetoothctl`) — headphones AND controllers through one shared, `kind`-based mechanism. No
// `BrowserWindow` reference; `performBtAction`/`performBtPair` RETURN the fresh device list (payload), the caller sends it with
// `sendToRenderer` — the module does not know IPC.

const { classifyController } = require('../../controller-id.js'); // shared with the renderer
const { parsePairedMacs, btInfoField, parseBattery, parseUpowerBattery } = require('../parse.js');
const { checkParsed } = require('../host-deps/format-drift.js');
const { execFileAsync, EXEC_TIMEOUT_MS, BT_TIMEOUT_OPTS, toLogger } = require('../exec.js');
const { BT_PAIR_TIMEOUT_MS, BT_SCAN_GRACE_MS } = require('../timings.js');

// Device discovery + pairing started from the UI. `--timeout N scan on` runs for N s and then exits by itself; pairing is
// `pair` + `trust` + `connect` (the pairing agent is NoInputNoOutput → "Just Works" devices only, PIN devices are left out).
const BT_SCAN_SECONDS = 10;

// Which `Icon:` values are accepted on discovery per `kind` (the Icon of a discovered, not yet paired device comes from the Class of
// Device — reliably `input-gaming` for a controller, several variants for headphones).
const DISCOVER_ICONS = {
    headset: ['audio-headset', 'audio-headphones', 'audio-card'],
    controller: ['input-gaming'],
};

// Pure helper (tests): does a discovered device blob match the `kind` + is it not paired yet. `paired` = Set of paired MACs.
function isDiscoverCandidate(kind, mac, info, paired) {
    if (!info || (paired && paired.has(mac))) return false;
    if (btInfoField(info, 'Paired') === 'yes') return false;
    const wanted = Object.hasOwn(DISCOVER_ICONS, kind) ? DISCOVER_ICONS[kind] : undefined;
    return !!wanted && wanted.includes(btInfoField(info, 'Icon'));
}

// Every paired BT device + its `bluetoothctl info <mac>` output. The `Icon:` field reliably tells the types apart: `audio-headset` is
// headphones, `input-gaming` a controller, etc. - filter only on this, never on the name/Class.
async function listPairedDevices() {
    const { stdout } = await execFileAsync('bluetoothctl', ['devices', 'Paired'], { timeout: EXEC_TIMEOUT_MS });
    const macs = parsePairedMacs(stdout);
    checkParsed('bluetoothctl-paired', stdout, macs.length);
    const infos = await Promise.all(macs.map((mac) =>
        execFileAsync('bluetoothctl', ['info', mac], { timeout: EXEC_TIMEOUT_MS }).catch(() => null)
    ));
    return macs
        .map((mac, i) => ({ mac, info: infos[i] ? infos[i].stdout : null }))
        .filter((d) => d.info);
}

// The headphone and controller subviews use the same, by `kind` (the filter goes on the `Icon:` field).
const BT_DEVICE_KINDS = {
    headset: { icon: 'audio-headset' },
    controller: { icon: 'input-gaming' },
};

// Controller type detection lives in `controller-id.js` (shared with the renderer) — here we give it a text blob from the Modalias +
// Name fields of `bluetoothctl info`.
function detectControllerType(name, info) {
    return classifyController((btInfoField(info, 'Modalias') || '') + ' ' + (name || ''));
}

// Full `upower -d` dump - for the `parseUpowerBattery()` fallback. Best effort (no upower / timeout -> null, the caller uses the
// bluetoothctl battery / shows nothing).
async function upowerDump() {
    try {
        const { stdout } = await execFileAsync('upower', ['-d'], { timeout: EXEC_TIMEOUT_MS });
        return stdout;
    } catch (_) {
        return null;
    }
}

async function listBluetoothDevices(kind) {
    const wanted = Object.hasOwn(BT_DEVICE_KINDS, kind) ? BT_DEVICE_KINDS[kind] : undefined;
    if (!wanted) return [];
    const devices = await listPairedDevices();
    const result = [];
    for (const { mac, info } of devices) {
        if (btInfoField(info, 'Icon') !== wanted.icon) continue;
        const name = btInfoField(info, 'Name') || mac;
        const connected = btInfoField(info, 'Connected') === 'yes';
        const entry = { mac, name, connected };
        if (kind === 'controller') {
            entry.type = detectControllerType(name, info);
            entry.battery = connected ? parseBattery(info) : null;
        }
        result.push(entry);
    }
    // Battery fallback: for connected controllers that got no battery from bluetoothctl (typically the DualSense - no GATT Battery Service
    // over BT), from UPower. One `upower -d` call for all of them (not per device).
    if (kind === 'controller' && result.some((e) => e.connected && e.battery == null)) {
        const dump = await upowerDump();
        if (dump) {
            for (const e of result) {
                if (e.connected && e.battery == null) e.battery = parseUpowerBattery(dump, e.mac);
            }
        }
    }
    return result;
}

// Connect/disconnect + the fresh device list packed together - the caller sends it as `bt-device-changed`. `log` is optional.
async function performBtAction(kind, action, mac, log) {
    const emit = toLogger(log);
    let success = true;
    try {
        await execFileAsync('bluetoothctl', [action, mac], BT_TIMEOUT_OPTS);
    } catch (err) {
        success = false;
        emit(`BT ${action} error (${mac}): ${err.message}`);
    }
    const devices = await listBluetoothDevices(kind).catch(() => []);
    const device = devices.find((d) => d.mac === mac);
    return { kind, success, action, mac, name: device ? device.name : mac, devices };
}

// Device discovery started from the UI: `bluetoothctl --timeout N scan on` (exits by itself after N s), then among all known devices of
// `bluetoothctl devices` the NOT yet paired ones whose Icon matches `kind`. Best effort — error → empty list, does not throw.
async function discoverDevices(kind, log) {
    const emit = toLogger(log);
    if (!Object.hasOwn(DISCOVER_ICONS, kind) || !DISCOVER_ICONS[kind]) return [];
    try {
        await execFileAsync('bluetoothctl', ['--timeout', String(BT_SCAN_SECONDS), 'scan', 'on'],
            { timeout: BT_SCAN_SECONDS * 1000 + BT_SCAN_GRACE_MS });
    } catch (err) {
        emit(`BT scan error: ${err.message}`);
    }
    const paired = new Set((await listPairedDevices().catch(() => [])).map((d) => d.mac));
    let macs = [];
    try {
        const { stdout } = await execFileAsync('bluetoothctl', ['devices'], { timeout: EXEC_TIMEOUT_MS });
        macs = parsePairedMacs(stdout); // the same "Device <mac> <name>" line format
    } catch (err) {
        emit(`BT devices error: ${err.message}`);
    }
    const infos = await Promise.all(macs.map((mac) =>
        execFileAsync('bluetoothctl', ['info', mac], { timeout: EXEC_TIMEOUT_MS }).catch(() => null)));
    const out = [];
    macs.forEach((mac, i) => {
        const info = infos[i] ? infos[i].stdout : null;
        if (!isDiscoverCandidate(kind, mac, info, paired)) return;
        out.push({ mac, name: btInfoField(info, 'Name') || mac, icon: btInfoField(info, 'Icon') });
    });
    return out;
}

// Pairing from the UI: `pair` → `trust` → `connect` (a `trust` error is not fatal). The pairing agent is NoInputNoOutput (Just Works) — a
// device needing PIN/passkey entry fails here (`success: false`); an on-screen-keyboard branch is a separate task.
async function performBtPair(kind, mac, log) {
    const emit = toLogger(log);
    let success = true;
    let stage = 'pair';
    try {
        await execFileAsync('bluetoothctl', ['pair', mac], { timeout: BT_PAIR_TIMEOUT_MS });
        stage = 'trust';
        await execFileAsync('bluetoothctl', ['trust', mac], BT_TIMEOUT_OPTS).catch(() => {});
        stage = 'connect';
        await execFileAsync('bluetoothctl', ['connect', mac], BT_TIMEOUT_OPTS);
    } catch (err) {
        success = false;
        emit(`BT pair (${stage}) error (${mac}): ${err.message}`);
    }
    const devices = await listBluetoothDevices(kind).catch(() => []);
    const device = devices.find((d) => d.mac === mac);
    return { kind, success, action: 'pair', mac, name: device ? device.name : mac, devices };
}

// Disconnects every connected gamepad (Icon: input-gaming, Connected: yes). A USB-wired controller is not affected; physically turning
// it off is not possible over BT.
async function disconnectGamepads() {
    const controllers = await listBluetoothDevices('controller');
    const targets = controllers.filter((c) => c.connected);
    await Promise.allSettled(targets.map((c) =>
        execFileAsync('bluetoothctl', ['disconnect', c.mac], BT_TIMEOUT_OPTS)
    ));
    return targets.map((c) => c.mac);
}

module.exports = {
    listPairedDevices, listBluetoothDevices, detectControllerType, performBtAction, disconnectGamepads,
    discoverDevices, performBtPair, isDiscoverCandidate, DISCOVER_ICONS,
};
