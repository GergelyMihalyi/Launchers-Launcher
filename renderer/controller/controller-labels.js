// Button labels matching the active controller type + the shared helper of the hint builders. Which pad's type drives the labels: (1)
// `mainController.type` if set; (2) the type of the last pad showing activity (gamepad.js `noteActivePadType`); (3) 'playstation'. The
// SYMBOL is type-dependent (`controllerSymbols`, controller-id.js); the WORD belongs to the caller (hint context) or `tr()`. Load order:
// AFTER controller-id.js, BEFORE every hint builder. Exported (test/controller/controller-labels.test.js).
// Background: docs/dev/renderer/input.md#button-labels-per-controller-type

let lclMainControllerType = null;   // the type of the configured main controller (written by ipc.js / main.js)
let lclLastActivePadType = null;    // the type of the last active pad (written by gamepad.js)
let lclResolvedControllerType = 'playstation'; // the type LAST RENDERED (for the notify's edge detection)
let lclTypeChangeHandler = null; // wired to the actual UI redraw by the renderer/main.js init

// Wiring of the UI redraw (renderer/main.js): runs on a controller type change.
function setControllerTypeChangeHandler(fn) {
    lclTypeChangeHandler = typeof fn === 'function' ? fn : null;
}

function activeControllerType() {
    return lclMainControllerType || lclLastActivePadType || 'playstation';
}

// The { confirm, back, menu, alt, home } symbol set of the current type.
function controllerHintSymbols() {
    return controllerSymbols(activeControllerType());
}

// The .btn-icon CSS class stays STABLE (btn-x / btn-ps / btn-triangle / btn-square / btn-view / btn-start) — only the glyph changes, so
// styles/*.css + the theme overrides are untouched. `view` = Settings (buttons[8]), `start` = quick system menu (buttons[9],
// renderer/home/quick-power.js).
const BTN_ICON_ACTION_CLASS = {
    confirm: 'btn-x', back: 'btn-ps', menu: 'btn-triangle', alt: 'btn-square', home: 'btn-ps',
    view: 'btn-view', start: 'btn-start',
};

// The `<span class="btn-icon …">SYM</span>` markup — every .settings-panel-hint / #setupPanelHint / #gamesPanelHint row calls this instead
// of a hard-coded `<span …>✕</span>`.
function btnIcon(action) {
    const sym = controllerHintSymbols()[action] || '?';
    return `<span class="btn-icon ${BTN_ICON_ACTION_CLASS[action] || ''}">${sym}</span>`;
}

// The raw glyph only (for plain-text hint places: the carousel press hint "[ ✕ ]", settings-empty "○ BACK").
function btnGlyph(action) {
    return controllerHintSymbols()[action] || '?';
}

// Only triggers a redraw if the ACTUAL active type changed (pad switch / setting the main controller) — per-frame pad activity does not
// trigger rendering.
function maybeNotifyControllerType() {
    const now = activeControllerType();
    if (now === lclResolvedControllerType) return;
    lclResolvedControllerType = now;
    if (lclTypeChangeHandler) lclTypeChangeHandler();
}

function setMainControllerType(type) {
    lclMainControllerType = type || null;
    maybeNotifyControllerType();
}

function noteActivePadType(type) {
    if (!type || type === lclLastActivePadType) return;
    lclLastActivePadType = type;
    maybeNotifyControllerType();
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { activeControllerType, controllerHintSymbols, btnIcon, btnGlyph, setMainControllerType, noteActivePadType, setControllerTypeChangeHandler });
}
