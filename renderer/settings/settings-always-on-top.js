// Settings → Startup → "Always on top": the foreground guard (`guardForeground()`) on/off — `alwaysOnTop` key. Default ON: the launcher
// takes the focus back on blur (not while a game is starting/running). OFF: a normal window. No sidecar (purely in-process).
// On the `createToggleSubview` factory (settings-toggle.js).

SETTINGS_VIEWS['always-on-top'] = createToggleSubview({
    id: 'always-on-top',
    hintKey: 'sv.alwaysOnTopHint',
    onLabelKey: 'sv.alwaysOnTopOn',
    offLabelKey: 'sv.alwaysOnTopOff',
    defaultOn: true,
    get: () => window.launcher.getAlwaysOnTop(),
    set: (v) => window.launcher.setAlwaysOnTop(v),
});
