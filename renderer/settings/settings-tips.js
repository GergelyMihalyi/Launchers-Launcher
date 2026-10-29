// Settings → Appearance → "Tips" subview: the seen/total count of the first-use tips (renderer/home/tips.js) + "Show tips again" (✕ → the
// seen list is cleared, the tips pop up again). Load order: after settings.js (SETTINGS_VIEWS registry).

let tipsButtonStates = {};

function openTipsView() {
    tipsButtonStates = { cross: true }; // entered from the menu with ✕ — do not take it as an immediate execution
    setSubviewFrame({ title: tr('menu.tips'), hint: 'hint.select' });
    renderTipsView();
}

function renderTipsView() {
    const seen = TIPS.filter((t) => seenTips.has(t.id)).length;
    $('settingsContent').innerHTML = `<div class="settings-subhead">${esc(tr('sv.tipsHint'))}</div>`
        + `<div class="changelog-para">${esc(tr('sv.tipsSeen', { n: seen, total: TIPS.length }))}</div>`
        + `<div class="settings-item focused"><span class="bt-name">↺ ${esc(tr('sv.tipsReset'))}</span></div>`;
}

function handleTipsInput(gp) {
    edge(tipsButtonStates, 'cross', gp.buttons[BTN.cross]?.pressed, () => {
        feedback('launch');
        resetSeenTips();
        showStatus(tr('toast.tipsReset'));
        renderTipsView();
    });
    edge(tipsButtonStates, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        backToSettingsMenu(gp);
    });
}

SETTINGS_VIEWS['tips'] = { open: openTipsView, handle: handleTipsInput };
