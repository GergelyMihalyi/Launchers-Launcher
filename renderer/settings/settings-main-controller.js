// Settings → Startup → "Main controller": which of the paired BT controllers starts the launcher (`mainController` key); main also writes it
// into a sidecar file (lib/sidecars/main-controller.js) read by the bt-trigger guard. Single choice: row 1 is "Any controller" (= null).
// ✕ = choose (does not close), ○/PS = back. Load order: AFTER controller-icons.js + settings-bt.js + settings.js, BEFORE ipc.js.

let mainControllerFocusIndex = 0;
let mainControllerButtonStates = {};
// Row 1 is always "any" (mac: null); its name in the render is `tr('sv.anyController')`.
let mainControllerRows = [{ mac: null, name: '', type: null }];
let mainControllerCurrentMac = null; // MAC of the currently chosen main controller (or null)

async function openMainControllerView() {
    setSubviewFrame({ title: tr('menu.main-controller'), hint: 'hint.select', skeleton: true });
    mainControllerFocusIndex = 0;
    // Entered from the menu with X; while it is held, it must not count as an immediate choice.
    mainControllerButtonStates = { cross: true };

    const [current, res] = await Promise.all([
        window.launcher.getMainController().catch(() => null),
        window.launcher.listBtDevices('controller'),
    ]);
    if (settingsView !== 'main-controller') return; // left meanwhile
    if (!res.ok) { renderSubviewError(tr('sv.controllersFailed')); return; }

    mainControllerCurrentMac = current && current.mac ? current.mac.toUpperCase() : null;
    const controllers = [...res.items];
    controllers.sort((a, b) => (Number(b.connected) - Number(a.connected)) || a.name.localeCompare(b.name));
    mainControllerRows = [{ mac: null, name: tr('sv.anyController'), type: null }, ...controllers];

    // Focus on the current choice
    const sel = mainControllerRows.findIndex((r) => (r.mac || null) === mainControllerCurrentMac);
    mainControllerFocusIndex = sel !== -1 ? sel : 0;
    renderMainControllerView();
}

function renderMainControllerView() {
    const nameCounts = {};
    mainControllerRows.forEach((r) => { if (r.mac) nameCounts[r.name] = (nameCounts[r.name] || 0) + 1; });

    $('settingsContent').innerHTML = mainControllerRows.map((r, i) => {
        const selected = (r.mac || null) === mainControllerCurrentMac;
        const focused = i === mainControllerFocusIndex ? 'focused' : '';
        const check = `<span class="audio-current-tag">${selected ? esc(tr('sv.selectedActive')) : ''}</span>`;
        if (!r.mac) {
            return `<div class="settings-item ${focused}"><span class="bt-name">${esc(tr('sv.anyController'))}</span> ${check}</div>`;
        }
        const icon = `<span class="bt-icon">${CONTROLLER_ICONS[r.type] || CONTROLLER_ICONS.generic}</span>`;
        let disamb = '';
        if (nameCounts[r.name] > 1) disamb = ` <span class="bt-disamb">· ${esc(r.mac.slice(-5))}</span>`;
        const conn = r.connected ? ` <span class="bt-disamb">· ${esc(tr('sv.connectedNote'))}</span>` : '';
        return `<div class="settings-item ${focused}">${icon}<span class="bt-name">${esc(r.name)}</span>${disamb}${conn} ${check}</div>`;
    }).join('');
    scrollSettingsFocusIntoView();
}

function handleMainControllerInput(gp) {
    navList(gp, mainControllerButtonStates, {
        count: mainControllerRows.length,
        move: (d, repeated) => {
            const n = mainControllerRows.length;
            mainControllerFocusIndex = stepIndex(mainControllerFocusIndex, d, n, repeated);
            renderMainControllerView();
        },
        onSelect: () => {
            const row = mainControllerRows[mainControllerFocusIndex];
            if (!row) return;
            mainControllerCurrentMac = row.mac ? row.mac.toUpperCase() : null;
            window.launcher.setMainController(
                row.mac ? { mac: row.mac, name: row.name, type: row.type || 'generic' } : { mac: null },
            );
            renderMainControllerView();
        },
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['main-controller'] = { open: openMainControllerView, handle: handleMainControllerInput };
