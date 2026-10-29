// @ts-check
'use strict';

// KDE Plasma monitor backend (`kscreen-doctor`) — called by the dispatcher in `lib/output/displays.js` when `lib/desktop-env.js` does
// not see GNOME. GNOME counterpart: ./displays-gnome.js; shared interface: `listMonitors()` + `applyLayout(plan)` (for the `plan` shape
// see displays.js `LayoutPlan`).

const { parseMonitors } = require('../parse.js');
const { checkParsed } = require('../host-deps/format-drift.js');
const { execFileAsync, SESSION_ENV, EXEC_TIMEOUT_MS } = require('../exec.js');

// kscreen-doctor gives no friendly vendor/model name, so the label is the connector name + the current resolution
// (e.g. "DP-3 — 2560×1080"). Only connected outputs are returned.
async function listMonitors() {
    const { stdout } = await execFileAsync('kscreen-doctor', ['-j'], { env: SESSION_ENV, timeout: EXEC_TIMEOUT_MS });
    const data = JSON.parse(stdout);
    const monitors = parseMonitors(data);
    // 0 monitors is only suspicious if kscreen says there is a connected output
    checkParsed('kscreen-doctor', stdout, monitors.length, {
        emptyIsNormal: () => !(data && Array.isArray(data.outputs) && data.outputs.some((o) => o && o.connected)),
    });
    return monitors;
}

// Pure: plan → kscreen-doctor arguments. The order of `order` is the priority (1-based, 1 = primary), the `disable` outputs are
// disabled; the rest are left alone.
/** @param {import('./displays.js').LayoutPlan} plan */
function kscreenArgs(plan) {
    const args = [];
    plan.order.forEach((n, i) => args.push(`output.${n}.enable`, `output.${n}.priority.${i + 1}`));
    for (const n of plan.disable) args.push(`output.${n}.disable`);
    return args;
}

/** @param {import('./displays.js').LayoutPlan} plan */
async function applyLayout(plan) {
    await execFileAsync('kscreen-doctor', kscreenArgs(plan), { env: SESSION_ENV, timeout: EXEC_TIMEOUT_MS });
}

module.exports = { listMonitors, kscreenArgs, applyLayout };
