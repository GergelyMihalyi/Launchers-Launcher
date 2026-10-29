// Settings → Appearance → "Accessibility": animations, high contrast, slow repeat, screen reader. The same `feedback` key and
// `feedbackState` as the "Sound and rumble" view (settings-feedback.js), just another row list. On the `createMultiToggleSubview` factory
// (settings-toggle.js). Load order: AFTER settings-feedback.js, BEFORE ipc.js (`onFeedbackChanged` calls `renderAccessibilityView`).

const ACCESSIBILITY_ROWS = [
    { key: 'motion', labelKey: 'sv.fbMotion' },
    { key: 'contrast', labelKey: 'sv.fbContrast' },
    { key: 'slowRepeat', labelKey: 'sv.fbSlowRepeat' },
    { key: 'screenReader', labelKey: 'sv.fbScreenReader' },
];

const accessibilityView = createMultiToggleSubview({
    id: 'accessibility',
    hintKey: 'hint.toggle',
    rows: ACCESSIBILITY_ROWS,
    getState: () => feedbackState,
    setState: (next) => { feedbackState = next; },
    persist: (patch) => window.launcher.setFeedback(patch),
    afterToggle: (row) => {
        if (row.key === 'motion') applyMotionPref();   // refresh <html data-motion>
        if (row.key === 'contrast') applyContrastPref(); // refresh <html data-contrast>
        if (row.key === 'slowRepeat') applyRepeatPref();
        if (row.key === 'screenReader') applyScreenReaderPref();
    },
});

function renderAccessibilityView() { accessibilityView.render(); }

SETTINGS_VIEWS['accessibility'] = accessibilityView;
