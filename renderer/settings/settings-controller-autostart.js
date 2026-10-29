// Settings → Startup → "Start with controller": whether a recognized controller connection (bin/launchers-launcher-bt-trigger.sh) starts the
// launcher (`controllerAutostart` key). It does NOT turn off the systemd units; the trigger skips the start based on the
// `lib/sidecars/autostart.js` sidecar. On the `createToggleSubview` factory (settings-toggle.js).

SETTINGS_VIEWS['controller-autostart'] = createToggleSubview({
    id: 'controller-autostart',
    hintKey: 'sv.controllerAutostartHint',
    onLabelKey: 'sv.controllerAutostartOn',
    offLabelKey: 'sv.controllerAutostartOff',
    defaultOn: true,
    get: () => window.launcher.getControllerAutostart(),
    set: (v) => window.launcher.setControllerAutostart(v),
});
