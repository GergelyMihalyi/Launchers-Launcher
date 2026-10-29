// Settings → Appearance → "Screensaver" subview: after how much controller inactivity the bouncing-icon screensaver (renderer/home/idle.js)
// appears — Off / 3 / 5 / 10 / 30 minutes. `idleTimeout` config key (lib/prefs.js). On the `createPrefSelectSubview` factory
// (settings-toggle.js). Load order: AFTER settings-toggle.js + renderer/home/idle.js, BEFORE ipc.js.

SETTINGS_VIEWS['idle-timeout'] = createPrefSelectSubview({
    id: 'idle-timeout',
    subheadKey: 'sv.idleTimeoutHint',
    rows: [
        { id: 0, labelKey: 'sv.optOff' },
        { id: 3, labelKey: 'sv.idle3' },
        { id: 5, labelKey: 'sv.idle5' },
        { id: 10, labelKey: 'sv.idle10' },
        { id: 30, labelKey: 'sv.idle30' },
    ],
    defaultValue: 3,
    get: () => window.launcher.getIdleTimeout(),
    set: (v) => window.launcher.setIdleTimeout(v),
    apply: (v) => setIdleTimeoutMinutes(v),
});
