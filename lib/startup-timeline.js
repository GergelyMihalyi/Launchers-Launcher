// @ts-check
'use strict';

// Startup timeline: a few timestamps from process start (`performance.now()` in the Node main process =
// ms since process start — Electron boot and the `require`s included). Always recorded (cheap); main writes
// a `[startup] …` log line from it and the Diagnostics subview's "Last start" section shows it over the
// `get-startup-timeline` IPC. Goal: optimizations are measurable, a regression (slower start) shows in the log.

const { performance } = require('perf_hooks');

// The known milestones (in log/Diagnostics order): appReady, outputsApplied (BEFORE the window), windowCreated, rendererLoaded
// (`did-finish-load`, typically AFTER launchersRendered), launchersRendered (`startup-mark` IPC), warmupDone (Games cache warmup).
const MARKS = ['appReady', 'outputsApplied', 'windowCreated', 'rendererLoaded', 'launchersRendered', 'warmupDone'];

/** @param {{ now?: () => number }} [opts] */
function createStartupTimeline({ now = () => performance.now() } = {}) {
    /** @type {Map<string, number>} */
    const marks = new Map();

    // Only a known, not yet recorded milestone (a renderer reload must not overwrite it).
    function mark(name) {
        if (!MARKS.includes(name) || marks.has(name)) return false;
        marks.set(name, Math.round(now()));
        return true;
    }

    function list() {
        return [...marks].map(([name, ms]) => ({ name, ms })).sort((a, b) => a.ms - b.ms);
    }

    return { mark, list, has: (name) => marks.has(name) };
}

// Pure: the log line — `[startup] appReady 180ms · outputsApplied 640ms · …`.
function formatTimeline(items) {
    return `[startup] ${items.map((m) => `${m.name} ${m.ms}ms`).join(' · ')}`;
}

module.exports = { createStartupTimeline, formatTimeline, MARKS };
