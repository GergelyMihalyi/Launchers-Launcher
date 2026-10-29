// Idle auto-suspend + controller disconnect. Builds on the screensaver's idle measurement (`idle.js` `checkIdle()` calls it every poll
// round): only counts with a FOCUSED window, never suspends/disconnects while a game runs — on focus return `resolveIdleFocus` resets
// `lastInputAt`. One idle PERIOD = one `lastInputAt` value: every action runs at most ONCE per period (`idlePowerFired`), which also
// prevents immediately sleeping again after waking. Settings: `autoSuspend` / `idleDisconnect` (settings-idle-power.js); `idlePowerActions`
// is pure (test/home/idle-power.test.js). Background: docs/dev/renderer/home.md#screensaver

const AUTO_SUSPEND_WARN_MS = 60 * 1000; // a warning toast this long before the suspend

let autoSuspendMs = 0;
let idleDisconnectMs = 0;
let idlePowerPeriod = null; // the `lastInputAt` value that `fired` belongs to
let idlePowerFired = { warn: false, suspend: false, disconnect: false };

function setAutoSuspendMinutes(minutes) {
    autoSuspendMs = minutes > 0 ? minutes * 60 * 1000 : 0;
}

function setIdleDisconnectMinutes(minutes) {
    idleDisconnectMs = minutes > 0 ? minutes * 60 * 1000 : 0;
}

// Which actions are due NOW (pure function): `idleForMs` = the idle length, `cfg` = { suspendMs, disconnectMs } (0 = off), `fired` = the
// actions already run in the period. Returns: ['warn' | 'suspend' | 'disconnect', ...] in execution order.
function idlePowerActions(idleForMs, cfg, fired) {
    const out = [];
    if (cfg.disconnectMs > 0 && !fired.disconnect && idleForMs >= cfg.disconnectMs) out.push('disconnect');
    if (cfg.suspendMs > 0) {
        const warnAt = Math.max(0, cfg.suspendMs - AUTO_SUSPEND_WARN_MS);
        if (!fired.warn && !fired.suspend && idleForMs >= warnAt && idleForMs < cfg.suspendMs) out.push('warn');
        if (!fired.suspend && idleForMs >= cfg.suspendMs) out.push('suspend');
    }
    return out;
}

// Called by `checkIdle()`: `run` = is the launcher focused (the decision of `resolveIdleFocus`).
function checkIdlePower(run, now, inputAt) {
    if (!run || isLaunching || (!autoSuspendMs && !idleDisconnectMs)) return;
    if (inputAt !== idlePowerPeriod) {
        idlePowerPeriod = inputAt;
        idlePowerFired = { warn: false, suspend: false, disconnect: false };
    }
    const actions = idlePowerActions(now - inputAt,
        { suspendMs: autoSuspendMs, disconnectMs: idleDisconnectMs }, idlePowerFired);
    for (const action of actions) {
        idlePowerFired[action] = true;
        if (action === 'warn') showStatus(tr('toast.autoSuspendWarning'), true);
        else if (action === 'suspend') window.launcher.systemAction('suspend');
        else if (action === 'disconnect') window.launcher.disconnectIdleControllers();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { idlePowerActions, AUTO_SUSPEND_WARN_MS });
}
