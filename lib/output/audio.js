// @ts-check
'use strict';

// Audio output handling (`pactl`). No `BrowserWindow` reference.

const { parseSinks, parseVolumePercent, clampVolume } = require('../parse.js');
const { execFileAsync, PACTL_OPTS, toLogger } = require('../exec.js');
const { checkParsed } = require('../host-deps/format-drift.js');

async function listAudioSinks() {
    const [{ stdout: sinksOutput }, { stdout: defaultOutput }] = await Promise.all([
        execFileAsync('pactl', ['list', 'sinks'], PACTL_OPTS),
        execFileAsync('pactl', ['get-default-sink'], PACTL_OPTS),
    ]);
    const sinks = parseSinks(sinksOutput, defaultOutput.trim());
    checkParsed('pactl-sinks', sinksOutput, sinks.length);
    return sinks;
}

async function setAudioSink(sinkName) {
    await execFileAsync('pactl', ['set-default-sink', sinkName], PACTL_OPTS);

    // Move the existing audio streams to the new device (as the old TV-mode scripts did)
    const { stdout } = await execFileAsync('pactl', ['list', 'short', 'sink-inputs'], PACTL_OPTS);
    const ids = stdout.split('\n').map((line) => line.split('\t')[0]).filter(Boolean);
    for (const id of ids) {
        try {
            await execFileAsync('pactl', ['move-sink-input', id, sinkName], PACTL_OPTS);
        } catch (err) {
            // Best effort: a stream may have gone away meanwhile, that is not an error
        }
    }
}

// Makes the saved STARTUP audio device the default sink — BUT only if it is actually available (like
// displays.applyStartupMonitor for the monitor). A hand-broken / vanished sink name is thus a logged no-op, not
// a throwing `pactl set-default-sink` error. `log` is optional.
async function applyStartupSink(name, log) {
    if (!name) return;
    const emit = toLogger(log);
    const sinks = await listAudioSinks();
    if (!sinks.some((s) => s.name === name)) {
        emit(`Startup audio device (${name}) is unavailable - audio output unchanged`);
        return;
    }
    await setAudioSink(name);
}

// The volume is stored per sink (per device) in PipeWire - hence the `@DEFAULT_SINK@` special symbolic name;
// the current sink's name need not be known.
async function getVolume() {
    const { stdout } = await execFileAsync('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], PACTL_OPTS);
    return parseVolumePercent(stdout);
}

async function setVolume(percent) {
    const clamped = clampVolume(percent);
    await execFileAsync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${clamped}%`], PACTL_OPTS);
    return clamped;
}

module.exports = { listAudioSinks, setAudioSink, applyStartupSink, getVolume, setVolume };
