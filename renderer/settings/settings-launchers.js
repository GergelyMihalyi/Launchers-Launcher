// Settings → Launchers subview (there is NO fixed built-in launcher). The active launchers at the top (ALL removable, X = remove), below
// the catalog entries not active yet (X = add). A choice does NOT close the panel; the `launchers-changed` feedback (ipc.js) redraws it.
// Load order: after settings.js, before ipc.js.

let launchersCatalog = [];
let launchersViewRows = [];
let launchersViewFocusIndex = 0;
let launchersViewButtonStates = {};

// "+ Add launcher" wizard (settings-launcher-add.js) for adding a program outside the catalog; created lazily on first use.
let launcherAddFlow = null;
// Custom ROM-folder source (settings-launcher-roms.js) — lazily.
let launcherRomsFlow = null;
// Native/flatpak variant picker — only opens if BOTH variants of a catalog entry with `nativeCmd` are installed (`installed === 'both'`):
// when adding (`mode: 'add'`), or on □ of an already added launcher (`mode: 'switch'`, switching the variant). Flatpak is the recommended
// one (first). null | { entry, focus, mode, current? }.
let variantPick = null;
// □ per-row menu: null | { entry, row, items: string[], focus }.
// Items: 'variant' (both variants installed) · 'setPath' (set the folder by hand) · 'clearPath'.
let launcherRowMenu = null;
// The manual folder flow (settings-launcher-path.js) — created lazily on first use.
let launcherPathFlow = null;

function getLauncherPathFlow() {
    if (!launcherPathFlow) {
        launcherPathFlow = createLauncherPathFlow({
            viewId: 'launchers',
            ui: { content: 'settingsContent', title: 'settingsPanelTitle', hint: 'settingsPanelHint' },
            isActive: () => settingsView === 'launchers',
            scroll: () => scrollSettingsFocusIntoView(),
            apply: true,
            onDone: () => { reloadLaunchersCatalog().catch(ignoreError); },
            onClose: (gp) => backToLaunchersList(gp),
        });
    }
    return launcherPathFlow;
}

function getLauncherRomsFlow() {
    if (!launcherRomsFlow) {
        launcherRomsFlow = createLauncherRomsFlow({
            isActive: () => settingsView === 'launchers',
            scroll: () => scrollSettingsFocusIntoView(),
            onClose: (gp) => backToLaunchersList(gp),
        });
    }
    return launcherRomsFlow;
}

// Can it get a custom ROM-folder source: every added launcher that has NO game list of its own (Heroic and the launchers of
// `LAUNCHER_ID_TO_GAMES_SOURCE` — Steam/Lutris/RetroArch/emulators — do).
function launcherCanHaveRomSource(id) {
    return id !== 'heroic' && !LAUNCHER_ID_TO_GAMES_SOURCE[id];
}

function getLauncherAddFlow() {
    if (!launcherAddFlow) {
        launcherAddFlow = createLauncherAddFlow({
            isActive: () => settingsView === 'launchers',
            scroll: () => scrollSettingsFocusIntoView(),
            onClose: (gp) => backToLaunchersList(gp),
        });
    }
    return launcherAddFlow;
}

async function fetchLaunchersCatalog() {
    const catalog = await window.launcher.listLauncherCatalog();
    // The `common` ones (steam/heroic/retroarch) first, then the installed ones, then by name.
    return (catalog || []).slice().sort((a, b) =>
        (Number(!!b.common) - Number(!!a.common))
        || (Number(!!b.installed) - Number(!!a.installed))
        || a.name.localeCompare(b.name));
}

// Reruns the install detection (after setting / clearing a manual folder) + redraws the list.
async function reloadLaunchersCatalog() {
    const catalog = await fetchLaunchersCatalog();
    if (settingsView !== 'launchers') return;
    launchersCatalog = catalog;
    // The ✕ that triggered the save may still be held — the main list must not take it as a new selection.
    launchersViewButtonStates.cross = true;
    backToLaunchersList(null);
}

// Back to the main list from a sub-flow (menu / folder browser); syncs the still held buttons so the frame after the return does not take
// them as fresh presses.
function backToLaunchersList(gp) {
    launcherRowMenu = null;
    $('settingsPanelTitle').textContent = tr('menu.launchers');
    if (gp) syncEdge(launchersViewButtonStates, gp, ['cross', 'cancel', 'square']);
    refreshLaunchersRows();
}

async function openLaunchersView() {
    setSubviewFrame({ title: tr('menu.launchers'), hint: 'hint.addRemove', skeleton: true });
    launcherRowMenu = null;
    if (launcherPathFlow) launcherPathFlow.reset();
    if (launcherAddFlow) launcherAddFlow.reset();
    if (launcherRomsFlow) launcherRomsFlow.reset();
    const catalog = await fetchLaunchersCatalog();
    if (settingsView !== 'launchers') return; // left the subview meanwhile
    launchersCatalog = catalog;
    launchersViewFocusIndex = 0;
    // Entered from the menu with X; while it is held, it must not count as an immediate selection.
    launchersViewButtonStates = { cross: true };
    refreshLaunchersRows();
}

// Rows of the shared list: the ACTIVE launchers (`launchers`, ALL removable) → the catalog entries not active yet → "＋ Add another
// program…" (the wizard).
function buildLaunchersRows() {
    /** @type {Array<{ type: string, id: string, name: string, installed?: any, variant?: string|null, switchable?: boolean, hasMenu?: boolean }>} */
    const rows = launchers.map((l) => {
        const variant = activeLauncherVariant(l);
        const entry = launchersCatalog.find((c) => c.id === l.id);
        return {
            type: 'active', id: l.id, name: l.name, variant,
            switchable: !!(variant && entry && entry.installed === 'both'),
            hasMenu: !!(entry && entry.nativeCmd) || launcherCanHaveRomSource(l.id),
        };
    });
    const activeIds = new Set(launchers.map((l) => l.id));
    for (const e of launchersCatalog) {
        if (activeIds.has(e.id)) continue;
        rows.push({ type: 'catalog', id: e.id, name: e.name, installed: e.installed, hasMenu: !!e.nativeCmd });
    }
    rows.push({ type: 'add-wizard', id: '__add_wizard__', name: tr('sv.addLauncherWizard') });
    return rows;
}

// The variant of an added launcher relative to the catalog's dual-variant (`nativeCmd`) entry: 'native' | 'flatpak' | null (not dual /
// hand-edited). A simplified mirror of the main-side `launcherVariantOf` (lib/launcher-list.js) — for display only.
function activeLauncherVariant(l) {
    const entry = launchersCatalog.find((c) => c.id === l.id);
    if (!entry || !entry.nativeCmd) return null;
    const natives = Array.isArray(entry.nativeCmds) ? entry.nativeCmds : [entry.nativeCmd];
    if (natives.includes(l.cmd)) return 'native';
    if (l.cmd === 'flatpak') return 'flatpak';
    return null;
}

// The list's bottom help line: □ for the focused, switchable (both variants installed) active launcher.
function launchersListHint() {
    const row = launchersViewRows[launchersViewFocusIndex];
    const alt = row && row.hasMenu ? `<span>${btnIcon('alt')} ${esc(tr('sv.hintLauncherMore'))}</span>` : '';
    return subviewHint('hint.addRemove') + alt;
}

// Rebuilds the rows (after add/remove or entry), restores the focus onto the same id if possible, otherwise clamps it.
function refreshLaunchersRows() {
    const prevRow = launchersViewRows[launchersViewFocusIndex];
    const prevId = prevRow ? prevRow.id : null;
    launchersViewRows = buildLaunchersRows();
    let idx = prevId ? launchersViewRows.findIndex((r) => r.id === prevId) : -1;
    if (idx < 0) idx = Math.min(launchersViewFocusIndex, launchersViewRows.length - 1);
    launchersViewFocusIndex = Math.max(0, idx);
    renderLaunchersList();
}

function renderLaunchersList() {
    if (launcherRowMenu) { renderLauncherRowMenu(); return; }
    if (launcherAddFlow && launcherAddFlow.isOpen()) { launcherAddFlow.render(); return; }
    if (launcherRomsFlow && launcherRomsFlow.isOpen()) { launcherRomsFlow.render(); return; }
    if (variantPick) { renderVariantPick(); return; }
    const listEl = $('settingsContent');
    let html = `<div class="settings-subhead">${esc(tr('sv.subActiveLaunchers'))}</div>`;
    const catalogCount = launchersViewRows.filter((r) => r.type === 'catalog').length;
    let availHeadDone = false;
    const availHead = () => {
        if (availHeadDone) return '';
        availHeadDone = true;
        return `<div class="settings-subhead">${esc(tr('sv.subAvailableLaunchers'))}</div>`;
    };
    launchersViewRows.forEach((row, i) => {
        const focused = i === launchersViewFocusIndex ? ' focused' : '';
        if (row.type === 'catalog') {
            html += availHead();
            let tag = '';
            if (row.installed === false) tag = ` <span class="tag-warn">${esc(tr('sv.tagNotInstalled'))}</span>`;
            else if (row.installed === 'native') tag = ` ${currentTag(tr('sv.tagInstalledNative'))}`;
            else if (row.installed === 'both') tag = ` ${currentTag(tr('sv.tagInstalledBoth'))}`;
            else if (row.installed) tag = ` ${currentTag(tr('sv.tagInstalled'))}`;
            const manual = launchersCatalog.find((c) => c.id === row.id && c.manualPath);
            const path = manual ? ` <span class="bt-disamb">${esc(manual.manualPath)}</span>` : '';
            html += `<div class="settings-item${focused}"><span class="bt-name">${esc(row.name)}</span>${tag}${path}</div>`;
        } else if (row.type === 'add-wizard') {
            html += availHead();
            if (!catalogCount) html += emptyState(tr('sv.allCatalogAdded'));
            html += `<div class="settings-item${focused}"><span class="bt-name">＋ ${esc(row.name)}</span></div>`;
        } else {
            const variant = row.variant
                ? ` <span class="bt-disamb">${esc(tr(row.variant === 'native' ? 'sv.tagVariantNative' : 'sv.tagVariantFlatpak'))}</span>` : '';
            html += `<div class="settings-item${focused}"><span class="bt-name">${esc(row.name)}</span> ${currentTag(tr('sv.tagAdded'))}${variant}</div>`;
        }
    });
    listEl.innerHTML = html;
    $('settingsPanelHint').innerHTML = launchersListHint();
    scrollSettingsFocusIntoView();
}

function selectLaunchersRow(gp) {
    const row = launchersViewRows[launchersViewFocusIndex];
    if (!row) return;
    if (row.type === 'add-wizard') {
        getLauncherAddFlow().open();
        return;
    }
    if (row.type === 'active') {
        window.launcher.removeLauncher(row.id);
        return;
    }
    // catalog: not installed + has a Flathub id → in-app installer panel; for a dual-variant entry with `nativeCmd`: only native present → add it
    // natively right away (no flatpak offer); both present → the user chooses (variantPick); otherwise (installed flatpak / no flathubId) a simple
    // add from the catalog id (main takes over the catalog's cmd/args).
    const entry = launchersCatalog.find((c) => c.id === row.id);
    if (row.installed === 'both' && entry) {
        openVariantPick(entry);
        return;
    }
    if (row.installed === 'native' && entry) {
        window.launcher.addLauncher(nativeLauncherEntry(entry));
        showStatus(tr('sv.customAdded', { name: entry.name.toUpperCase() }));
        return;
    }
    if (row.installed === false && entry && entry.flathubId) {
        openLauncherInstall(entry, launchersViewButtonStates);
        return;
    }
    if (row.installed === false) {
        showStatus(tr('launchers.notInstalled', { name: row.name.toUpperCase() }), true);
    }
    window.launcher.addLauncher(row.id);
}

// --- Native/flatpak variant picker ---

function nativeLauncherEntry(entry) {
    return {
        id: entry.id, name: entry.name, hint: entry.hint || '', icon: entry.icon || '',
        cmd: entry.nativeCmd, args: Array.isArray(entry.nativeArgs) ? entry.nativeArgs.slice() : [],
        ...(isAccentColorLocal(entry.accent) ? { accent: entry.accent } : {}),
    };
}

// `isAccentColor` (hex validation) only lives in `lib/` — the renderer uses a minimal local mirror of it here (not critical data, best effort).
function isAccentColorLocal(v) {
    return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

// The order: 0 = flatpak (recommended), 1 = native. When switching, the focus starts on the OTHER variant.
const VARIANT_PICK_ORDER = ['flatpak', 'native'];

function openVariantPick(entry, mode = 'add', current = null) {
    const focus = mode === 'switch' && current === 'flatpak' ? 1 : 0;
    variantPick = { entry, focus, mode, current };
    setSubviewFrame({ title: tr(mode === 'switch' ? 'sv.variantSwitchTitle' : 'sv.variantPickTitle'), hint: 'hint.select' });
    renderVariantPick();
}

function variantPickRows() {
    return [`${tr('sv.variantFlatpak')} ${tr('sv.variantRecommended')}`, tr('sv.variantNative')];
}

function renderVariantPick() {
    const rows = variantPickRows();
    $('settingsContent').innerHTML = rows.map((label, i) => {
        const cur = variantPick.current === VARIANT_PICK_ORDER[i] ? ` ${currentTag(tr('sv.tagActive'))}` : '';
        return `<div class="settings-item${i === variantPick.focus ? ' focused' : ''}"><span class="bt-name">${esc(label)}</span>${cur}</div>`;
    }).join('');
    scrollSettingsFocusIntoView();
}

function closeVariantPick() {
    variantPick = null;
    setSubviewFrame({ title: tr('menu.launchers'), hint: 'hint.addRemove' });
    renderLaunchersList();
}

function commitVariantPick() {
    const { entry, focus, mode, current } = variantPick;
    const variant = VARIANT_PICK_ORDER[focus] || 'flatpak';
    if (mode === 'switch') {
        if (variant !== current) {
            window.launcher.setLauncherVariant({ id: entry.id, variant });
            showStatus(tr('sv.variantSwitched', {
                name: entry.name.toUpperCase(),
                variant: tr(variant === 'native' ? 'sv.tagVariantNative' : 'sv.tagVariantFlatpak'),
            }));
        }
    } else if (variant === 'native') {
        window.launcher.addLauncher(nativeLauncherEntry(entry));
        showStatus(tr('sv.customAdded', { name: entry.name.toUpperCase() }));
    } else {
        window.launcher.addLauncher(entry.id);
        showStatus(tr('sv.customAdded', { name: entry.name.toUpperCase() }));
    }
    closeVariantPick();
}

// □ on a launcher row (added OR catalog): a small menu — switch the variant (both variants installed), set the folder by hand (if the
// automatic search does not find it), clear the manual folder.
function openLauncherRowMenu() {
    const row = launchersViewRows[launchersViewFocusIndex];
    if (!row || !row.hasMenu) return;
    const catalogEntry = launchersCatalog.find((c) => c.id === row.id) || null;
    // A launcher outside the catalog (custom) only has the ROM-source items.
    const entry = catalogEntry || { id: row.id, name: row.name };
    const items = [];
    if (row.switchable) items.push('variant');
    if (catalogEntry && catalogEntry.nativeCmd) {
        items.push('setPath');
        if (catalogEntry.manualPath) items.push('clearPath');
    }
    if (row.type === 'active' && launcherCanHaveRomSource(row.id)) {
        const has = customGameLauncherIds.has(row.id);
        items.push(has ? 'romSourceEdit' : 'romSource');
        if (has) items.push('romSourceClear');
    }
    if (!items.length) return;
    feedback('nav');
    launcherRowMenu = { entry, row, items, focus: 0 };
    renderLauncherRowMenu();
}

const LAUNCHER_ROW_MENU_LABEL = {
    variant: 'sv.menuVariant', setPath: 'sv.menuSetPath', clearPath: 'sv.menuClearPath',
    romSource: 'sv.menuRomSource', romSourceEdit: 'sv.menuRomSourceEdit', romSourceClear: 'sv.menuRomSourceClear',
};

function renderLauncherRowMenu() {
    const m = launcherRowMenu;
    setSubviewFrame({ title: m.entry.name, hint: 'hint.select' });
    const note = m.entry.manualPath
        ? `<div class="changelog-para">${esc(tr('sv.lpCurrent', { path: m.entry.manualPath }))}</div>` : '';
    $('settingsContent').innerHTML = note + m.items.map((it, i) =>
        `<div class="settings-item${i === m.focus ? ' focused' : ''}"><span class="bt-name">${esc(tr(LAUNCHER_ROW_MENU_LABEL[it]))}</span></div>`,
    ).join('');
    scrollSettingsFocusIntoView();
}

function selectLauncherRowMenu() {
    const { entry, row, items, focus } = launcherRowMenu;
    const item = items[focus];
    launcherRowMenu = null;
    if (item === 'variant') { openVariantPick(entry, 'switch', row.variant); return; }
    if (item === 'setPath') { getLauncherPathFlow().open(entry); return; }
    if (item === 'romSource' || item === 'romSourceEdit') {
        const launcher = { id: entry.id, name: entry.name };
        window.launcher.getCustomGameSources().then((res) => {
            if (settingsView !== 'launchers') return;
            const src = (res && res.ok && Array.isArray(res.sources)) ? res.sources.find((x) => x.launcherId === launcher.id) : null;
            getLauncherRomsFlow().open(launcher, src || null);
        }).catch(ignoreError);
        return;
    }
    if (item === 'romSourceClear') {
        getLauncherRomsFlow().clear({ id: entry.id, name: entry.name })
            .then(() => { if (settingsView === 'launchers') backToLaunchersList(null); }).catch(ignoreError);
        return;
    }
    if (item === 'clearPath') {
        getLauncherPathFlow().clear(entry, () => { reloadLaunchersCatalog().catch(ignoreError); }).catch(ignoreError);
    }
}

function handleLauncherRowMenuInput(gp) {
    const count = launcherRowMenu.items.length;
    navList(gp, launchersViewButtonStates, {
        count,
        move: (d, repeated) => { launcherRowMenu.focus = stepIndex(launcherRowMenu.focus, d, count, repeated); renderLauncherRowMenu(); },
        onSelect: () => selectLauncherRowMenu(),
        onBack: () => backToLaunchersList(gp),
    });
}

function handleVariantPickInput(gp) {
    const count = variantPickRows().length;
    navList(gp, launchersViewButtonStates, {
        count,
        move: (d, repeated) => { variantPick.focus = stepIndex(variantPick.focus, d, count, repeated); renderVariantPick(); },
        onSelect: () => commitVariantPick(),
        onBack: () => closeVariantPick(),
    });
}

function handleLaunchersInput(gp) {
    if (launcherPathFlow && launcherPathFlow.isOpen()) { launcherPathFlow.handle(gp); return; }
    if (launcherRowMenu) { handleLauncherRowMenuInput(gp); return; }
    if (launcherAddFlow && launcherAddFlow.isOpen()) { launcherAddFlow.handle(gp); return; }
    if (launcherRomsFlow && launcherRomsFlow.isOpen()) { launcherRomsFlow.handle(gp); return; }
    if (variantPick) { handleVariantPickInput(gp); return; }
    const count = launchersViewRows.length;
    navList(gp, launchersViewButtonStates, {
        count,
        move: (d, repeated) => { launchersViewFocusIndex = stepIndex(launchersViewFocusIndex, d, count, repeated); renderLaunchersList(); },
        onSelect: () => selectLaunchersRow(gp),
        onBack: () => backToSettingsMenu(gp),
    });
    edge(launchersViewButtonStates, 'square', gp.buttons[BTN.square]?.pressed, () => openLauncherRowMenu());
}

SETTINGS_VIEWS['launchers'] = { open: openLaunchersView, handle: handleLaunchersInput };
