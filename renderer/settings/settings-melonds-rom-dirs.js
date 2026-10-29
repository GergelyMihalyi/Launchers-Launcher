// Settings → Launchers → "melonDS ROM folders": the UI of the `melondsRomDirs` key — the chosen folders at the top (✕ = remove), "＋ Add
// folder" below (the controller-driven folder browser, + "Manual entry" with the on-screen keyboard). Choosing does not close: several
// folders can be added. Load order: AFTER settings-dir-browse.js.

let melondsDirs = [];
let melondsDirsFocusIndex = 0;
let melondsDirsButtonStates = {};

// The controller-driven folder browser (the shared `createDirBrowser`, renderer/settings/settings-dir-browse.js): the chosen folder goes into
// the list, the browser stays OPEN (several folders can be added).
const melondsDirBrowser = createDirBrowser({
    viewId: 'melonds-rom-dirs',
    isPicked: (p) => melondsDirs.includes(p),
    onPick: (p) => {
        if (melondsDirs.includes(p)) { showStatus(tr('sv.romDirAlready'), true); return; }
        melondsDirs = [...melondsDirs, p];
        commitMelondsDirs();
        showStatus(tr('sv.romDirAdded'));
    },
    onClose: (gp) => {
        setSubviewFrame({ title: tr('menu.melonds-rom-dirs'), hint: 'hint.addRemove' });
        // `melondsDirsButtonStates` of the root list did not run while we were in the browser — sync the still held X/○.
        if (gp) syncEdge(melondsDirsButtonStates, gp, ['cross', 'cancel']);
        renderMelondsDirsList();
    },
});

async function openMelondsRomDirsView() {
    setSubviewFrame({ title: tr('menu.melonds-rom-dirs'), hint: 'hint.addRemove', skeleton: true });
    melondsDirBrowser.reset();
    melondsDirsFocusIndex = 0;
    // Entered from the menu with X; while it is held, it must not count as an immediate selection.
    melondsDirsButtonStates = { cross: true };
    const res = await window.launcher.getMelondsRomDirs().catch(() => []);
    if (settingsView !== 'melonds-rom-dirs') return; // left the subview meanwhile
    melondsDirs = Array.isArray(res) ? res : [];
    renderMelondsDirsList();
}

/** @returns {Array<{ type: string, path?: string }>} type: 'dir' | 'add' */
function melondsDirsRows() {
    return [...melondsDirs.map((p) => ({ type: 'dir', path: p })), { type: 'add' }];
}

function commitMelondsDirs() {
    window.launcher.setMelondsRomDirs(melondsDirs);
}

function renderMelondsDirsList() {
    if (melondsDirBrowser.isOpen()) { melondsDirBrowser.render(); return; }
    const rows = melondsDirsRows();
    if (melondsDirsFocusIndex >= rows.length) melondsDirsFocusIndex = rows.length - 1;
    let html = melondsDirs.length
        ? `<div class="settings-subhead">${esc(tr('sv.subMelondsRomDirs'))}</div>`
        : emptyState(tr('sv.melondsNoDirs'));
    rows.forEach((row, i) => {
        const focused = i === melondsDirsFocusIndex ? ' focused' : '';
        if (row.type === 'add') {
            html += `<div class="settings-item${focused}"><span class="bt-name">＋ ${esc(tr('sv.addRomDir'))}</span></div>`;
        } else {
            html += `<div class="settings-item${focused}"><span class="bt-name">${esc(row.path)}</span></div>`;
        }
    });
    $('settingsContent').innerHTML = html;
    scrollSettingsFocusIntoView();
}

function selectMelondsDirsRow() {
    const rows = melondsDirsRows();
    const row = rows[melondsDirsFocusIndex];
    if (!row) return;
    if (row.type === 'add') { melondsDirBrowser.open(null); return; }
    melondsDirs = melondsDirs.filter((p) => p !== row.path);
    commitMelondsDirs();
    renderMelondsDirsList();
}

function handleMelondsRomDirsInput(gp) {
    if (melondsDirBrowser.isOpen()) { melondsDirBrowser.handle(gp); return; }
    const count = melondsDirsRows().length;
    navList(gp, melondsDirsButtonStates, {
        count,
        move: (d, repeated) => { melondsDirsFocusIndex = stepIndex(melondsDirsFocusIndex, d, count, repeated); renderMelondsDirsList(); },
        onSelect: () => selectMelondsDirsRow(),
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['melonds-rom-dirs'] = { open: openMelondsRomDirsView, handle: handleMelondsRomDirsInput };
