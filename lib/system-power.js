// @ts-check
'use strict';

// System-action whitelist (`systemctl poweroff/reboot/suspend`) + the state machine of the session-only sleep timer.
// `createSystemPower({ log, sendToRenderer })`. ⚠️ `systemctl`, NOT `loginctl` (it has no such subcommand); `--no-ask-password`
// (no polkit agent in kiosk). The sleep timer is DELIBERATELY session-only (NOT in the config — a timer auto-arming at startup is
// unwanted on a kiosk): after it expires (30/60/90 min) `suspend`, with a `sleep-timer-warning` push in the last minute.

const { execFileAsync, EXEC_TIMEOUT_MS } = require('./exec.js');

const SYSTEM_ACTIONS = { poweroff: 'poweroff', reboot: 'reboot', suspend: 'suspend' };
const SLEEP_TIMER_OPTIONS = [0, 30, 60, 90];

function createSystemPower({ log, sendToRenderer }) {
    const logFn = log || (() => {});
    let sleepTimerMinutes = 0;
    let sleepTimerEndsAt = null;
    let sleepTimerFireTimer = null;
    let sleepTimerWarnTimer = null;

    // No `sendToRenderer` on the success branch: by then the machine is powering off/sleeping.
    async function runSystemAction(verb) {
        try {
            logFn(`system-action: systemctl ${verb}`);
            await execFileAsync('systemctl', ['--no-ask-password', verb], { timeout: EXEC_TIMEOUT_MS });
        } catch (err) {
            logFn(`system-action (${verb}) error: ${err.message}`);
            sendToRenderer('system-action-failed', { action: verb, message: err.message });
        }
    }

    function dispatchSystemAction(action) {
        const verb = SYSTEM_ACTIONS[action];
        if (!verb) { logFn(`system-action: unknown action: ${action}`); return; }
        runSystemAction(verb);
    }

    function clearSleepTimer() {
        if (sleepTimerFireTimer) { clearTimeout(sleepTimerFireTimer); sleepTimerFireTimer = null; }
        if (sleepTimerWarnTimer) { clearTimeout(sleepTimerWarnTimer); sleepTimerWarnTimer = null; }
        sleepTimerMinutes = 0;
        sleepTimerEndsAt = null;
    }

    function armSleepTimer(minutes) {
        clearSleepTimer();
        if (!minutes) return;
        sleepTimerMinutes = minutes;
        sleepTimerEndsAt = Date.now() + minutes * 60000;
        const warnDelayMs = Math.max(0, minutes * 60000 - 60000);
        sleepTimerWarnTimer = setTimeout(() => {
            sleepTimerWarnTimer = null;
            sendToRenderer('sleep-timer-warning', {});
        }, warnDelayMs);
        sleepTimerFireTimer = setTimeout(() => {
            sleepTimerFireTimer = null;
            sleepTimerWarnTimer = null;
            sleepTimerMinutes = 0;
            sleepTimerEndsAt = null;
            logFn('Sleep timer expired — suspend');
            runSystemAction('suspend');
        }, minutes * 60000);
    }

    function getSleepTimerState() {
        return { minutes: sleepTimerMinutes, endsAt: sleepTimerEndsAt };
    }

    // Body of the `set-sleep-timer` handler: whitelisted minute value -> `armSleepTimer` + log
    // + the fresh state (the caller sends it as `sleep-timer-changed`).
    function setSleepTimer(minutes) {
        const m = SLEEP_TIMER_OPTIONS.includes(minutes) ? minutes : 0;
        armSleepTimer(m);
        logFn(`Sleep timer: ${m === 0 ? 'off' : `${m} min`}`);
        return getSleepTimerState();
    }

    return {
        dispatchSystemAction, armSleepTimer, clearSleepTimer, getSleepTimerState, setSleepTimer,
    };
}

module.exports = { createSystemPower, SYSTEM_ACTIONS, SLEEP_TIMER_OPTIONS };
