// Settings → Controllers → "Button layout" subview — read-only: the buttons of the home screen, the PS combos and the Games panel
// (`CONTROLS_HELP` of renderer/controller/controller-help.js — the same table as the setup wizard's "Button layout" step). The glyphs follow
// the active controller type. ▲▼ = scroll (the focus steps on the rows), ○/PS = back. Load order: after settings.js.

let controlsHelpFocus = 0;
let controlsHelpButtonStates = {};

function controlsHelpSections() {
    return CONTROLS_HELP.map((sec) => ({ title: tr(sec.titleKey), ok: true, items: sec.rows }));
}

function openControlsHelpView() {
    controlsHelpButtonStates = { cross: true }; // the entering ✕ may still be held
    controlsHelpFocus = 0;
    $('settingsPanelTitle').textContent = tr('menu.controls');
    $('settingsPanelHint').innerHTML = `
        <span>▲▼ ${esc(tr('hint.nav'))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>`;
    renderControlsHelpView();
}

function renderControlsHelpView() {
    $('settingsContent').innerHTML = renderFlatSections(controlsHelpSections(), controlsHelpFocus, (row) =>
        `<span class="controls-help-row"><span class="controls-help-keys">${controlsHelpKeysHtml(row)}</span><span class="bt-name">${esc(tr(row.textKey, row.params ? row.params() : undefined))}</span></span>`);
    scrollSettingsFocusIntoView();
}

function handleControlsHelpInput(gp) {
    const count = flatSectionItemCount(controlsHelpSections());
    navList(gp, controlsHelpButtonStates, {
        count,
        move: (d, repeated) => { controlsHelpFocus = stepIndex(controlsHelpFocus, d, count, repeated); renderControlsHelpView(); },
        onSelect: () => { },
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['controls'] = { open: openControlsHelpView, handle: handleControlsHelpInput };
