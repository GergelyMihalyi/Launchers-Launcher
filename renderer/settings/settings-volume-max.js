// Settings → Display and audio → "Volume cap" subview: the L1/R1 volume buttons raise the volume at most this far — None / 85 / 70 / 50 %.
// `volumeMax` config key (lib/prefs.js); applied by main's `change-volume` handler (lib/parse.js `stepVolume`) — it does NOT limit the TV's
// own remote / the CEC volume. On the `createPrefSelectSubview` factory (settings-toggle.js). Load order: AFTER settings-toggle.js.

SETTINGS_VIEWS['volume-max'] = createPrefSelectSubview({
    id: 'volume-max',
    subheadKey: 'sv.volumeMaxHint',
    rows: [
        { id: 100, labelKey: 'sv.volumeMaxNone' },
        { id: 85, labelKey: 'sv.pct85' },
        { id: 70, labelKey: 'sv.pct70' },
        { id: 50, labelKey: 'sv.pct50' },
    ],
    defaultValue: 100,
    get: () => window.launcher.getVolumeMax(),
    set: (v) => window.launcher.setVolumeMax(v),
});
