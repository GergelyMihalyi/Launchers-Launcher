// @ts-check
'use strict';

// Display handling: applying the "startup" (TV) profile, snapshotting/restoring the "desktop" profile and reading/writing the `display`
// key. Monitor query/switching lives in a DE-specific backend (KDE → ./displays-kde.js, GNOME → ./displays-gnome.js); this file holds
// the DE-independent logic (`LayoutPlan`) + the public API.

const config = require('../config.js');
const { execFileAsync, PACTL_OPTS, logError, toLogger } = require('../exec.js');
const { desktopEnv } = require('../desktop-env.js');
const kdeDisplays = require('./displays-kde.js');
const gnomeDisplays = require('./displays-gnome.js');

/**
 * DE-independent description of a monitor switch: the `order` outputs turned on, in this order (the first is the primary),
 * the `disable` outputs turned off, the rest left alone.
 * @typedef {{ order: string[], disable: string[] }} LayoutPlan
 */

/** @returns {{ listMonitors: () => Promise<import('../types.js').Monitor[]>, applyLayout: (plan: LayoutPlan) => Promise<void>, outputGeometry?: (name: string) => Promise<{ x: number, y: number, width: number, height: number }|null> }} */
function backend() {
    return desktopEnv() === 'gnome' ? gnomeDisplays : kdeDisplays;
}

// The desktop (TV-mode exit) output profile: ordered monitor connector list + sink.
// `disableOthers` (default true): a connected output not on the list (the TV) is turned off.
// `pinned` (default false): true = pinned by hand by the user (config.json) — `captureDesktopSnapshot()` then never overwrites it
// automatically (see below). Anything incomplete/invalid -> null (the caller does a logged no-op, no hard-coded fallback).
/** @returns {import('../types.js').DesktopProfile|null} */
function parseDesktopProfile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const monitors = Array.isArray(raw.monitors)
        ? raw.monitors.filter((m) => typeof m === 'string' && m)
        : [];
    const sink = typeof raw.sink === 'string' && raw.sink ? raw.sink : null;
    if (!monitors.length && !sink) return null;
    return {
        monitors,
        sink,
        disableOthers: raw.disableOthers !== false,
        pinned: raw.pinned === true,
    };
}

// The raw `display` config object → normalized profile (pure, for tests). `monitor`/`sink`/`desktop` are ALWAYS present (null if
// missing); the TV keys (`tvIsStartupMonitor`, `cecTarget`, `standbyOnExit`, `keepOtherMonitors`, `cecPowerOn`) ONLY with a non-default
// value, so `writeDisplayConfig` does not litter the defaults. Background: docs/dev/config-keys.md#display
/** @returns {import('../types.js').DisplayConfig} */
function normalizeDisplayConfig(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { monitor: null, sink: null, desktop: null };
    }
    const out = {
        monitor: typeof parsed.monitor === 'string' ? parsed.monitor : null,
        sink: typeof parsed.sink === 'string' ? parsed.sink : null,
        desktop: parseDesktopProfile(parsed.desktop),
    };
    if (parsed.tvIsStartupMonitor === true) out.tvIsStartupMonitor = true;
    if (parsed.standbyOnExit === true) out.standbyOnExit = true;
    if (parsed.keepOtherMonitors === true) out.keepOtherMonitors = true;
    if (parsed.cecPowerOn === false) out.cecPowerOn = false; // default true, only turning it off is stored
    if (Number.isInteger(parsed.cecTarget) && parsed.cecTarget >= 1 && parsed.cecTarget <= 15) {
        out.cecTarget = parsed.cecTarget;
    }
    return out;
}

// The "startup profile" (machine-specific, the `display` key of `config.json`): which monitor is the only one left on and which is the
// default audio device when the launcher starts. Missing key/field -> that dimension is left alone.
function readDisplayConfig() {
    return normalizeDisplayConfig(config.get('display', null));
}

function writeDisplayConfig(patch) {
    // Renormalize so a flag set back to its default (e.g. keepOtherMonitors:false, cecPowerOn:true) does NOT stay in the file —
    // `normalizeConfig` only keeps the non-default TV keys, the nulls (missing monitor/sink/desktop) are dropped below.
    const next = normalizeDisplayConfig({ ...readDisplayConfig(), ...patch });
    for (const k of Object.keys(next)) {
        if (next[k] == null) delete next[k];
    }
    config.set('display', next);
    return next;
}

// The connected outputs (`[{ name, width, height, active, priority, label }]`); the label is the connector name + the current
// resolution (e.g. "DP-3 — 2560×1080").
async function listMonitors() {
    return backend().listMonitors();
}

// The screen geometry of an active output (`{ x, y, width, height }`) — for moving the window on GNOME/X11 (`moveLauncherToOutput`).
// Only the GNOME backend provides it; on KDE the move goes through the KWin script (lib/launch/window-to-output.js), so `null` there.
async function outputGeometry(name) {
    const b = backend();
    return b.outputGeometry ? b.outputGeometry(name) : null;
}

// Pure: the plan of the startup monitor — the chosen one is the primary, without `keepOthers` every other connected output turns off.
/** @returns {LayoutPlan} */
function startupPlan(name, monitors, keepOthers) {
    return {
        order: [name],
        disable: keepOthers ? [] : monitors.filter((m) => m.name !== name).map((m) => m.name),
    };
}

// The chosen monitor becomes priority 1 and — unless `opts.keepOthers` is true — every other connected output is disabled. Guard: if the
// saved monitor is NOT connected right now, nothing is touched (we do not black out every screen). `log` is optional. `opts.monitors` is
// an already queried `listMonitors()` result (`applyStartupOutputs` queries once, not twice in a row) — queried here if missing.
async function applyStartupMonitor(name, log, opts = {}) {
    if (!name) return;
    const emit = toLogger(log);
    const monitors = opts.monitors || await listMonitors();
    const target = monitors.find((m) => m.name === name);
    if (!target) {
        emit(`Startup monitor (${name}) is not connected - outputs unchanged`);
        return;
    }
    await backend().applyLayout(startupPlan(name, monitors, !!opts.keepOthers));
}

// On every start (= every TV-mode entry) saves the CURRENT (desktop) state BEFORE `applyStartupOutputs()` switches to the TV profile,
// so the restore on exit always returns to the state before THIS. Two guards prevent overwriting: `desktop.pinned === true` (pinned by
// hand), and if the only active monitor is the saved TV monitor (launcher restarted in TV mode).
// `log` is optional; `opts.monitors` = an already queried `listMonitors()` result. Background: docs/dev/output-tv.md#leaving-tv-mode
async function captureDesktopSnapshot(log, opts = {}) {
    const cfg = readDisplayConfig();
    if (cfg.desktop && cfg.desktop.pinned) return;
    const emit = toLogger(log);
    try {
        const monitors = opts.monitors || await listMonitors();
        const active = monitors.filter((m) => m.active);
        if (!active.length) return;
        if (cfg.monitor && active.length === 1 && active[0].name === cfg.monitor) {
            emit('Desktop snapshot skipped: the launcher started in TV mode (1 active monitor = the saved TV)');
            return;
        }
        const ordered = [...active].sort((a, b) => {
            const pa = a.priority > 0 ? a.priority : Infinity;
            const pb = b.priority > 0 ? b.priority : Infinity;
            return pa - pb;
        });
        // The sink defaults to the previously saved value — a transient `pactl` error must not delete (overwrite with null) the last known
        // good sink.
        let sink = cfg.desktop ? cfg.desktop.sink : null;
        try {
            const { stdout } = await execFileAsync('pactl', ['get-default-sink'], PACTL_OPTS);
            const parsed = stdout.trim();
            if (parsed) sink = parsed;
        } catch (err) {
            logError(emit, 'captureDesktopSnapshot: pactl get-default-sink', err);
        }
        const desktop = {
            monitors: ordered.map((m) => m.name),
            sink,
            disableOthers: cfg.desktop ? cfg.desktop.disableOthers : true,
        };
        writeDisplayConfig({ desktop });
        emit(`Desktop profile recorded: monitors=${desktop.monitors.join(',')} sink=${sink || '(none)'}`);
    } catch (err) {
        emit(`Desktop snapshot error: ${err.message}`);
    }
}

// Monitor restore on exit, based on `desktop.monitors` of the `display` config key (ordered connector list, first = priority 1); with
// `desktop.disableOthers` (default true) a connected output not on the list (typically the TV) turns off. `log` is optional.
// If there is no `desktop` profile (`captureDesktopSnapshot()` never ran in desktop mode), the monitor step is skipped — no
// connector names are hard-coded.
async function restoreMonitors(log) {
    const emit = toLogger(log);
    const { desktop } = readDisplayConfig();
    const wanted = desktop && desktop.monitors.length ? desktop.monitors : null;
    if (!wanted) {
        emit('No desktop output profile in config.json — monitor restore skipped (start once in desktop mode to take the snapshot).');
        return;
    }

    const monitors = await listMonitors(); // only the connected ones
    const connected = new Set(monitors.map((m) => m.name));
    const present = wanted.filter((name) => connected.has(name));
    if (!present.length) {
        emit('Desktop profile: none of the saved monitors is connected - outputs unchanged');
        return;
    }
    await backend().applyLayout({
        order: present,
        disable: desktop.disableOthers ? monitors.filter((m) => !wanted.includes(m.name)).map((m) => m.name) : [],
    });
}

// Pure: the plan to restore an earlier active-monitor layout — the order of `names` is the priority (the first is the primary), a
// connected output not on the list is disabled. None of the names is connected → `null` (do not black out everything). When the "Keep?"
// countdown expires (lib/ipc/output-ipc.js), this brings back the previous, provably visible picture.
/** @returns {LayoutPlan|null} */
function activeLayoutPlan(names, monitors) {
    const connected = new Set(monitors.map((m) => m.name));
    const present = names.filter((n) => connected.has(n));
    if (!present.length) return null;
    return { order: present, disable: monitors.filter((m) => !present.includes(m.name)).map((m) => m.name) };
}

// The same as kscreen-doctor arguments (the KDE backend's shape; kept for tests).
function activeLayoutArgs(names, monitors) {
    const plan = activeLayoutPlan(names, monitors);
    return plan ? kdeDisplays.kscreenArgs(plan) : null;
}

// Restores the `names` active layout (see `activeLayoutPlan`). `log` is optional.
async function restoreActiveMonitors(names, log) {
    const plan = activeLayoutPlan(names, await listMonitors());
    if (!plan) {
        toLogger(log)('Previous monitor layout: none of the monitors is connected - outputs unchanged');
        return false;
    }
    await backend().applyLayout(plan);
    return true;
}

module.exports = {
    parseDesktopProfile, normalizeDisplayConfig, readDisplayConfig, writeDisplayConfig,
    listMonitors, outputGeometry, startupPlan, applyStartupMonitor, captureDesktopSnapshot,
    restoreMonitors, activeLayoutPlan, activeLayoutArgs, restoreActiveMonitors,
};
