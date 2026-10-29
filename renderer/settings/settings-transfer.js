// Settings → System → "Transfer settings" subview: exports the portable settings into a `~/launchers-launcher-settings-<date>.json` file (✕
// immediately) + imports such files found in the home folder (2-step confirmation: ✕ arms, ✕ imports — main writes the whitelisted keys and
// relaunches). See lib/config-transfer.js (what goes in / stays out). Load order: after settings.js.

let transferExports = []; // the export files found in the home folder
let transferButtonStates = {};
let transferBusy = false;

const transferList = createArmedActionList({
    rows: () => [
        { id: '__export', label: tr('sv.transferExport'), icon: '📤', armed: false },
        ...transferExports.map((f, i) => ({
            id: f.name, label: `${f.name} (${formatBytes(f.size)})`, icon: '📥', sectionKey: i === 0 ? 'sv.transferImportSection' : undefined,
        })),
    ],
    onImmediate: () => { runTransferExport().catch(ignoreError); },
    onConfirm: (row) => {
        transferBusy = true;
        showStatus(tr('sv.transferImporting'));
        window.launcher.importSettings(row.id);
        renderTransferView();
    },
    rerender: () => renderTransferView(),
    isStillOpen: () => settingsView === 'settings-transfer',
});

async function runTransferExport() {
    const res = await window.launcher.exportSettings().catch(() => ({ ok: false }));
    showStatus(res && res.ok ? tr('toast.settingsExported', { name: res.name }) : tr('toast.settingsExportFailed'), !(res && res.ok), res && res.ok ? { ms: 4000 } : {});
    if (settingsView === 'settings-transfer') await loadTransferExports();
}

async function loadTransferExports() {
    const res = await window.launcher.listSettingsExports().catch(() => ({ ok: false, items: [] }));
    if (settingsView !== 'settings-transfer') return;
    transferExports = res && res.ok ? res.items || [] : [];
    renderTransferView();
}

function openTransferView() {
    transferButtonStates = { cross: true }; // entered from the menu with ✕ — do not take it as an immediate execution
    transferBusy = false;
    transferExports = [];
    transferList.reset();
    setSubviewFrame({ title: tr('menu.settings-transfer'), hint: 'hint.select' });
    renderTransferView();
    loadTransferExports().catch(ignoreError);
}

function renderTransferView() {
    const el = $('settingsContent');
    el.innerHTML = `<div class="settings-subhead">${esc(tr('sv.transferHint'))}</div>`
        + (transferBusy ? loadingBlock('sm') : transferList.rowsHtml())
        + (transferExports.length ? '' : emptyState(tr('sv.transferNone'), tr('sv.transferNoneHint')));
    scrollSettingsFocusIntoView();
}

function handleTransferInput(gp) {
    const bs = transferButtonStates;
    edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed, (rep) => transferList.moveFocus(-1, rep));
    edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed, (rep) => transferList.moveFocus(1, rep));
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => { if (!transferBusy) transferList.select(); });
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        transferList.clearArm();
        backToSettingsMenu(gp);
    });
}

SETTINGS_VIEWS['settings-transfer'] = { open: openTransferView, handle: handleTransferInput };
