// Settings → System → "Automatic sleep" + Controllers → "Disconnect controller when idle". Measuring and executing happen in
// renderer/home/idle-power.js; here only the two `createPrefSelectSubview` pickers (settings-toggle.js). Load order: AFTER settings-toggle.js
// + renderer/home/idle-power.js, BEFORE ipc.js.

SETTINGS_VIEWS['auto-suspend'] = createPrefSelectSubview({
    id: 'auto-suspend',
    subheadKey: 'sv.autoSuspendHint',
    rows: [
        { id: 0, labelKey: 'sv.optOff' },
        { id: 30, labelKey: 'sv.idle30' },
        { id: 60, labelKey: 'sv.min60' },
        { id: 120, labelKey: 'sv.min120' },
    ],
    defaultValue: 0,
    get: () => window.launcher.getAutoSuspend(),
    set: (v) => window.launcher.setAutoSuspend(v),
    apply: (v) => setAutoSuspendMinutes(v),
});

SETTINGS_VIEWS['idle-disconnect'] = createPrefSelectSubview({
    id: 'idle-disconnect',
    subheadKey: 'sv.idleDisconnectHint',
    rows: [
        { id: 0, labelKey: 'sv.optOff' },
        { id: 10, labelKey: 'sv.idle10' },
        { id: 20, labelKey: 'sv.min20' },
        { id: 30, labelKey: 'sv.idle30' },
    ],
    defaultValue: 0,
    get: () => window.launcher.getIdleDisconnect(),
    set: (v) => window.launcher.setIdleDisconnect(v),
    apply: (v) => setIdleDisconnectMinutes(v),
});
