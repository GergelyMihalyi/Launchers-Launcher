// Settings → Startup → "TV-mode exit time" subview: how long ○ must be held on the home screen to exit TV mode — 3 / 5 / 8 / 10 s.
// Deliberately no "Off": this is the only controller exit path (PS+○ closes the launcher). `tvExitHold` config key (lib/prefs.js); the effect
// is renderer-side (renderer/gamepad.js `circleHoldMs`). On the `createPrefSelectSubview` factory (settings-toggle.js). Load order: AFTER
// settings-toggle.js + gamepad.js, BEFORE ipc.js.

SETTINGS_VIEWS['tv-exit-hold'] = createPrefSelectSubview({
    id: 'tv-exit-hold',
    subheadKey: 'sv.tvExitHoldHint',
    rows: [
        { id: 3, labelKey: 'sv.sec3' },
        { id: 5, labelKey: 'sv.sec5' },
        { id: 8, labelKey: 'sv.sec8' },
        { id: 10, labelKey: 'sv.sec10' },
    ],
    defaultValue: 5,
    get: () => window.launcher.getTvExitHold(),
    set: (v) => window.launcher.setTvExitHold(v),
    apply: (v) => { circleHoldMs = v * 1000; },
});
