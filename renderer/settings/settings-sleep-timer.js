// Settings → Power and network → "Sleep timer": Off / 30 / 60 / 90 minutes — arms/clears main's session-only countdown, after it expires
// `runSystemAction('suspend')`. ✕ = choose (live immediately, does not close). `sleepTimerMinutes`/`sleepTimerEndsAt` mirror main's state
// (refreshed by `onSleepTimerChanged` of renderer/ipc.js). On the `createSelectSubview` factory; the NAME `renderSleepTimerView` stays. `row.id`
// = the minute value; `onSelect` always calls `setSleepTimer` (choosing again RE-ARMS the timer, unlike ui-scale). Load order: AFTER
// settings.js.

let sleepTimerMinutes = 0;     // the actively armed timer (0 = off)
let sleepTimerEndsAt = null;   // ms epoch when it fires (only if sleepTimerMinutes > 0)

const SLEEP_TIMER_ROWS = [
    { id: 0, labelKey: 'sv.sleepOff' },
    { id: 30, labelKey: 'sv.sleep30' },
    { id: 60, labelKey: 'sv.sleep60' },
    { id: 90, labelKey: 'sv.sleep90' },
];

const sleepTimerView = createSelectSubview({
    id: 'sleep-timer',
    subheadKey: 'sv.sleepHint',
    rows: SLEEP_TIMER_ROWS,
    getCurrent: () => sleepTimerMinutes,
    onSelect: (row) => window.launcher.setSleepTimer(row.id), // the feedback (sleep-timer-changed) refreshes the view
    tagFor: (row, isCurrent) => {
        if (!isCurrent) return '';
        if (!sleepTimerEndsAt) return ` ${currentTag()}`;
        const mins = Math.max(1, Math.ceil((sleepTimerEndsAt - Date.now()) / 60000));
        return ` ${currentTag(tr('sv.sleepActive', { mins }))}`;
    },
});

function renderSleepTimerView() { sleepTimerView.render(); }

SETTINGS_VIEWS['sleep-timer'] = sleepTimerView;
