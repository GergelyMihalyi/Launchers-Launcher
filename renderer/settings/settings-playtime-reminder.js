// Settings → Games → "Playtime reminder": if today's playtime launched from the launcher reaches the configured hours, a warning toast shows
// on return from the game (does NOT block, no notification while playing — the launcher is hidden then and do-not-disturb mutes anyway).
// main computes today's total (`usage.todayPlaytimeMs`, the `todayMs` field of `app-closed`). Load order: AFTER settings-toggle.js, BEFORE
// ipc.js.

let playtimeReminderHours = 0; // 0 = off

SETTINGS_VIEWS['playtime-reminder'] = createPrefSelectSubview({
    id: 'playtime-reminder',
    subheadKey: 'sv.playtimeReminderHint',
    rows: [
        { id: 0, labelKey: 'sv.optOff' },
        { id: 1, labelKey: 'sv.hours1' },
        { id: 2, labelKey: 'sv.hours2' },
        { id: 3, labelKey: 'sv.hours3' },
        { id: 4, labelKey: 'sv.hours4' },
    ],
    defaultValue: 0,
    get: () => window.launcher.getPlaytimeReminder(),
    set: (v) => window.launcher.setPlaytimeReminder(v),
    apply: (v) => { playtimeReminderHours = v; },
});
