// @ts-check
'use strict';

// GNOME (Mutter) monitor backend (called by the dispatcher in `displays.js`; KDE counterpart: ./displays-kde.js, shared interface:
// `listMonitors()` + `applyLayout(plan)`). Calls Mutter's `org.gnome.Mutter.DisplayConfig` D-Bus interface through `busctl --json=short`
// output (the GVariant text is not parsed). Rules verified on the machine: the smallest x/y is 0; logical monitors must touch; the scale
// comes from the mode's `supported_scales`; a stale serial → 1 retry; a disabled monitor is enabled with its `is-preferred` mode.
// `layout-mode` 1 = logical (Wayland), 2 = physical (X11, `global-scale-required`). Background: docs/dev/output-tv.md#monitor-backends

const { execFileAsync, SESSION_ENV, EXEC_TIMEOUT_MS } = require('../exec.js');
const { checkParsed } = require('../host-deps/format-drift.js');

const DEST = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';
const IFACE = 'org.gnome.Mutter.DisplayConfig';
const APPLY_SIGNATURE = 'uua(iiduba(ssa{sv}))a{sv}';
// 0 = verify only, 1 = temporary, 2 = persistent (`~/.config/monitors.xml`). DELIBERATELY TEMPORARY: on a persistent apply GNOME Shell
// pops up its own "Keep these display settings?" dialog (20 s, mouse/keyboard — not usable by controller; reported in production on the
// T410), and the launcher has its own controller-driven "Keep?" step (lib/ipc/output-ipc.js). The price: after a hotplug (e.g. the TV
// powered on over CEC) Mutter may load back the STORED config.
const METHOD_TEMPORARY = 1;

// busctl reads doubles with `strtod` — in a Hungarian locale `1.25` is not a number.
const BUSCTL_ENV = { ...SESSION_ENV, LC_ALL: 'C' };

/**
 * @typedef {{ id: string, width: number, height: number, refresh: number,
 *   preferredScale: number, scales: number[], current: boolean, preferred: boolean }} MutterMode
 * @typedef {{ connector: string, displayName: string, builtin: boolean, modes: MutterMode[] }} MutterMonitor
 * @typedef {{ x: number, y: number, scale: number, transform: number, primary: boolean,
 *   connectors: string[] }} MutterLogical
 * @typedef {{ serial: number, layoutMode: number, supportsChangingLayoutMode: boolean,
 *   globalScaleRequired: boolean, monitors: MutterMonitor[], logical: MutterLogical[] }} MutterState
 * @typedef {{ x: number, y: number, scale: number, transform: number, primary: boolean,
 *   monitors: { connector: string, modeId: string }[] }} MutterLogicalConfig
 */

// `a{sv}` in busctl's JSON: `{ key: { type, data } }`.
const prop = (props, key, fallback) => (props && props[key] && 'data' in props[key] ? props[key].data : fallback);

/**
 * Pure: the output of `busctl --json=short call … GetCurrentState` (parsed JSON) → state.
 * @returns {MutterState}
 */
function parseMutterState(json) {
    const data = json && Array.isArray(json.data) ? json.data : null;
    if (!data || data.length < 4) throw new Error('unexpected GetCurrentState response');
    const [serial, rawMonitors, rawLogical, props] = data;
    const monitors = (rawMonitors || []).map((m) => ({
        connector: String(m[0][0]),
        displayName: String(prop(m[2], 'display-name', '') || ''),
        builtin: prop(m[2], 'is-builtin', false) === true,
        modes: (m[1] || []).map((md) => ({
            id: String(md[0]),
            width: Number(md[1]),
            height: Number(md[2]),
            refresh: Number(md[3]),
            preferredScale: Number(md[4]) || 1,
            scales: Array.isArray(md[5]) ? md[5].map(Number) : [1],
            current: prop(md[6], 'is-current', false) === true,
            preferred: prop(md[6], 'is-preferred', false) === true,
        })),
    }));
    const logical = (rawLogical || []).map((l) => ({
        x: Number(l[0]),
        y: Number(l[1]),
        scale: Number(l[2]) || 1,
        transform: Number(l[3]) || 0,
        primary: l[4] === true,
        connectors: (l[5] || []).map((spec) => String(spec[0])),
    }));
    return {
        serial: Number(serial),
        layoutMode: Number(prop(props, 'layout-mode', 1)) || 1,
        supportsChangingLayoutMode: prop(props, 'supports-changing-layout-mode', false) === true,
        globalScaleRequired: prop(props, 'global-scale-required', false) === true,
        monitors,
        logical,
    };
}

/** @param {MutterMonitor} m @returns {MutterMode|null} */
function currentMode(m) {
    return m.modes.find((md) => md.current) || m.modes.find((md) => md.preferred) || m.modes[0] || null;
}

/**
 * Pure: the state → the shared `Monitor[]` shape (like the kscreen `parseMonitors`). `priority` 1 = the primary, the other
 * active ones left to right (top to bottom) 2, 3, …; disabled 0 (as with kscreen).
 * @param {MutterState} state
 * @returns {import('../types.js').Monitor[]}
 */
function mutterMonitorList(state) {
    const active = [...state.logical].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.x - b.x || a.y - b.y);
    const prio = new Map();
    active.forEach((l) => l.connectors.forEach((c) => { if (!prio.has(c)) prio.set(c, prio.size + 1); }));
    return state.monitors.map((m) => {
        const mode = currentMode(m);
        const width = mode ? mode.width : null;
        const height = mode ? mode.height : null;
        return {
            name: m.connector,
            width,
            height,
            active: prio.has(m.connector),
            priority: prio.get(m.connector) || 0,
            label: width && height ? `${m.connector} — ${width}×${height}` : m.connector,
        };
    });
}

const approx = (a, b) => Math.abs(a - b) < 1e-4;

// The scale supported by the mode: the requested one if included; otherwise 1 (if supported), otherwise the first.
/** @param {MutterMode} mode @param {number} wanted */
function validScale(mode, wanted) {
    const hit = mode.scales.find((s) => approx(s, wanted));
    if (hit !== undefined) return hit;
    return mode.scales.find((s) => approx(s, 1)) ?? mode.scales[0] ?? 1;
}

/**
 * Pure: the shared plan (`{ order, disable }`, see displays.js `LayoutPlan`) → the logical monitor list of Mutter's
 * `ApplyMonitorsConfig`. The first item of `order` is the primary, `disable` turns off, the rest stay active. If no active
 * monitor turns off, the existing layout stays (a new monitor goes to the right edge); if something turns off, they are laid
 * out in one row (first `order`, then the remaining ones by their current x). `null` = nothing to turn on (do not black out
 * everything).
 * @param {MutterState} state
 * @param {import('./displays.js').LayoutPlan} plan
 * @returns {MutterLogicalConfig[]|null}
 */
function buildMutterConfig(state, plan) {
    const byName = new Map(state.monitors.map((m) => [m.connector, m]));
    const lmOf = new Map();
    for (const l of state.logical) for (const c of l.connectors) lmOf.set(c, l);
    const order = [...new Set(plan.order)].filter((n) => byName.has(n));
    const disable = new Set(plan.disable.filter((n) => !order.includes(n)));

    /** @param {string} c */
    const monSpec = (c) => {
        const mode = currentMode(/** @type {MutterMonitor} */ (byName.get(c)));
        return mode ? { connector: c, modeId: mode.id, mode } : null;
    };

    const entries = [];
    for (const c of order) {
        const spec = monSpec(c);
        if (!spec) continue;
        const lm = lmOf.get(c);
        entries.push({
            specs: [spec],
            scale: lm ? validScale(spec.mode, lm.scale) : validScale(spec.mode, spec.mode.preferredScale),
            transform: lm ? lm.transform : 0,
            x: lm ? lm.x : 0,
            y: lm ? lm.y : 0,
            existing: !!lm && lm.connectors.length === 1,
            primary: false,
        });
    }
    const kept = [];
    for (const l of state.logical) {
        const specs = l.connectors
            .filter((c) => !order.includes(c) && !disable.has(c) && byName.has(c))
            .map(monSpec).filter(Boolean);
        if (!specs.length) continue;
        kept.push({ specs, scale: l.scale, transform: l.transform, x: l.x, y: l.y, existing: specs.length === l.connectors.length, primary: l.primary });
    }
    const all = [...entries, ...kept];
    if (!all.length) return null;

    if (state.globalScaleRequired) {
        const scale = state.logical.length ? state.logical[0].scale : 1;
        for (const e of all) e.scale = scale;
    }
    const size = (e) => {
        const m = e.specs[0].mode;
        const rotated = e.transform % 2 === 1; // 90°/270° (and their flipped pairs)
        let w = rotated ? m.height : m.width;
        let h = rotated ? m.width : m.height;
        if (state.layoutMode === 1) { w = Math.round(w / e.scale); h = Math.round(h / e.scale); }
        return { w, h };
    };

    const nothingTurnsOff = state.logical.every((l) => l.connectors.every((c) => !disable.has(c) && byName.has(c)))
        && all.every((e) => e.existing || !lmOf.has(e.specs[0].connector));
    if (nothingTurnsOff) {
        // The existing layout stays; new ones go to the right edge, next to the rightmost one.
        const placed = all.filter((e) => e.existing);
        for (const e of all.filter((x) => !x.existing)) {
            let edge = 0;
            let y = 0;
            for (const p of placed) {
                const right = p.x + size(p).w;
                if (right >= edge) { edge = right; y = p.y; }
            }
            e.x = edge;
            e.y = y;
            placed.push(e);
        }
    } else {
        const row = [...entries, ...kept.sort((a, b) => a.x - b.x)];
        let x = 0;
        for (const e of row) { e.x = x; e.y = 0; x += size(e).w; }
    }
    const minX = Math.min(...all.map((e) => e.x));
    const minY = Math.min(...all.map((e) => e.y));

    const primaryEntry = entries[0] || kept.find((e) => e.primary) || all[0];
    return all.map((e) => ({
        x: e.x - minX,
        y: e.y - minY,
        scale: e.scale,
        transform: e.transform,
        primary: e === primaryEntry,
        monitors: e.specs.map((s) => ({ connector: s.connector, modeId: s.modeId })),
    }));
}

/**
 * Pure: the arguments of busctl `call … ApplyMonitorsConfig` (without the call head).
 * @param {MutterState} state @param {MutterLogicalConfig[]} logical @param {number} [method]
 */
function applyConfigArgs(state, logical, method = METHOD_TEMPORARY) {
    const args = [APPLY_SIGNATURE, String(state.serial), String(method), String(logical.length)];
    for (const l of logical) {
        args.push(String(l.x), String(l.y), String(l.scale), String(l.transform), l.primary ? 'true' : 'false',
            String(l.monitors.length));
        for (const m of l.monitors) args.push(m.connector, m.modeId, '0');
    }
    // The current layout mode is kept explicitly (without it Mutter would take the default mode).
    if (state.supportsChangingLayoutMode) args.push('1', 'layout-mode', 'u', String(state.layoutMode));
    else args.push('0');
    return args;
}

/**
 * Pure: the screen geometry of an active output from the Mutter state (the logical monitor's position + size; in logical
 * layout mode the size divided by the scale). Not active / unknown → null. On X11 (physical mode) this is exactly the
 * `bounds` of Electron's `screen` displays (measured on the machine).
 * @param {MutterState} state @param {string} name
 * @returns {{ x: number, y: number, width: number, height: number }|null}
 */
function outputGeometryFromState(state, name) {
    const l = state.logical.find((lm) => lm.connectors.includes(name));
    const m = state.monitors.find((mon) => mon.connector === name);
    const mode = m && currentMode(m);
    if (!l || !mode) return null;
    const rotated = l.transform % 2 === 1;
    let width = rotated ? mode.height : mode.width;
    let height = rotated ? mode.width : mode.height;
    if (state.layoutMode === 1) { width = Math.round(width / l.scale); height = Math.round(height / l.scale); }
    return { x: l.x, y: l.y, width, height };
}

const busctl = (args) => execFileAsync('busctl', ['--user', ...args], { env: BUSCTL_ENV, timeout: EXEC_TIMEOUT_MS });

/** @returns {Promise<MutterState>} */
async function getState() {
    const { stdout } = await busctl(['--json=short', 'call', DEST, OBJECT_PATH, IFACE, 'GetCurrentState']);
    const state = parseMutterState(JSON.parse(stdout)); // throws on an unexpected structure (visible at the caller)
    checkParsed('mutter-state', stdout, state.monitors.length);
    return state;
}

async function listMonitors() {
    return mutterMonitorList(await getState());
}

/** @param {string} name */
async function outputGeometry(name) {
    return outputGeometryFromState(await getState(), name);
}

// Stale serial (hotplug between the query and the apply) → Mutter answers `Access denied`.
const STALE_RE = /Access denied|stale/i;

/** @param {import('./displays.js').LayoutPlan} plan @param {{ method?: number }} [opts] */
async function applyLayout(plan, opts = {}) {
    for (let attempt = 0; ; attempt++) {
        const state = await getState();
        const logical = buildMutterConfig(state, plan);
        if (!logical) return;
        try {
            await busctl(['call', DEST, OBJECT_PATH, IFACE, 'ApplyMonitorsConfig', ...applyConfigArgs(state, logical, opts.method)]);
            return;
        } catch (err) {
            const text = String((err && (err.stderr || err.message)) || '');
            if (attempt === 0 && STALE_RE.test(text)) continue;
            throw err;
        }
    }
}

module.exports = {
    parseMutterState, mutterMonitorList, buildMutterConfig, applyConfigArgs, outputGeometryFromState,
    listMonitors, outputGeometry, applyLayout,
    METHOD_TEMPORARY,
};
