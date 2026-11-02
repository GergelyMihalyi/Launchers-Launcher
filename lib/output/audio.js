// @ts-check
'use strict';

// Audio output handling (`pactl`). No `BrowserWindow` reference.

const { parseSinks, parseVolumePercent, clampVolume } = require('../parse.js');
const { execFileAsync, PACTL_OPTS, toLogger } = require('../exec.js');
const { checkParsed } = require('../host-deps/format-drift.js');
const { STARTUP_SINK_POLL_MS, STARTUP_SINK_POLL_TRIES } = require('../timings.js');

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
// a throwing `pactl set-default-sink` error. Returns whether the sink was applied (`false` = not present yet —
// the caller may `waitForStartupSink`). `log` is optional.
async function applyStartupSink(name, log) {
    if (!name) return true;
    const emit = toLogger(log);
    const sinks = await listAudioSinks();
    if (!sinks.some((s) => s.name === name)) {
        emit(`Startup audio device (${name}) is unavailable - audio output unchanged`);
        return false;
    }
    await setAudioSink(name);
    return true;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The TV's HDMI sink only appears once the TV is awake (after the CEC power-on, seconds after the launcher started):
// re-checks a missing startup sink every `intervalMs`, up to `tries` times, and switches to it as soon as it shows up.
// Gives up (logged) if the DEFAULT sink changed meanwhile while the target is still absent — the user (or the system)
// chose something else, we must not override it. Returns whether the sink was applied. Never throws.
// `opts`: `intervalMs`/`tries`/`sleep` (tests).
async function waitForStartupSink(name, log, opts = {}) {
    if (!name) return false;
    const emit = toLogger(log);
    const { intervalMs = STARTUP_SINK_POLL_MS, tries = STARTUP_SINK_POLL_TRIES, sleep = defaultSleep } = opts;
    let baseline = null;
    try {
        const first = await listAudioSinks();
        baseline = (first.find((s) => s.isDefault) || {}).name || null;
    } catch (err) { /* the polling below retries */ }
    for (let i = 0; i < tries; i++) {
        await sleep(intervalMs);
        try {
            const sinks = await listAudioSinks();
            if (sinks.some((s) => s.name === name)) {
                await setAudioSink(name);
                emit(`Startup audio device (${name}) appeared after ${i + 1} check(s) - switched`);
                return true;
            }
            const current = (sinks.find((s) => s.isDefault) || {}).name || null;
            if (baseline === null) baseline = current;
            else if (current !== baseline) {
                emit(`Startup audio device (${name}) wait cancelled - the default sink changed to ${current}`);
                return false;
            }
        } catch (err) { /* transient pactl failure: try again next round */ }
    }
    emit(`Startup audio device (${name}) did not appear within ${tries} check(s) - audio output unchanged`);
    return false;
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

module.exports = { listAudioSinks, setAudioSink, applyStartupSink, waitForStartupSink, getVolume, setVolume };
