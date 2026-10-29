'use strict';

// The timeouts in ONE place (lib/timings.js).
// The test fails if:
//   - a value is not a positive integer ms, or a constant is not used anywhere;
//   - an old export name of a module (e.g. `EXEC_TIMEOUT_MS` in `lib/exec.js`) differs from lib/timings.js;
//   - a hard-coded number `timeout:` or `withTimeout(…, <number>, …)` shows up again in
//     lib/** / main.js / bootstrap.js (a new timeout belongs in lib/timings.js);
//   - the renderer launch watchdog is not longer than the main-side launch timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');
const timings = require('../../lib/timings.js');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// Comment-free source; a `:` before `//` excludes URLs (`https://…`).
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const { LAUNCH_TIMINGS } = timings;
// The grouped (object) exports: `LAUNCH_TIMINGS` + the per-channel IPC limits.
const GROUPS = ['LAUNCH_TIMINGS', 'IPC_HANDLE_TIMEOUT_OVERRIDES'];
const flatNames = Object.keys(timings).filter((k) => !GROUPS.includes(k));
// The table keys: the flat constants + `<GROUP>.<field>`.
const expected = new Map([
    ...flatNames.map((k) => [k, timings[k]]),
    ...GROUPS.flatMap((g) => Object.entries(timings[g]).map(([f, v]) => [`${g}.${f}`, v])),
]);

// The main-side source where the constants must be used (except lib/timings.js).
const mainSources = [
    ...listJsFiles(path.join(root, 'lib'))
        .map((rel) => `lib/${rel.split(path.sep).join('/')}`)
        .filter((rel) => rel !== 'lib/timings.js'),
    'main.js', 'bootstrap.js',
].map((rel) => ({ rel, src: strip(read(rel)) }));

// The value of a renderer-side `const NAME = <number>;`.
function rendererConst(rel, name) {
    const m = strip(read(rel)).match(new RegExp(`\\bconst ${name} = (\\d+);`));
    assert.ok(m, `${rel}: ${name} not found`);
    return Number(m[1]);
}
const RENDERER = {
    LAUNCH_WATCHDOG_MS: rendererConst('renderer/gamepad.js', 'LAUNCH_WATCHDOG_MS'),
    MONITOR_SWITCH_GUARD_MS: rendererConst('renderer/settings/settings-startup.js', 'MONITOR_SWITCH_GUARD_MS'),
};

// The arguments of a call (with paren balancing, skipping strings) from after the opening `(`.
function callArgs(src, openIdx) {
    const args = [];
    let depth = 0;
    let cur = '';
    for (let i = openIdx + 1; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\'' || ch === '"' || ch === '`') {
            const end = src.indexOf(ch, i + 1);
            cur += src.slice(i, end + 1);
            i = end;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) { args.push(cur.trim()); return args; }
            depth--;
        }
        if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    return args;
}

test('every value is a positive integer ms, LAUNCH_TIMINGS is frozen', () => {
    assert.ok(expected.size >= 25, `only ${expected.size} values`);
    for (const [k, v] of expected) assert.ok(Number.isInteger(v) && v > 0, `${k}: ${v}`);
    for (const g of GROUPS) assert.ok(Object.isFrozen(timings[g]), `${g} is not frozen`);
});

test('every constant is used by some module (no dead entry)', () => {
    for (const name of flatNames) {
        const re = new RegExp(`\\b${name}\\b`);
        assert.ok(mainSources.some(({ src }) => re.test(src)), `${name}: not used anywhere`);
    }
    const controller = mainSources.find((s) => s.rel === 'lib/launch/launch-controller.js').src;
    for (const f of Object.keys(LAUNCH_TIMINGS)) {
        assert.ok(controller.includes(`T.${f}`), `LAUNCH_TIMINGS.${f}: launch-controller does not use it`);
    }
});

test('the old export names of the modules give the values of lib/timings.js', () => {
    const exec = require('../../lib/exec.js');
    assert.equal(exec.EXEC_TIMEOUT_MS, timings.EXEC_TIMEOUT_MS);
    assert.equal(exec.PACTL_OPTS.timeout, timings.EXEC_TIMEOUT_MS);
    assert.equal(exec.BT_TIMEOUT_OPTS.timeout, timings.BT_CONNECT_TIMEOUT_MS);
    const flatpak = require('../../lib/flatpak.js');
    for (const k of ['FLATPAK_QUERY_TIMEOUT_MS', 'FLATPAK_REMOTE_TIMEOUT_MS', 'FLATPAK_INSTALL_TIMEOUT_MS']) {
        assert.equal(flatpak[k], timings[k], k);
    }
    assert.equal(require('../../lib/net.js').DEFAULT_TIMEOUT_MS, timings.DOWNLOAD_TIMEOUT_MS);
    assert.equal(require('../../lib/ipc/output-ipc.js').MONITOR_CONFIRM_MS, timings.MONITOR_CONFIRM_MS);
    assert.equal(require('../../lib/launch/launch-controller.js').DEFAULT_TIMINGS, LAUNCH_TIMINGS);
});

test('no hardcoded numeric timeout in the main-side source (it belongs in lib/timings.js)', () => {
    const found = [];
    for (const { rel, src } of mainSources) {
        for (const m of src.matchAll(/\btimeout(?:Ms)?\s*:\s*[\d(]/g)) {
            found.push(`${rel}: ${src.slice(m.index, m.index + 30).split('\n')[0]}`);
        }
        for (const m of src.matchAll(/\bwithTimeout\(/g)) {
            if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue; // the definition
            const args = callArgs(src, m.index + m[0].length - 1);
            if (args.length >= 2 && /^[\d(]/.test(args[1])) found.push(`${rel}: withTimeout(…, ${args[1]}, …)`);
        }
    }
    assert.deepEqual(found, [], `hardcoded numeric timeout(s):\n  ${found.join('\n  ')}`);
});

test('the argument splitter (helper of the test above) works', () => {
    const src = "withTimeout(foo(a, [1, 2]), 6000, 'x, y')";
    assert.deepEqual(callArgs(src, src.indexOf('(')), ['foo(a, [1, 2])', '6000', "'x, y'"]);
});

test('the renderer launch watchdog is longer than the main-side launch timers', () => {
    const { spawnWatchdogMs, hideFallbackMs, quickExitMs, bringToFrontMs } = LAUNCH_TIMINGS;
    // On the longest branch main reports back (app-error / app-closed) or hides the window
    // within this time — the renderer watchdog must not fire earlier (a false "launch failed" toast).
    const mainWorstMs = Math.max(spawnWatchdogMs, hideFallbackMs, quickExitMs) + bringToFrontMs;
    assert.ok(RENDERER.LAUNCH_WATCHDOG_MS > mainWorstMs,
        `LAUNCH_WATCHDOG_MS (${RENDERER.LAUNCH_WATCHDOG_MS}) <= ${mainWorstMs}`);
    // One kscreen-doctor call must fit within the monitor-switch UI lock.
    assert.ok(RENDERER.MONITOR_SWITCH_GUARD_MS > timings.EXEC_TIMEOUT_MS);
});

test('the internal relations: the step limit below the total wait, the quick query shorter than the general one', () => {
    assert.ok(timings.STARTUP_STEP_TIMEOUT_MS < timings.STARTUP_OUTPUTS_MAX_WAIT_MS);
    assert.ok(timings.FLATPAK_QUERY_TIMEOUT_MS <= timings.EXEC_TIMEOUT_MS);
    // BlueZ's ~5 s page timeout should return with its own error before our timeout does.
    assert.ok(timings.BT_CONNECT_TIMEOUT_MS > 5000);
});
