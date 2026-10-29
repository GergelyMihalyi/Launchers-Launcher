// Theme: `applyTheme` is the ONLY place that sets the <html data-theme> (and data-motion) attribute ('neon' is the default = no attribute).
// Persistence: the `theme` config key. The theme list comes from the `themes/themes.json` manifest (list-themes IPC) - the renderer/main.js
// init loads THEMES and injects the <link>s of the non-'neon' themes. Load order: after settings.js, before ipc.js / main.js (those reference
// applyTheme / THEMES / currentTheme / renderThemeList).

// `THEMES` = the theme manifest (renderer/state.js; loaded by the renderer/main.js init with the list-themes IPC, initial fallback: only
// `neon`). `currentTheme` is single-file state (only applyTheme writes it), so it stays here.
let currentTheme = 'neon';

// Inserts a <link rel="stylesheet" href="themes/<id>.css"> into the <head> for every non-'neon' theme (if not there yet). The CSP style-src
// 'self' file: allows it (the @import-ed Google Font at the top of the theme CSS loads from fonts.googleapis.com, allowed too).
function injectThemeLinks(manifest) {
    for (const t of manifest) {
        if (t.id === 'neon') continue;
        const href = `themes/${t.id}.css`;
        if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
    }
}

function applyTheme(id) {
    currentTheme = THEMES.some((t) => t.id === id) ? id : 'neon';
    if (currentTheme === 'neon') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', currentTheme);
    }
    applyMotionPref();
    applyContrastPref();
    // The background image is per theme — on a theme switch the new theme's background is painted. The guard: settings-background.js loads AFTER
    // settings-theme.js.
    if (typeof applyBackgroundForTheme === 'function') applyBackgroundForTheme(currentTheme);
    // Live refresh of the pixel-rpg launcher icon pixelation (renderer/home/carousel.js) — carousel.js loads BEFORE settings-theme.js, no typeof
    // guard needed.
    refreshIconPixelation();
}

// High contrast mode (<html data-contrast="high">, the :root[data-contrast="high"] rules of styles/*.css apply): pulls secondary text toward
// `--text`, turns off contrast-reducing decorations (blurred card background, scanline), strengthens borders. Theme-INDEPENDENT, purely the
// user switch (Settings → Appearance → Accessibility → High contrast, `feedback` config key `contrast: true`).
// "Slow repeat" — the rate of a held direction (renderer/util.js `edgeRepeat`).
function applyRepeatPref() {
    const on = typeof feedbackState !== 'undefined' && feedbackState.slowRepeat === true;
    setRepeatScale(on ? SLOW_REPEAT_SCALE : 1);
}

function applyContrastPref() {
    const on = typeof feedbackState !== 'undefined' && feedbackState.contrast === true;
    if (on) document.documentElement.setAttribute('data-contrast', 'high');
    else document.documentElement.removeAttribute('data-contrast');
}

// "Decorative animations off" (<html data-motion="off">, the global :root[data-motion="off"] * { animation/transition: none } rule of
// styles/*.css applies). Either of two sources turns it on: the theme manifest's `motion: "off"` OR the user switch (Settings → Appearance →
// Accessibility → Animations = OFF, `feedback` config key `motion: false`).
function applyMotionPref() {
    const active = THEMES.find((t) => t.id === currentTheme);
    const themeOff = !!(active && active.motion === 'off');
    const userOff = typeof feedbackState !== 'undefined' && feedbackState.motion === false;
    if (themeOff || userOff) {
        document.documentElement.setAttribute('data-motion', 'off');
    } else {
        document.documentElement.removeAttribute('data-motion');
    }
}

// Theme subview. X = apply + save immediately (does not close the panel), Circle/PS = back.
let themeFocusIndex = 0;
let themeButtonStates = {};

function openThemeView() {
    setSubviewFrame({ title: tr('menu.theme'), hint: 'hint.apply' });
    themeFocusIndex = Math.max(0, THEMES.findIndex((t) => t.id === currentTheme));
    // Entered from the menu with X; while it is held, it must not count as an immediate apply.
    themeButtonStates = { cross: true };
    renderThemeList();
}

function renderThemeList() {
    $('settingsContent').innerHTML = THEMES.map((t, i) => {
        // Preview strip from the manifest's `swatch: [--bg, --surface, --accent]` hexes. The hex format is guaranteed by test/themes.test.js; the
        // regex here is only defensive (invalid value -> transparent, no CSS injection into the style attribute).
        const chips = (Array.isArray(t.swatch) ? t.swatch : [])
            .map((c) => `<span style="background:${/^#[0-9a-fA-F]{6}$/.test(c) ? c : 'transparent'}"></span>`)
            .join('');
        const swatch = chips ? `<span class="theme-swatch">${chips}</span>` : '';
        const active = t.id === currentTheme ? ` ${currentTag(tr('sv.active'))}` : '';
        return `
        <div class="settings-item ${i === themeFocusIndex ? 'focused' : ''}">
            ${swatch}${esc(t.label)}${active}
        </div>`;
    }).join('');
    scrollSettingsFocusIntoView();
}

function handleThemeInput(gp) {
    navList(gp, themeButtonStates, {
        count: THEMES.length,
        move: (d, repeated) => { themeFocusIndex = stepIndex(themeFocusIndex, d, THEMES.length, repeated); renderThemeList(); },
        onSelect: () => {
            const t = THEMES[themeFocusIndex];
            if (!t) return;
            applyTheme(t.id);              // immediate live switch
            window.launcher.setTheme(t.id); // persist + feedback
            renderThemeList();
        },
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['theme'] = { open: openThemeView, handle: handleThemeInput };
