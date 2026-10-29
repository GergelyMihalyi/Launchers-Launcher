// Settings → Display and audio → "Volume step" subview: how much L1/R1 changes the volume per press — 2 / 5 / 10 %. `volumeStep` config key
// (lib/prefs.js); the effect is renderer-side (renderer/overlays.js `volumeStep`). On the `createPrefSelectSubview` factory
// (settings-toggle.js). Load order: AFTER settings-toggle.js + overlays.js, BEFORE ipc.js.

SETTINGS_VIEWS['volume-step'] = createPrefSelectSubview({
    id: 'volume-step',
    subheadKey: 'sv.volumeStepHint',
    rows: [
        { id: 2, labelKey: 'sv.pct2' },
        { id: 5, labelKey: 'sv.pct5' },
        { id: 10, labelKey: 'sv.pct10' },
    ],
    defaultValue: 5,
    get: () => window.launcher.getVolumeStep(),
    set: (v) => window.launcher.setVolumeStep(v),
    apply: (v) => { volumeStep = v; },
});
