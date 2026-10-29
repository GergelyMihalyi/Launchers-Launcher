// @ts-check
'use strict';

// Pure (no I/O) parsers — main only runs the external command (`execFileAsync`); output processing
// lives here so it is testable with `node --test`.

// ---------------------------------------------------------------------------
// pactl
// ---------------------------------------------------------------------------

// `pactl list sinks` (LC_ALL=C) output -> [{ name, description, isDefault }].
/**
 * @param {string} sinksOutput
 * @param {string} [defaultSink]
 * @returns {import('./types.js').AudioSink[]}
 */
function parseSinks(sinksOutput, defaultSink) {
    const sinks = [];
    for (const block of String(sinksOutput).split(/\n(?=Sink #)/)) {
        const nameMatch = block.match(/Name:\s*(.+)/);
        if (!nameMatch) continue;
        const name = nameMatch[1].trim();
        const descMatch = block.match(/Description:\s*(.+)/);
        sinks.push({
            name,
            description: descMatch ? descMatch[1].trim() : name,
            isDefault: name === defaultSink,
        });
    }
    return sinks;
}

// The Name of the first sink matching a pattern in `pactl list sinks` output (or null).
function findSinkNameByPattern(sinksOutput, pattern) {
    const block = String(sinksOutput).split(/\n(?=Sink #)/).find((b) => pattern.test(b));
    const m = block && block.match(/Name:\s*(.+)/);
    return m ? m[1].trim() : null;
}

// The percentage from `pactl get-sink-volume @DEFAULT_SINK@` output (no match -> 100).
function parseVolumePercent(stdout) {
    const m = String(stdout).match(/(\d+)%/);
    return m ? parseInt(m[1], 10) : 100;
}

function clampVolume(percent) {
    return Math.max(0, Math.min(100, percent));
}

// Target value of one L1/R1 step with the `volumeMax` cap: up at most to the cap — if the volume is ALREADY
// above it (e.g. raised with the TV remote), stepping up does not move it but does not pull it down
// either; down always steps.
function stepVolume(current, delta, max = 100) {
    if (delta > 0) return clampVolume(Math.min(current + delta, Math.max(max, current)));
    return clampVolume(current + delta);
}

// ---------------------------------------------------------------------------
// bluetoothctl
// ---------------------------------------------------------------------------

// A field value (trimmed) from `bluetoothctl info <mac>` output, or null.
function btInfoField(info, field) {
    if (!info) return null;
    const m = String(info).match(new RegExp(`${field}:\\s*(.+)`));
    return m ? m[1].trim() : null;
}

// Battery percentage: only a connected device with a working battery service has a `Battery Percentage`
// line; otherwise null (nothing shown).
function parseBattery(info) {
    const raw = btInfoField(info, 'Battery Percentage');
    if (!raw) return null;
    const m = raw.match(/\((\d+)\)/) || raw.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

// Battery % of the device with a given MAC from `upower -d` output, or null. Fallback next to
// `parseBattery()`: the **DualSense does NOT expose a GATT Battery Service over BT** (no `Battery Percentage`
// in `bluetoothctl info`), but UPower sees it through the `hid-playstation` kernel driver
// (`ps-controller-battery-<mac>` device). The Xbox controller has a BLE Battery Service, so bluetoothctl
// has it. MAC matching is normalized: non-alphanumerics stripped and lowercased on both sides (the dump
// separates the MAC with `:`, `-` or `o`) - the `serial:` line always contains it.
function parseUpowerBattery(dump, mac) {
    if (!dump || !mac) return null;
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(mac);
    if (target.length < 6) return null;
    for (const block of String(dump).split(/\nDevice:/)) {
        if (!norm(block).includes(target)) continue;
        const m = block.match(/percentage:\s*(\d+)\s*%/i);
        if (m) return parseInt(m[1], 10);
    }
    return null;
}

// The MACs from `bluetoothctl devices Paired` output ("Device AA:BB:.. Name" lines). Only real device lines count: without an adapter
// bluetoothctl prints "No default controller available", which must not parse as a device called "default".
function parsePairedMacs(stdout) {
    return String(stdout).split('\n')
        .map((line) => line.match(/^\s*Device\s+((?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})(?:\s|$)/))
        .filter(Boolean)
        .map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// kscreen-doctor
// ---------------------------------------------------------------------------

// Parsed `kscreen-doctor -j` JSON -> [{ name, width, height, active, priority, label }] (connected outputs
// only). kscreen gives no friendly vendor/model name, so the label is connector + resolution (e.g.
// "DP-3 — 2560×1080"). `priority` is an int, 1-based (1 = primary); a disabled output gets 0 from kscreen
// -> sorted last (see the desktop snapshot).
/** @returns {import('./types.js').Monitor[]} */
function parseMonitors(kscreenData) {
    const outputs = kscreenData && Array.isArray(kscreenData.outputs) ? kscreenData.outputs : [];
    return outputs
        .filter((o) => o.connected)
        .map((o) => {
            const mode = (o.modes || []).find((m) => String(m.id) === String(o.currentModeId));
            const size = mode && mode.size ? mode.size : null;
            const width = size ? size.width : null;
            const height = size ? size.height : null;
            return {
                name: o.name,
                width,
                height,
                active: !!o.enabled,
                priority: Number.isFinite(o.priority) ? o.priority : 0,
                label: width && height ? `${o.name} — ${width}×${height}` : o.name,
            };
        });
}

// ---------------------------------------------------------------------------
// string helpers
// ---------------------------------------------------------------------------

// Escapes regex metacharacters (for safely matching a dynamically built pattern — e.g. prefix matching a
// saved sink name or serial).
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    parseSinks,
    findSinkNameByPattern,
    parseVolumePercent,
    clampVolume,
    stepVolume,
    btInfoField,
    parseBattery,
    parseUpowerBattery,
    parsePairedMacs,
    parseMonitors,
    escapeRegExp,
};
