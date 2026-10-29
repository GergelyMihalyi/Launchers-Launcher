// @ts-check
'use strict';

// Run poller: ids of the launchers currently RUNNING on the machine, for the "● RUNNING" badge and the "running → switch" branch of
// `launch-app` (the latter separately through `isLauncherRunning` of `running.js`). `start()`/`stop()` when the launcher window is shown/
// hidden (launch-controller callback); only pushes `running-changed` on an actual Set change. Background: docs/dev/launching.md

/**
 * @param {object} deps
 * @param {object} deps.running - `lib/launch/running.js` (`detectRunningLaunchers`)
 * @param {string} deps.homeDir
 * @param {() => Array<object>} deps.getLaunchers
 * @param {(msg: string) => void} deps.log
 * @param {(channel: string, payload?: any) => void} deps.sendToRenderer
 * @param {() => any} deps.launchersPayload
 * @param {number} [deps.pollMs]
 */
function createRunningPoll({ running, homeDir, getLaunchers, log, sendToRenderer, launchersPayload, pollMs = 4000 }) {
    let runningLauncherIds = new Set();
    let timer = null;

    async function refresh({ push = true } = {}) {
        try {
            const found = await running.detectRunningLaunchers(getLaunchers(), homeDir);
            const next = new Set(found.keys());
            const sig = (s) => [...s].sort().join(',');
            const changed = sig(next) !== sig(runningLauncherIds);
            runningLauncherIds = next;
            if (changed && push) sendToRenderer('running-changed', launchersPayload());
        } catch (err) {
            log(`Running-detection error: ${err.message}`);
        }
    }

    function start() {
        if (timer) return;
        refresh();
        timer = setInterval(() => refresh(), pollMs);
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    return {
        refresh, start, stop,
        getRunningIds: () => runningLauncherIds,
    };
}

module.exports = { createRunningPoll };
