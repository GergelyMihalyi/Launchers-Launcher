// Settings → Games → "ROM folder permissions" subview: the ROM folders NOT seen by the flatpak emulators' sandbox (`get-rom-access`) — one
// "Grant access" per row (`flatpak override --user --filesystem=<folder> <app>`, only for that one folder) — and below them the permissions
// granted earlier by the launcher (`flatpakGrants`), revocable. Both actions with a 2-step confirmation (`createArmedActionList`, like Power
// management): ✕ arms, ✕ executes. The launcher neither sees nor touches the user's own overrides (Flatseal). Load order: after settings.js.

let romAccessData = null; // null = loading; { hidden: [{ source, name, appId, dir }], grants: [{ appId, path }], ok }
let romAccessBusy = false;
let romAccessButtonStates = {};

function romAccessRows() {
    if (!romAccessData || !romAccessData.ok) return [];
    const rows = [];
    romAccessData.hidden.forEach((h, i) => rows.push({
        id: 'grant', appId: h.appId, dir: h.dir, label: `${h.name} — ${h.dir}`, icon: '🔓',
        sectionKey: i === 0 ? 'sv.romAccessMissing' : undefined,
    }));
    romAccessData.grants.forEach((g, i) => rows.push({
        id: 'revoke', appId: g.appId, dir: g.path, label: `${g.appId} — ${g.path}`, icon: '↩',
        sectionKey: i === 0 ? 'sv.romAccessGranted' : undefined,
    }));
    return rows;
}

const romAccessList = createArmedActionList({
    rows: romAccessRows,
    onConfirm: (row) => { runRomAccessAction(row).catch(ignoreError); },
    rerender: () => renderRomAccessView(),
    isStillOpen: () => settingsView === 'rom-access',
});

async function runRomAccessAction(row) {
    romAccessBusy = true;
    renderRomAccessView();
    const call = row.id === 'grant' ? window.launcher.grantRomAccess : window.launcher.revokeRomAccess;
    const res = await call({ appId: row.appId, dir: row.dir }).catch(() => ({ ok: false }));
    romAccessBusy = false;
    const okKey = row.id === 'grant' ? 'toast.romAccessGranted' : 'toast.romAccessRevoked';
    showStatus(res && res.ok ? tr(okKey) : tr('toast.romAccessFailed'), !(res && res.ok));
    if (settingsView === 'rom-access') await loadRomAccessData();
}

async function loadRomAccessData() {
    const [access, grants] = await Promise.all([
        window.launcher.getRomAccess({ refresh: true }).catch(() => ({ ok: false, items: [] })),
        window.launcher.listRomGrants().catch(() => ({ ok: false, items: [] })),
    ]);
    if (settingsView !== 'rom-access') return; // left meanwhile
    romAccessData = {
        ok: !!(access && access.ok && grants && grants.ok),
        hidden: ((access && access.items) || []).filter((it) => it && !it.visible),
        grants: (grants && grants.items) || [],
    };
    romAccessList.reset();
    renderRomAccessView();
}

function openRomAccessView() {
    romAccessButtonStates = { cross: true }; // entered from the menu with ✕ — do not take it as immediate arming
    setSubviewFrame({ title: tr('menu.rom-access'), hint: 'hint.select', skeleton: true });
    romAccessData = null;
    romAccessBusy = false;
    romAccessList.reset();
    loadRomAccessData().catch(ignoreError);
}

function renderRomAccessView() {
    const el = $('settingsContent');
    if (!romAccessData) { el.innerHTML = loadingBlock(); return; }
    if (!romAccessData.ok) { renderSubviewError(tr('sv.romAccessFailed')); return; }
    if (!romAccessData.hidden.length && !romAccessData.grants.length) {
        el.innerHTML = emptyState(tr('sv.romAccessNone'), tr('sv.romAccessNoneHint'));
        return;
    }
    el.innerHTML = `<div class="settings-subhead">${esc(tr('sv.romAccessHint'))}</div>`
        + (romAccessBusy ? loadingBlock('sm') : romAccessList.rowsHtml());
    scrollSettingsFocusIntoView();
}

function handleRomAccessInput(gp) {
    const bs = romAccessButtonStates;
    edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed, (rep) => romAccessList.moveFocus(-1, rep));
    edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed, (rep) => romAccessList.moveFocus(1, rep));
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => { if (!romAccessBusy) romAccessList.select(); });
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        romAccessList.clearArm();
        backToSettingsMenu(gp);
    });
}

SETTINGS_VIEWS['rom-access'] = { open: openRomAccessView, handle: handleRomAccessInput };
