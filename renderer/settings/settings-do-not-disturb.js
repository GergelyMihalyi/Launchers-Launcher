// Settings → Startup → "Do not disturb while playing" subview: toggles muting desktop notifications during a game/launcher launch
// (lib/launch/do-not-disturb.js) — `doNotDisturb` config key (lib/prefs.js). Default ON. Takes effect at the NEXT launch (turning it off also
// stops a live inhibit). On/off picker on the `createToggleSubview` factory (settings-toggle.js).

SETTINGS_VIEWS['do-not-disturb'] = createToggleSubview({
    id: 'do-not-disturb',
    hintKey: 'sv.doNotDisturbHint',
    onLabelKey: 'sv.doNotDisturbOn',
    offLabelKey: 'sv.doNotDisturbOff',
    defaultOn: true,
    get: () => window.launcher.getDoNotDisturb(),
    set: (v) => window.launcher.setDoNotDisturb(v),
});
