// Settings → search: the "🔍 Search" row at the end of the category list (✕) opens a docked, live on-screen keyboard; the matches filter among
// the menu item titles + their one-line descriptions (`menu.<id>.desc`) + the category name (accent/case-insensitive, every word must match),
// ✕ on a match = open the subview. The pure core (`settingsSearchMatches`) is testable behind a `module.exports` guard
// (test/settings/settings-search.test.js). Load order: AFTER settings.js (SETTINGS_MENU/groupLabel/menuLabel).

/** Lowercase, accents stripped, non-letter/digit → space (the counterpart of the Games search normalizer). */
function settingsSearchNormalize(s) {
    return String(s == null ? '' : s)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * The menu items matching `query`. `fields(item)` = `{ label, desc, group }` (all text). Every word must occur as a
 * substring in one of the three fields; matches in the title (label) come first, both levels keep the original menu
 * order. Empty search → empty list.
 * @template T
 * @param {T[]} items @param {string} query @param {(item: T) => { label: string, desc: string, group: string }} fields
 * @returns {T[]}
 */
function settingsSearchMatches(items, query, fields) {
    const tokens = settingsSearchNormalize(query).split(' ').filter(Boolean);
    if (!tokens.length) return [];
    const inLabel = [];
    const other = [];
    for (const it of items) {
        const f = fields(it);
        const label = settingsSearchNormalize(f.label);
        const rest = settingsSearchNormalize(`${f.desc} ${f.group}`);
        const all = `${label} ${rest}`;
        if (!tokens.every((t) => all.includes(t))) continue;
        (tokens.every((t) => label.includes(t)) ? inLabel : other).push(it);
    }
    return inLabel.concat(other);
}

let settingsSearchQuery = '';
let settingsSearchFocus = 0;
let settingsSearchTyping = false;
let settingsSearchPrevZone = 'categories'; // which zone to step back to (○)

function settingsSearchResults() {
    return settingsSearchMatches(SETTINGS_MENU, settingsSearchQuery, (m) => ({
        label: menuLabel(m),
        desc: tr('menu.' + m.id + '.desc'),
        group: groupLabel(SETTINGS_GROUPS.find((g) => g.id === m.group) || { id: m.group }),
    }));
}

function renderSettingsSearch() {
    const results = settingsSearchResults();
    if (settingsSearchFocus >= results.length) settingsSearchFocus = Math.max(0, results.length - 1);
    $('settingsPanelTitle').textContent = `${tr('settings.title')} — ${tr('settings.search')}`;
    const cursor = settingsSearchTyping ? '▏' : '';
    const meta = settingsSearchQuery.trim()
        ? tr('settings.searchCount', { n: results.length })
        : tr('settings.searchHint');
    let html = `<div class="games-search"><span class="games-search-icon">🔍</span>`
        + `<span class="games-search-text">${esc(settingsSearchQuery)}${cursor}</span>`
        + `<span class="games-search-meta">${esc(meta)}</span></div>`;
    if (settingsSearchQuery.trim() && !results.length) {
        html += emptyState(tr('settings.searchEmpty', { q: settingsSearchQuery.trim() }));
    }
    html += results.map((m, i) => {
        const g = SETTINGS_GROUPS.find((x) => x.id === m.group);
        const focused = i === settingsSearchFocus;
        const descHtml = focused ? safeHtml`<span class="settings-item-desc">${tr('menu.' + m.id + '.desc')}</span>` : '';
        return safeHtml`<div class="settings-item${focused ? ' focused' : ''}">${menuLabel(m)} ${rawHtml(currentTag(g ? groupLabel(g) : '', { paren: true }))}${rawHtml(descHtml)}</div>`;
    }).join('');
    $('settingsContent').innerHTML = html;
    $('settingsPanelHint').innerHTML = `
        <span>▲▼ ${esc(tr('hint.nav'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('hint.enter'))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>`;
    scrollSettingsFocusIntoView();
}

function setSettingsSearchQuery(text) {
    settingsSearchQuery = String(text == null ? '' : text).slice(0, 40);
    settingsSearchFocus = 0;
    renderSettingsSearch();
}

// Select/View: starts the search (from the category or the item list; the keyboard is docked and live).
function openSettingsSearch() {
    if (keyboardPanel.isOpen()) return;
    if (settingsZone === 'categories' || settingsZone === 'items') settingsSearchPrevZone = settingsZone;
    settingsZone = 'search';
    settingsView = null;
    settingsSearchTyping = true;
    // The opening Select / ✕ may still be held — the search zone's edge state is set to it, and the keyboard syncs it on close too.
    settingsSearchButtonStates = { search: true, cross: true };
    feedback('nav');
    renderSettingsSearch();
    const before = settingsSearchQuery;
    openKeyboard({
        title: tr('settings.searchTitle'), initial: before, maxLength: 40,
        layout: 'compact', dock: 'bottom', live: true, ownerStates: settingsSearchButtonStates,
        onChange: (text) => setSettingsSearchQuery(text),
        onConfirm: (text) => { settingsSearchTyping = false; setSettingsSearchDock(false); setSettingsSearchQuery(text.trim()); },
        onCancel: () => { settingsSearchTyping = false; setSettingsSearchDock(false); setSettingsSearchQuery(before); },
    });
    requestAnimationFrame(() => {
        const panel = /** @type {HTMLElement|null} */ (document.querySelector('#keyboardOverlay .keyboard-panel'));
        if (!panel || !settingsSearchTyping) return;
        $('settingsOverlay').style.setProperty('--kb-h', `${panel.offsetHeight}px`);
        $('settingsOverlay').classList.add('kb-docked');
    });
}

function setSettingsSearchDock(on) {
    const ov = $('settingsOverlay');
    if (!ov) return;
    ov.classList.toggle('kb-docked', !!on);
    if (!on && ov.style && ov.style.removeProperty) ov.style.removeProperty('--kb-h');
}

function closeSettingsSearch(gp) {
    settingsSearchTyping = false;
    setSettingsSearchDock(false);
    settingsSearchQuery = '';
    settingsSearchFocus = 0;
    settingsZone = settingsSearchPrevZone;
    if (gp) syncEdge(settingsPanel.states, gp, ['cancel', 'cross']);
    if (settingsZone === 'items') settingsItemsButtonStates = { cross: true };
    renderCategoryList();
    renderCategoryItems();
}

// Opening a match: the left column moves to the menu item's category, the right side to the view (the `openSettingsView` path).
function openSettingsSearchResult() {
    const m = settingsSearchResults()[settingsSearchFocus];
    if (!m) return;
    settingsSearchQuery = '';
    setSettingsSearchDock(false);
    settingsGroupIndex = Math.max(0, SETTINGS_GROUPS.findIndex((g) => g.id === m.group));
    settingsMenuFocusIndex = Math.max(0, groupItems(settingsGroupIndex).findIndex((x) => x.id === m.id));
    renderCategoryList();
    renderCategoryItems();
    enterSettingsItem();
}

function handleSettingsSearchInput(gp) {
    const results = settingsSearchResults();
    navList(gp, settingsSearchButtonStates, {
        count: results.length,
        move: (d, repeated) => { settingsSearchFocus = stepIndex(settingsSearchFocus, d, results.length, repeated); renderSettingsSearch(); },
        onSelect: () => openSettingsSearchResult(),
        onBack: () => closeSettingsSearch(gp),
    });
}

let settingsSearchButtonStates = {};

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { settingsSearchNormalize, settingsSearchMatches });
}
