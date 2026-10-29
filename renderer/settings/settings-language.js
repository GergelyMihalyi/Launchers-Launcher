// Settings → Appearance → Language subview. ▲▼ = focus, ✕ = switch (live immediately + persisted), ○/PS = back. Load order: after
// settings.js.

let languageFocusIndex = 0;
let languageButtonStates = {};

function openLanguageView() {
    $('settingsPanelTitle').textContent = tr('lang.title');
    languageButtonStates = { cross: true };
    languageFocusIndex = Math.max(0, LANGUAGES.indexOf(activeLanguage()));
    renderLanguageView();
}

function renderLanguageView() {
    $('settingsPanelHint').innerHTML = `
        <span>▲▼ ${esc(tr('hint.nav'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('hint.select'))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>
    `;
    const cur = activeLanguage();
    $('settingsContent').innerHTML = LANGUAGES.map((lang, i) => {
        const tag = lang === cur ? ` ${currentTag()}` : '';
        return `<div class="settings-item ${i === languageFocusIndex ? 'focused' : ''}"><span class="bt-name">${esc(LANG_LABELS[lang] || lang)}</span>${tag}</div>`;
    }).join('');
    scrollSettingsFocusIntoView();
}

function selectLanguage() {
    const lang = LANGUAGES[languageFocusIndex];
    if (!lang || lang === activeLanguage()) return;
    setActiveLanguage(lang);
    window.launcher.setLanguage(lang);
    showStatus(tr('lang.changed', { lang: LANG_LABELS[lang] || lang }));
    applyLanguageEverywhere();
}

// After a language switch every VISIBLE `tr()`-based surface must be redrawn.
function applyLanguageEverywhere() {
    renderBottomBar();
    applyStaticLabels(); // static index.html text nodes (renderer/main.js)
    if (typeof cards !== 'undefined' && cards.length) renderCards(); // "Games" card name + press-hint verbs
    if (settingsPanel.isOpen()) {
        renderCategoryList(); // labels of the menu column (always in the DOM)
        renderCategoryItems(); // labels of the right-hand item list (items zone, if that is showing)
        if (settingsView === 'language') renderLanguageView();
        else if (settingsView) {
            const v = SETTINGS_VIEWS[settingsView];
            if (v && v.open) v.open(); // async subview: refetches, but the header/hint refresh immediately
        }
    }
    if (setupWizard.isOpen()) renderWizStep();
}

function handleLanguageInput(gp) {
    const n = LANGUAGES.length;
    navList(gp, languageButtonStates, {
        count: n,
        move: (d, repeated) => { languageFocusIndex = stepIndex(languageFocusIndex, d, n, repeated); renderLanguageView(); },
        onSelect: () => selectLanguage(),
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['language'] = { open: openLanguageView, handle: handleLanguageInput };
