// Settings → Appearance → "Sound and rumble": the navigation sound + controller rumble (`sound`/`rumble` of the `feedback` key). The other 4
// fields are in the "Accessibility" view (settings-accessibility.js) and write the SAME `feedbackState`. On the `createMultiToggleSubview`
// factory (settings-toggle.js); the NAMES `feedbackState`/`renderFeedbackView` stay (`onFeedbackChanged` of renderer/ipc.js references them
// directly). Load order: AFTER settings-toggle.js, BEFORE ipc.js / main.js.

const FEEDBACK_ROWS = [
    { key: 'sound', labelKey: 'sv.fbSound' },
    { key: 'rumble', labelKey: 'sv.fbRumble' },
];

const feedbackView = createMultiToggleSubview({
    id: 'feedback',
    hintKey: 'hint.toggle',
    rows: FEEDBACK_ROWS,
    getState: () => feedbackState,
    setState: (next) => { feedbackState = next; },
    persist: (patch) => window.launcher.setFeedback(patch),
});

function renderFeedbackView() { feedbackView.render(); }

SETTINGS_VIEWS['feedback'] = feedbackView;
