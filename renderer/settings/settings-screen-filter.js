// Settings → Display and audio → "Brightness" + "Night mode": a SOFTWARE filter — two `pointer-events: none` layers on top of the launcher
// window (above the screensaver, below the fatal error overlay; styles/07-screen-overlays.css), the monitor panel does not dim, it has no effect
// on a launched game. DDC/CI is deliberately not used (the monitors did not answer reliably). `screenDim` — a black layer; `nightMode` — an
// orange layer with `mix-blend-mode: multiply`. Load order: AFTER settings-toggle.js, BEFORE ipc.js.

const NIGHT_MODE_ALPHA = [0, 0.3, 0.55]; // off / mild / strong

function applyScreenDim(percent) {
    const el = $('screenDimOverlay');
    if (el) el.style.opacity = String(Math.max(0, Math.min(90, percent || 0)) / 100);
}

function applyNightMode(level) {
    const el = $('nightModeOverlay');
    if (el) el.style.opacity = String(NIGHT_MODE_ALPHA[level] || 0);
}

SETTINGS_VIEWS['screen-dim'] = createPrefSelectSubview({
    id: 'screen-dim',
    subheadKey: 'sv.screenDimHint',
    rows: [
        { id: 0, labelKey: 'sv.bright100' },
        { id: 20, labelKey: 'sv.bright80' },
        { id: 40, labelKey: 'sv.bright60' },
        { id: 60, labelKey: 'sv.bright40' },
    ],
    defaultValue: 0,
    get: () => window.launcher.getScreenDim(),
    set: (v) => window.launcher.setScreenDim(v),
    apply: (v) => applyScreenDim(v),
});

SETTINGS_VIEWS['night-mode'] = createPrefSelectSubview({
    id: 'night-mode',
    subheadKey: 'sv.nightModeHint',
    rows: [
        { id: 0, labelKey: 'sv.optOff' },
        { id: 1, labelKey: 'sv.nightMild' },
        { id: 2, labelKey: 'sv.nightStrong' },
    ],
    defaultValue: 0,
    get: () => window.launcher.getNightMode(),
    set: (v) => window.launcher.setNightMode(v),
    apply: (v) => applyNightMode(v),
});
