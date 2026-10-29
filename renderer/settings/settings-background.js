// Settings → Appearance → "Background image". The background is set PER THEME (`background` = `{ "<themeId>": entry }`), the renderer always
// applies the ACTIVE theme's background. List: "None" + built-in SVGs (data/backgrounds.json) + custom images (~/Pictures/launchers-launcher/).
// ▲▼ = focus + LIVE preview, ✕ = persist, ○/PS = back (an unsaved preview is reverted). Load order: AFTER settings.js + settings-theme.js.
// Background: docs/dev/themes.md

let bgBuiltins = [];        // [{ id, label, swatch }]  a data/backgrounds.json manifeszt
let bgCustoms = [];         // [{ name, path }]          the images of ~/Pictures/launchers-launcher/
let bgFocusIndex = 0;
let bgButtonStates = {};
let bgMap = {};             // { "<themeId>": entry }    the saved backgrounds per theme
let bgAppliedThemeId = null; // which theme's background #bgCustom is painting right now
let bgViewTheme = null;     // the theme CURRENTLY edited in the subview (= currentTheme on open)
let bgViewSaved = { type: 'none' }; // the saved entry at entering the view (○/PS restores it)
let bgPersisted = false;    // whether we committed with ✕ in this view session

function bgNormalize(e) {
    if (!e || typeof e !== 'object') return { type: 'none' };
    if (e.type === 'builtin' && e.id) return { type: 'builtin', id: e.id };
    if (e.type === 'custom' && e.path) return { type: 'custom', path: e.path };
    return { type: 'none' };
}

function bgSame(a, b) {
    a = bgNormalize(a); b = bgNormalize(b);
    return a.type === b.type && a.id === b.id && a.path === b.path;
}

// Sets the whole per-theme map (called by the get-background init + the background-changed push).
function bgSetMap(map) {
    bgMap = (map && typeof map === 'object') ? map : {};
}

// Sets the `#bgCustom` layer to a SPECIFIC entry — the ONLY place that does this. `none` → hidden (the theme's .bg-glow shows).
// `builtin` → assets/backgrounds/<id>.svg. `custom` → fileUrl(path). The subview's live preview calls it directly.
function applyBackground(entry) {
    // renderer/boot/boot-theme.js writes the flicker-free startup background into <style id="__bootBg">; once the real applyBackground runs,
    // we empty it (otherwise the boot image would stick even after a "clear background" during the session).
    const boot = document.getElementById('__bootBg');
    if (boot) boot.textContent = '';
    const el = document.getElementById('bgCustom');
    const e = bgNormalize(entry);
    if (!el) return;
    if (e.type === 'builtin') {
        el.style.backgroundImage = `url("assets/backgrounds/${e.id}.svg")`;
        el.classList.add('active');
    } else if (e.type === 'custom') {
        el.style.backgroundImage = `url("${fileUrl(e.path)}")`;
        el.classList.add('active');
    } else {
        el.style.backgroundImage = '';
        el.classList.remove('active');
    }
}

// Applies a theme's saved background (called by the renderer/ipc.js init + `applyTheme` of settings-theme.js + the background-changed
// push — so the right background is painted on a theme switch too).
function applyBackgroundForTheme(themeId) {
    bgAppliedThemeId = themeId;
    applyBackground(bgMap[themeId] || { type: 'none' });
}

// Rows of the virtual list: None → built-ins → custom ones.
/** @returns {Array<{ type: string, id?: string, path?: string, label?: string, swatch?: string[] }>} */
function bgRows() {
    return [
        { type: 'none' },
        ...bgBuiltins.map((b) => ({ type: 'builtin', id: b.id, label: b.label, swatch: b.swatch })),
        ...bgCustoms.map((c) => ({ type: 'custom', path: c.path, label: c.name })),
    ];
}

function bgRowEntry(row) {
    if (!row || row.type === 'none') return { type: 'none' };
    if (row.type === 'builtin') return { type: 'builtin', id: row.id };
    return { type: 'custom', path: row.path };
}

function bgThemeLabel(themeId) {
    const t = (typeof THEMES !== 'undefined' && THEMES.find((x) => x.id === themeId));
    return (t && t.label) || themeId || 'neon';
}

async function openBackgroundView() {
    bgViewTheme = (typeof currentTheme !== 'undefined' && currentTheme) || 'neon';
    bgViewSaved = bgNormalize(bgMap[bgViewTheme]);
    bgPersisted = false;
    setSubviewFrame({ title: tr('menu.background'), hint: 'hint.apply', skeleton: true });
    const res = await window.launcher.listBackgrounds().catch(() => ({ ok: false }));
    if (settingsView !== 'background') return; // left meanwhile
    bgBuiltins = (res && res.builtin) || [];
    bgCustoms = (res && res.custom) || [];
    const rows = bgRows();
    const idx = rows.findIndex((r) => bgSame(bgRowEntry(r), bgViewSaved));
    bgFocusIndex = idx !== -1 ? idx : 0;
    bgButtonStates = { cross: true }; // entered with X — do not take it as an immediate selection
    renderBackgroundView();
}

function renderBackgroundView() {
    const rows = bgRows();
    const saved = bgNormalize(bgMap[bgViewTheme]); // the ACTIVE theme's SAVED background (not the preview)
    let html = `<div class="settings-subhead">${esc(tr('sv.bgForTheme', { theme: bgThemeLabel(bgViewTheme) }))}</div>`;
    let builtinHeadDone = false;
    let customHeadDone = false;
    rows.forEach((row, i) => {
        if (row.type === 'builtin' && !builtinHeadDone) {
            html += `<div class="settings-subhead">${esc(tr('sv.bgBuiltinHead'))}</div>`;
            builtinHeadDone = true;
        }
        if (row.type === 'custom' && !customHeadDone) {
            html += `<div class="settings-subhead">${esc(tr('sv.bgCustomHead'))}</div>`;
            customHeadDone = true;
        }
        const chosen = bgSame(bgRowEntry(row), saved);
        const tag = chosen ? ` ${currentTag()}` : '';
        const label = row.type === 'none' ? tr('sv.bgNone') : row.label;
        const swatch = row.swatch
            ? `<span class="theme-swatch">${row.swatch.map((c) => `<span style="background:${esc(c)}"></span>`).join('')}</span>`
            : '';
        html += `<div class="settings-item ${i === bgFocusIndex ? 'focused' : ''}">${swatch}<span class="bt-name">${esc(label)}</span>${tag}</div>`;
    });
    if (!bgCustoms.length) {
        html += `<div class="settings-subhead">${esc(tr('sv.bgCustomHead'))}</div>`;
        html += `<div class="settings-item settings-item-readonly"><span class="bt-name">${esc(tr('sv.bgCustomEmpty'))}</span></div>`;
    }
    $('settingsContent').innerHTML = html;
    scrollSettingsFocusIntoView();
}

function handleBackgroundInput(gp) {
    const rows = bgRows();
    navList(gp, bgButtonStates, {
        count: rows.length,
        move: (d, repeated) => {
            bgFocusIndex = stepIndex(bgFocusIndex, d, rows.length, repeated);
            applyBackground(bgRowEntry(rows[bgFocusIndex])); // live preview (visual only)
            renderBackgroundView();
        },
        onSelect: () => {
            const entry = bgRowEntry(rows[bgFocusIndex]);
            bgMap = { ...bgMap };
            if (entry.type === 'none') delete bgMap[bgViewTheme];
            else bgMap[bgViewTheme] = entry;
            applyBackground(entry);
            window.launcher.setBackground({ theme: bgViewTheme, cfg: entry });
            bgPersisted = true;
            renderBackgroundView(); // the "(current)" marker jumps to the selected row
        },
        onBack: () => {
            // If we only previewed (no ✕), restore the theme's saved background.
            if (!bgPersisted) applyBackground(bgViewSaved);
            backToSettingsMenu(gp);
        },
    });
}

SETTINGS_VIEWS['background'] = { open: openBackgroundView, handle: handleBackgroundInput };
