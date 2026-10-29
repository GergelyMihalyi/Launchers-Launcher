// Skeleton of the Settings panel: category list <-> item list <-> subview switching, shared helpers (scrolling, error view), the main input
// dispatcher. The subviews live in separate renderer/settings/settings-*.js files. Load order: AFTER gamepad.js, BEFORE settings-*.js; AFTER
// ipc.js / main.js. Layout: the left column (#settingsMenuList) only shows the categories; the right one (#settingsContent) the focused
// category's item list ("items" zone), then, once an item is chosen, the subview ("content" zone) — the right side follows the left focus LIVE.
// A NEW SUBVIEW = 2 places: a `SETTINGS_MENU` row (with `group:` pointing to an existing SETTINGS_GROUPS category) + a `settings-<id>.js` that
// registers `SETTINGS_VIEWS['<id>'] = { open, handle }` at its bottom (`test/contracts/settings-views.test.js` guards the pairing at source
// level, and that every `group` is an existing category). 8 categories, none with more than 7-8 items; the order follows the expected
// frequency. Background: docs/dev/renderer/settings.md#panel-structure
const SETTINGS_GROUPS = [
    { id: 'output', label: 'Display & audio' },
    { id: 'games', label: 'Games' },
    { id: 'apps', label: 'Launchers' },
    { id: 'devices', label: 'Controllers' },
    { id: 'startup', label: 'Startup' },
    { id: 'look', label: 'Appearance' },
    { id: 'energy', label: 'Power and network' },
    { id: 'system', label: 'System' },
];

const SETTINGS_MENU = [
    { id: 'audio-sink', label: 'Audio output', group: 'output' },
    { id: 'startup-output', label: 'Startup display & audio', group: 'output' },
    { id: 'output-behavior', label: 'Displays & TV (CEC)', group: 'output' },
    { id: 'volume-step', label: 'Volume step', group: 'output' },
    { id: 'volume-max', label: 'Volume limit', group: 'output' },
    { id: 'screen-dim', label: 'Brightness', group: 'output' },
    { id: 'night-mode', label: 'Night mode', group: 'output' },
    { id: 'games-view', label: 'Grid or list', group: 'games' },
    { id: 'recent-games', label: 'Recently played bars', group: 'games' },
    { id: 'cover-download', label: 'Cover download', group: 'games' },
    { id: 'games-cache', label: 'Clear cache', group: 'games' },
    { id: 'rom-access', label: 'ROM folder permissions', group: 'games' },
    { id: 'stats', label: 'Playtime', group: 'games' },
    { id: 'playtime-reminder', label: 'Play-time reminder', group: 'games' },
    { id: 'save-backup', label: 'Back up game saves', group: 'games' },
    { id: 'launchers', label: 'Launchers', group: 'apps' },
    { id: 'launcher-order', label: 'Launcher order', group: 'apps' },
    { id: 'melonds-rom-dirs', label: 'melonDS ROM folders', group: 'apps' },
    { id: 'bt-controller', label: 'Bluetooth controllers', group: 'devices' },
    { id: 'controls', label: 'Controls', group: 'devices' },
    { id: 'bt-headset', label: 'Bluetooth audio devices', group: 'devices' },
    { id: 'idle-disconnect', label: 'Disconnect controllers when idle', group: 'devices' },
    { id: 'start-with-system', label: 'Start on login', group: 'startup' },
    { id: 'controller-autostart', label: 'Start on controller connect', group: 'startup' },
    { id: 'main-controller', label: 'Main controller', group: 'startup' },
    { id: 'tv-mode', label: 'Close apps on TV mode', group: 'startup' },
    { id: 'tv-exit-hold', label: 'TV mode exit hold', group: 'startup' },
    { id: 'always-on-top', label: 'Always on top', group: 'startup' },
    { id: 'do-not-disturb', label: 'Do not disturb while playing', group: 'startup' },
    { id: 'theme', label: 'Theme', group: 'look' },
    { id: 'background', label: 'Background', group: 'look' },
    { id: 'ui-scale', label: 'Interface size', group: 'look' },
    { id: 'language', label: 'Language', group: 'look' },
    { id: 'feedback', label: 'Sound & rumble', group: 'look' },
    { id: 'accessibility', label: 'Accessibility', group: 'look' },
    { id: 'tips', label: 'Tips', group: 'look' },
    { id: 'idle-timeout', label: 'Screensaver', group: 'look' },
    { id: 'wifi', label: 'Wi-Fi', group: 'energy' },
    { id: 'power', label: 'Power', group: 'energy' },
    { id: 'sleep-timer', label: 'Sleep timer', group: 'energy' },
    { id: 'auto-suspend', label: 'Automatic sleep', group: 'energy' },
    { id: 'update', label: 'Update', group: 'system' },
    { id: 'setup-rerun', label: 'Setup wizard', group: 'system' },
    { id: 'config-backups', label: 'Settings backups', group: 'system' },
    { id: 'settings-transfer', label: 'Transfer settings', group: 'system' },
    { id: 'diagnostics', label: 'Diagnostics', group: 'system' },
    { id: 'log', label: 'Log', group: 'system' },
];

// The items of the active category (in SETTINGS_MENU order). At the end of the category list there is a virtual "🔍 Search" row (index =
// SETTINGS_GROUPS.length) — not a category.
const onSearchRow = () => settingsGroupIndex >= SETTINGS_GROUPS.length;
const groupItems = (gi) => (gi >= SETTINGS_GROUPS.length ? [] : SETTINGS_MENU.filter((m) => m.group === SETTINGS_GROUPS[gi].id));

// Subview registry: id -> { open(), handle(gp) }. Every settings-<id>.js fills it at its bottom (load order: settings.js FIRST). A write-once
// table, like the CH map.
const SETTINGS_VIEWS = {};

// The id of the CURRENTLY loaded subview (`#settingsContent`, in the 'content' zone); `null` if no subview is loaded yet (categories/items
// zone).
let settingsView = null;
// Which zone has the FOCUS: 'categories' (left / #settingsMenuList, always only the top-level items) | 'items' (right / #settingsContent, the
// focused category's item list) | 'content' (right / #settingsContent, the chosen subview — it replaces the item list).
let settingsZone = 'categories';
let settingsGroupIndex = 0; // which category is active (the left focus OR the source of the right-hand preview)
let settingsMenuFocusIndex = 0; // focus within the ACTIVE category's item list (items zone)
// The edge state of the category list (left column) = `settingsPanel.states` (the factory refreshes it on open); the item list's is separate
// (set on a zone switch).
let settingsItemsButtonStates = {};

// `kind` -> settingsView name for the shared BT subview (settings-bt.js, ipc.js calls it too).
const viewFor = (kind) => 'bt-' + kind;

// Lifecycle on the shared `createOverlay` (renderer/util.js).
const settingsPanel = createOverlay({
    elementId: 'settingsOverlay',
    // Select opens it (the category list does not watch it) → empty entry state. The main navigation's buttonStates were not updated while the
    // panel was open: the main branch would misread a still held X/PS (immediate launch / quit), and Share/View (`select`, the panel opener)
    // would stay "stuck".
    syncOnClose: () => ({ states: buttonStates, keys: ['cross', 'ps', 'select'] }),
    onOpen: () => {
        settingsView = null;
        settingsZone = 'categories';
        showTipOnce('settings');
        settingsSearchQuery = '';
        setSettingsSearchDock(false);
        // Location memory (only for the current run): the category + the item-list focus stay as at the last close (the module variables are not
        // reset) — the panel opens on the category list, ✕ steps to the last item; it does NOT step back into a subview by itself.
        // `openSettingsView(id)` (e.g. the Log jump) overrides it after opening.
        if (settingsGroupIndex > SETTINGS_GROUPS.length) { settingsGroupIndex = 0; settingsMenuFocusIndex = 0; }
        renderCategoryList();
        renderCategoryItems();
    },
    onClose: () => {
        settingsView = null;
        settingsZone = 'categories';
    },
});

function openSettings() { settingsPanel.open(); }

function closeSettings(gp) { settingsPanel.close(gp); }

// Item list (items zone) ○/PS: the FOCUS goes back to the left column (category list). Does NOT close the panel.
function backToCategories(gp) {
    settingsZone = 'categories';
    // While we were in the item list, the category list's button watching was not updated — sync the still held back button/X, otherwise the
    // next frame would see a new press (Circle/PS -> would close the panel immediately).
    if (gp) syncEdge(settingsPanel.states, gp, ['cancel', 'cross']);
    renderCategoryList();
    renderCategoryItems();
}

// ○/PS from a subview (content zone): back to the item list (right column, items zone) — NOT to the category list and it does NOT close the
// panel. Every settings-<id>.js calls this.
function backToSettingsMenu(gp) {
    settingsZone = 'items';
    settingsView = null;
    // While we were in the subview, the item list's button watching was not updated — the same sync gotcha as above.
    if (gp) syncEdge(settingsItemsButtonStates, gp, ['cancel', 'cross']);
    // The subview overwrote its own title/hint — renderCategoryList() restores the "Settings — <group>" title (not the hint, which is untouched
    // because zone != categories).
    renderCategoryList();
    renderCategoryItems();
}

// Every subview's `renderXxx()` calls this at the end: scrolls the focused row into view in the scrollable list, so the bottom items of a
// long list are reachable too. `containerId` is `settingsContent` (default) for the subview / item list, `settingsMenuList` for the category
// list.
function scrollSettingsFocusIntoView(containerId) {
    requestAnimationFrame(() => {
        const el = document.querySelector('#' + (containerId || 'settingsContent') + ' .settings-item.focused');
        if (el) el.scrollIntoView({ block: 'nearest' });
    });
}

// A subview query failed (the main handler returned {ok:false}, e.g. pactl / kscreen-doctor / bluetoothctl timed out). An explicit message
// instead of a silent empty list - the "○ BACK" is in the panel hint anyway.
function renderSubviewError(msg) {
    $('settingsContent').innerHTML = emptyState(msg, `${btnGlyph('back')} ${tr('hint.back').toUpperCase()}`);
}

// Shared render core of a "sectioned, flat-focus-indexed, read-only list" (settings-stats.js / settings-diagnostics.js). The caller supplies
// its own `renderItem(item)` callback (this function adds the `<div class="settings-item…">` frame). `sections`: [{ title, items, ok?,
// emptyText?, note? }] — `ok === false` → `sv.diagQueryFailed` instead of the items; `note` goes BEFORE the items; empty `items` → `emptyText`.
function flatSectionItemCount(sections) {
    return sections.reduce((n, s) => n + (s.ok === false ? 0 : s.items.length), 0);
}

function renderFlatSections(sections, focusIndex, renderItem) {
    let html = '';
    let flatIndex = 0;
    for (const section of sections) {
        html += `<div class="settings-subhead">${esc(section.title)}</div>`;
        if (section.ok === false) { html += emptyState(tr('sv.diagQueryFailed')); continue; }
        if (section.note) html += emptyState(section.note);
        if (!section.items.length) {
            if (section.emptyText) html += emptyState(section.emptyText);
            continue;
        }
        for (const item of section.items) {
            const focused = flatIndex === focusIndex ? ' focused' : '';
            html += `<div class="settings-item${focused}">${renderItem(item)}</div>`;
            flatIndex++;
        }
    }
    return html;
}

// Menu/subview labels go through `tr()` (the `label` of SETTINGS_GROUPS/SETTINGS_MENU is the no-JS fallback / the key-derived source —
// `group.<id>` / `menu.<id>`).
function groupLabel(g) { return tr('group.' + g.id); }
function menuLabel(item) { return tr('menu.' + item.id); }

// The shared skeleton of opening a subview: header + (optionally) the `subviewHint(hint)` help line + (optionally) the loading indicator.
// `title` is READY text (`tr(...)`), `hint` is the tr key of the confirming verb. A hint differing from the list is written by the subview
// itself (`settingsPanelHint`).
/** @param {{ title: string, hint?: string, skeleton?: boolean }} frame */
function setSubviewFrame({ title, hint, skeleton }) {
    $('settingsPanelTitle').textContent = title;
    if (hint !== undefined) $('settingsPanelHint').innerHTML = subviewHint(hint);
    if (skeleton) $('settingsContent').innerHTML = skeletonList();
}

// Shared subview panel hint: `▲▼ nav` + a confirming verb (tr key) + `back`. Most subviews show these three; hints differing from the list
// are built inline by their own `openXxxView()`.
function subviewHint(confirmKey) {
    return `
        <span>▲▼ ${esc(tr('hint.nav'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr(confirmKey))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>
    `;
}

// Left column: ALWAYS only the top-level items (categories), stacked — never their items. `.active` = this category is being previewed on the
// right (stays marked in the items/content zone too, so you see which category you are in); `.focused` only goes with the 'categories' zone
// (the focus-frame CSS on `.focused` excludes `.active`).
function renderCategoryList() {
    $('settingsPanelTitle').textContent = tr('settings.title') + (onSearchRow() ? '' : ' — ' + groupLabel(SETTINGS_GROUPS[settingsGroupIndex]));
    const searchActive = onSearchRow();
    const rows = SETTINGS_GROUPS.map((g, i) => {
        const active = i === settingsGroupIndex;
        const focused = settingsZone === 'categories' && active;
        return `<div class="settings-item ${active ? 'active' : ''} ${focused ? 'focused' : ''}">${esc(groupLabel(g))} ▸</div>`;
    }).join('') + `<div class="settings-item ${searchActive ? 'active' : ''} ${settingsZone === 'categories' && searchActive ? 'focused' : ''}">🔍 ${esc(tr('settings.search'))}</div>`;
    $('settingsMenuList').innerHTML = rows;
    // The category hint is only active if the focus is on the left column (in the items/content zone the right side writes its own hint).
    if (settingsZone === 'categories') {
        $('settingsPanelHint').innerHTML = `
            <span>▲▼ ${esc(tr('hint.nav'))}</span>
            <span>${btnIcon('confirm')} ${esc(tr('hint.enter'))}</span>
            <span>${btnIcon('back')} ${esc(tr('hint.close'))}</span>
        `;
    }
    scrollSettingsFocusIntoView('settingsMenuList');
}

// Right column: the focused category's item list — a live preview in the 'categories' zone (without focus marking), the actual navigable
// list in the 'items' zone. In the 'content' zone it is replaced by the loaded subview (enterSettingsItem() -> view.open()).
function renderCategoryItems() {
    if (onSearchRow()) {
        $('settingsContent').innerHTML = emptyState(tr('settings.searchTitle'), tr('settings.searchHint'));
        return;
    }
    const items = groupItems(settingsGroupIndex);
    if (settingsMenuFocusIndex >= items.length) settingsMenuFocusIndex = Math.max(0, items.length - 1);
    // One-line explanation: only on the focused row, also as aria-description for the screen reader.
    const rows = items.map((item, i) => {
        const focused = settingsZone === 'items' && i === settingsMenuFocusIndex;
        const desc = tr('menu.' + item.id + '.desc');
        if (!focused) return safeHtml`<div class="settings-item">${menuLabel(item)} ▸</div>`;
        return safeHtml`<div class="settings-item focused" aria-description="${desc}">${menuLabel(item)} ▸<span class="settings-item-desc">${desc}</span></div>`;
    }).join('');
    $('settingsContent').innerHTML = rows;
    if (settingsZone === 'items') {
        $('settingsPanelHint').innerHTML = subviewHint('hint.enter').replace(/<\/span>\s*$/, '</span>');
    }
    scrollSettingsFocusIntoView('settingsContent');
}

// Opens Settings directly in a subview (e.g. the Log jump after an error toast, renderer/gamepad.js): the left column is on its category,
// the right side on the view — ○/PS steps back the usual way from here (item list → categories → close).
function openSettingsView(id) {
    const item = SETTINGS_MENU.find((m) => m.id === id);
    if (!item) { openSettings(); return; }
    openSettings();
    settingsGroupIndex = Math.max(0, SETTINGS_GROUPS.findIndex((g) => g.id === item.group));
    settingsMenuFocusIndex = Math.max(0, groupItems(settingsGroupIndex).findIndex((m) => m.id === id));
    renderCategoryList();
    renderCategoryItems();
    enterSettingsItem();
}

// Loads the focused item's subview into the right column (replacing the item list), switches to the 'content' zone. NOT called in
// `openSettings()` (on open the right side shows the item list, not a preloaded subview) — only the X of `handleItemsInput()`
// (`enterSettingsFromItems`) calls it.
function enterSettingsItem() {
    const item = groupItems(settingsGroupIndex)[settingsMenuFocusIndex];
    const view = item && SETTINGS_VIEWS[item.id];
    if (!view) return;
    settingsView = item.id;
    view.open();
    if (!settingsPanel.isOpen()) return; // e.g. "setup-rerun" closed the panel + opened the wizard
    settingsZone = 'content';
}

function handleSettingsInput(gp) {
    if (settingsZone === 'search') {
        handleSettingsSearchInput(gp);
        return;
    }
    if (settingsZone === 'categories') {
        handleCategoriesInput(gp);
        return;
    }
    if (settingsZone === 'items') {
        handleItemsInput(gp);
        return;
    }
    const view = SETTINGS_VIEWS[settingsView];
    if (view) view.handle(gp);
}

// Category list (left column): ▲▼ = switch category — the right side shows the new category's item list LIVE, even without entering it. X =
// enter the item list (focus to the right). ○/PS = close the whole panel.
function handleCategoriesInput(gp) {
    navList(gp, settingsPanel.states, {
        count: SETTINGS_GROUPS.length + 1,
        move: (d, repeated) => {
            const n = SETTINGS_GROUPS.length + 1;
            settingsGroupIndex = stepIndex(settingsGroupIndex, d, n, repeated);
            settingsMenuFocusIndex = 0;
            renderCategoryList();
            renderCategoryItems();
        },
        onSelect: () => {
            if (onSearchRow()) { openSettingsSearch(); return; }
            settingsZone = 'items';
            // The X we entered with is still held at the moment of the zone switch — the items list's edge watching is set to that physical state,
            // otherwise the next frame would see a fresh press and jump straight into the subview too.
            settingsItemsButtonStates = { cross: true };
            renderCategoryList();
            renderCategoryItems();
        },
        onBack: () => closeSettings(gp),
    });
}

// Item list (right column, items zone): ▲▼ = item focus, X = load the subview (content zone), ○/PS = back to the category list (left focus).
function handleItemsInput(gp) {
    const items = groupItems(settingsGroupIndex);
    navList(gp, settingsItemsButtonStates, {
        count: items.length,
        move: (d, repeated) => {
            settingsMenuFocusIndex = stepIndex(settingsMenuFocusIndex, d, items.length, repeated);
            renderCategoryItems();
        },
        onSelect: () => enterSettingsItem(),
        onBack: () => backToCategories(gp),
    });
}
