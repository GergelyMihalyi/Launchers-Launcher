// Settings → Display and audio → "Monitors and TV (CEC)": 3 toggles in the `display` key — `keepOtherMonitors`, `standbyOnExit`, `cecPowerOn`
// (the last two hidden on a machine without CEC: `tvCaps.cec`). Read via `get-display-config`, written via `set-output-behavior`; the effect
// applies at the NEXT start / output choice / TV-mode exit. On the `createMultiToggleSubview` factory; the NAMES
// `obConfig`/`renderOutputBehaviorView` stay (renderer/ipc.js references them directly). Load order: AFTER settings-toggle.js.

let obConfig = { keepOtherMonitors: false, standbyOnExit: false, cecPowerOn: true };

// The visible rows — the CEC ones only if there is CEC. `key` is the `display` flag.
function obRows() {
    const rows = [{ key: 'keepOtherMonitors', labelKey: 'sv.obKeepMonitors' }];
    if (tvCaps && tvCaps.cec) {
        rows.push({ key: 'standbyOnExit', labelKey: 'sv.obStandby' });
        rows.push({ key: 'cecPowerOn', labelKey: 'sv.obCecPowerOn' });
    }
    return rows;
}

const outputBehaviorView = createMultiToggleSubview({
    id: 'output-behavior',
    hintKey: 'hint.toggle',
    rows: obRows,
    getState: () => obConfig,
    setState: (next) => { obConfig = next; },
    persist: (patch) => window.launcher.setOutputBehavior(patch),
    preload: async () => {
        const cfg = await window.launcher.getDisplayConfig().catch(() => null);
        obConfig = {
            keepOtherMonitors: !!(cfg && cfg.keepOtherMonitors),
            standbyOnExit: !!(cfg && cfg.standbyOnExit),
            cecPowerOn: !cfg || cfg.cecPowerOn !== false,
        };
    },
});

function renderOutputBehaviorView() { outputBehaviorView.render(); }

SETTINGS_VIEWS['output-behavior'] = outputBehaviorView;
