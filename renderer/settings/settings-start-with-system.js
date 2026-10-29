// Settings → Startup → "Start at login": opens the launcher window automatically at login — `startWithSystem` key (default OFF, opt-in);
// when on, main writes an XDG autostart `.desktop` (lib/sidecars/xdg-autostart.js). INDEPENDENT of `controllerAutostart`.
// On the `createToggleSubview` factory (settings-toggle.js).

SETTINGS_VIEWS['start-with-system'] = createToggleSubview({
    id: 'start-with-system',
    hintKey: 'sv.startWithSystemHint',
    onLabelKey: 'sv.startWithSystemOn',
    offLabelKey: 'sv.startWithSystemOff',
    defaultOn: false,
    get: () => window.launcher.getStartWithSystem(),
    set: (v) => window.launcher.setStartWithSystem(v),
});
