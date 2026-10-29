// Settings → System → "Settings backups": `lib/config.js` makes at most one `config.json.bak-<date>` a day (5 are kept); an earlier state can
// be restored from here (the pre-restore state goes into the `pre-restore` row). A 2-step confirmation on the `createArmedActionList` factory;
// the 2nd ✕ = `restore-config-backup` → main restores and RELAUNCHES the launcher. Error → `config-restore-failed` push + toast. Load order:
// AFTER settings.js.

let configBackups = [];
let configBackupsButtonStates = {};

function configBackupLabel(b) {
    const kb = `${Math.max(1, Math.round(b.size / 1024))} KB`;
    if (b.kind === 'pre-restore') return tr('sv.backupPreRestore', { date: b.date, size: kb });
    return tr('sv.backupDaily', { date: b.date, size: kb });
}

const configBackupList = createArmedActionList({
    rows: () => configBackups.map((b) => ({ id: b.name, label: configBackupLabel(b) })),
    onConfirm: (row) => {
        showStatus(tr('sv.backupRestoring'));
        window.launcher.restoreConfigBackup(row.id);
    },
    rerender: () => renderConfigBackupsView(),
    isStillOpen: () => settingsView === 'config-backups',
});

async function openConfigBackupsView() {
    configBackupsButtonStates = { cross: true }; //
    configBackupList.reset();
    configBackups = [];
    setSubviewFrame({ title: tr('menu.config-backups'), hint: 'hint.select', skeleton: true });
    const res = await window.launcher.listConfigBackups();
    if (settingsView !== 'config-backups') return; // left meanwhile
    if (!res.ok) { renderSubviewError(tr('sv.backupListFailed')); return; }
    configBackups = res.items;
    renderConfigBackupsView();
}

function renderConfigBackupsView() {
    const el = $('settingsContent');
    if (!configBackups.length) {
        el.innerHTML = emptyState(tr('sv.backupNone'), tr('sv.backupNoneHint'));
        return;
    }
    el.innerHTML = `<div class="settings-subhead">${esc(tr('sv.backupHint'))}</div>${configBackupList.rowsHtml()}`;
    scrollSettingsFocusIntoView();
}

function handleConfigBackupsInput(gp) {
    const bs = configBackupsButtonStates;
    const has = configBackups.length > 0;
    edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed, (rep) => { if (has) configBackupList.moveFocus(-1, rep); });
    edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed, (rep) => { if (has) configBackupList.moveFocus(1, rep); });
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => { if (has) configBackupList.select(); });
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        configBackupList.clearArm();
        backToSettingsMenu(gp);
    });
}

SETTINGS_VIEWS['config-backups'] = { open: openConfigBackupsView, handle: handleConfigBackupsInput };
