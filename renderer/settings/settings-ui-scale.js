// Settings → Appearance → "Interface size": Smaller / Normal / Larger — `<html data-ui-scale>` + the `--ui-scale` multiplier in the `html`
// font-size (does NOT affect the carousel's `vh`-clamped cards). `uiScale` key (lib/prefs.js whitelist). On the `createSelectSubview` factory;
// the NAME `renderUiScaleView` stays (`onUiScaleChanged` of renderer/ipc.js calls it). Load order: AFTER settings.js.

let currentUiScale = 'normal';

const UI_SCALE_ROWS = [
    { id: 'small', labelKey: 'sv.uiScaleSmall' },
    { id: 'normal', labelKey: 'sv.uiScaleNormal' },
    { id: 'large', labelKey: 'sv.uiScaleLarge' },
];

// Sets `<html data-ui-scale>` (called by renderer/ipc.js at startup + on `ui-scale-changed`).
function applyUiScale(id) {
    currentUiScale = UI_SCALE_ROWS.some((r) => r.id === id) ? id : 'normal';
    const root = document.documentElement;
    if (currentUiScale === 'normal') root.removeAttribute('data-ui-scale');
    else root.setAttribute('data-ui-scale', currentUiScale);
}

const uiScaleView = createSelectSubview({
    id: 'ui-scale',
    rows: UI_SCALE_ROWS,
    getCurrent: () => currentUiScale,
    onSelect: (row) => {
        if (row.id === currentUiScale) return;
        applyUiScale(row.id);                 // immediate live effect
        window.launcher.setUiScale(row.id);   // persist + feedback
    },
});

function renderUiScaleView() { uiScaleView.render(); }

SETTINGS_VIEWS['ui-scale'] = uiScaleView;
