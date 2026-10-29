// Settings → Games → "Archive game saves": the saves (lib/saves/save-sources.js) into ONE compressed archive in a chosen folder (default
// `~/launchers-launcher-saves`). Rows: "Back up now" (main tars in the background, `save-backup-done` push + toast) / "Target folder" (the shared
// folder browser) / the sources to back up / the earlier backups — ✕ on one = RESTORE (its content is listed, per source or all, with a
// 2-step confirmation; main makes a safety backup first) — / "Automatic backup": Off / after a game / daily.
// Load order: AFTER settings-dir-browse.js, BEFORE ipc.js (`onSaveBackupDone`/`onSaveRestoreDone` live here).

let saveBackupState = null; // the response of `get-save-backup-state`
let saveBackupFocus = 0;
let saveBackupButtonStates = {};
let saveBackupRunning = false; // a backup started by the renderer is running (released by `save-backup-done`)
// Restore picker (✕ on an earlier backup row): `null` = the main list; otherwise { backup, contents, busy }.
let saveRestore = null;
const SAVE_AUTO_STEPS = ['off', 'afterGame', 'daily'];

const saveRestoreList = createArmedActionList({
    rows: () => {
        const c = saveRestore && saveRestore.contents;
        if (!c || !c.ok) return [];
        return [{ id: 'all', labelKey: 'sv.saveRestoreAll', icon: '♻' }, ...c.sources.map((s) => ({ id: s.id, label: s.name, icon: '↩' }))];
    },
    onConfirm: (row) => {
        if (!saveRestore || saveRestore.busy) return;
        saveRestore.busy = true;
        window.launcher.restoreSaveBackup({ name: saveRestore.backup.name, sourceId: row.id });
        showStatus(tr('toast.saveRestoreStarted'));
        renderSaveBackupView();
    },
    rerender: () => renderSaveBackupView(),
    isStillOpen: () => settingsView === 'save-backup' && !!saveRestore,
});

function openSaveRestore(backup) {
    saveRestore = { backup, contents: null, busy: false };
    saveRestoreList.reset();
    renderSaveBackupView();
    window.launcher.getSaveBackupContents(backup.name).then((c) => {
        if (!saveRestore || saveRestore.backup !== backup) return;
        saveRestore.contents = c || { ok: false };
        renderSaveBackupView();
    }).catch(ignoreError);
}

function closeSaveRestore() {
    saveRestoreList.clearArm();
    saveRestore = null;
    renderSaveBackupView();
}

const saveBackupDirBrowser = createDirBrowser({
    viewId: 'save-backup',
    isPicked: (p) => !!saveBackupState && saveBackupState.dir === p,
    pickedTagKey: 'lang.current',
    onPick: (p) => {
        window.launcher.setSaveBackupDir(p).then((res) => {
            if (!res || !res.ok) { showStatus(tr('toast.saveBackupDirInvalid'), true); return; }
            showStatus(tr('toast.saveBackupDirSet'));
            saveBackupDirBrowser.close(null);
        }).catch(ignoreError);
    },
    onClose: (gp) => {
        // When closed with ○/PS the button state can be synced; after a selection (✕) we close without `gp` — the still held ✕ must not start
        // another row immediately.
        if (gp) syncEdge(saveBackupButtonStates, gp, ['cross', 'cancel']);
        else saveBackupButtonStates = { ...saveBackupButtonStates, cross: true };
        openSaveBackupView(false);
    },
});

async function openSaveBackupView(fresh = true) {
    if (fresh) {
        saveBackupButtonStates = { cross: true }; // the entering ✕ may still be held
        saveBackupFocus = 0;
        saveBackupDirBrowser.reset();
    }
    setSubviewFrame({ title: tr('menu.save-backup'), hint: 'hint.select' });
    if (!saveBackupState || fresh) $('settingsContent').innerHTML = skeletonList();
    const res = await window.launcher.getSaveBackupState().catch(() => null);
    if (settingsView !== 'save-backup' || saveBackupDirBrowser.isOpen()) return;
    saveBackupState = res && res.ok ? res : { ok: false };
    if (saveBackupState.running) saveBackupRunning = true;
    renderSaveBackupView();
}

function saveBackupRows() {
    const st = saveBackupState && saveBackupState.ok ? saveBackupState : { sources: [], backups: [] };
    return [
        { type: 'run' }, { type: 'dir' }, { type: 'auto' },
        ...(st.sources || []).map((s) => ({ type: 'source', source: s })),
        ...(st.backups || []).map((b) => ({ type: 'backup', backup: b })),
    ];
}

function renderSaveRestoreView() {
    const rs = saveRestore;
    const d = new Date(rs.backup.mtimeMs);
    $('settingsPanelTitle').textContent = `${tr('menu.save-backup')} — ${formatDate(d)} ${formatClock(d)}`;
    const c = rs.contents;
    let html;
    if (!c) html = loadingBlock();
    else if (!c.ok) html = emptyState(tr('sv.saveRestoreUnreadable'));
    else if (rs.busy) html = loadingBlock('sm');
    else html = `<div class="settings-subhead">${esc(tr('sv.saveRestoreHint'))}</div>${saveRestoreList.rowsHtml()}`;
    $('settingsContent').innerHTML = html;
    scrollSettingsFocusIntoView();
}

function renderSaveBackupView() {
    if (saveBackupDirBrowser.isOpen()) { saveBackupDirBrowser.render(); return; }
    if (saveRestore) { renderSaveRestoreView(); return; }
    $('settingsPanelTitle').textContent = tr('menu.save-backup');
    const st = saveBackupState || { ok: false };
    const sources = st.ok ? st.sources || [] : [];
    const backups = st.ok ? st.backups || [] : [];
    const count = saveBackupRows().length;
    if (saveBackupFocus >= count) saveBackupFocus = count - 1;
    // The order = the order of `saveBackupRows()` (run, target folder, sources, earlier backups).
    let i = 0;
    const item = (inner) => `<div class="settings-item${i++ === saveBackupFocus ? ' focused' : ''}">${inner}</div>`;
    const running = saveBackupRunning ? ` ${currentTag(tr('sv.saveBackupRunning'))}` : '';
    const isDefault = st.isDefaultDir ? ` ${currentTag(tr('sv.saveBackupDefault'), { paren: true })}` : '';
    let html = item(`<span class="bt-name">💾 ${esc(tr('sv.saveBackupRun'))}</span>${running}`)
        + item(`<span class="bt-name">📁 ${esc(tr('sv.saveBackupDir'))}: ${esc(st.dir || '—')}</span>${isDefault}`)
        + item(`<span class="bt-name">⏱ ${esc(tr('sv.saveBackupAuto'))}: ${esc(tr(`sv.saveBackupAuto.${st.auto || 'off'}`))}</span>`);
    if (!st.ok) html += emptyState(tr('sv.saveBackupFailed'));
    html += `<div class="settings-subhead">${esc(tr('sv.saveBackupSources'))}</div>`;
    if (st.ok && !sources.length) html += emptyState(tr('sv.saveBackupNoSources'));
    for (const s of sources) {
        html += item(`<span class="bt-name">${esc(s.name)}</span> ${currentTag(formatBytes(s.bytes), { paren: true })}`);
    }
    html += `<div class="settings-subhead">${esc(tr('sv.saveBackupHistory', { keep: st.keep || 5 }))}</div>`;
    if (st.ok && !backups.length) html += emptyState(tr('sv.saveBackupNoHistory'));
    for (const b of backups) {
        const d = new Date(b.mtimeMs);
        html += item(`<span class="bt-name">${esc(`${formatDate(d)} ${formatClock(d)}`)}</span> ${currentTag(formatBytes(b.bytes), { paren: true })}`);
    }
    html += `<div class="changelog-para">${esc(tr('sv.saveBackupRestore'))}</div>`;
    $('settingsContent').innerHTML = html;
    scrollSettingsFocusIntoView();
}

function selectSaveBackupRow() {
    const row = saveBackupRows()[saveBackupFocus];
    if (!row) return;
    if (row.type === 'run') {
        if (saveBackupRunning) return;
        saveBackupRunning = true;
        window.launcher.runSaveBackup();
        showStatus(tr('toast.saveBackupStarted'));
        renderSaveBackupView();
    } else if (row.type === 'dir') {
        saveBackupDirBrowser.open(saveBackupState && saveBackupState.dir);
    } else if (row.type === 'auto') {
        const cur = (saveBackupState && saveBackupState.auto) || 'off';
        const next = SAVE_AUTO_STEPS[(SAVE_AUTO_STEPS.indexOf(cur) + 1) % SAVE_AUTO_STEPS.length];
        window.launcher.setSaveBackupAuto(next).then((res) => {
            if (!res || !res.ok) { showStatus(tr('toast.saveBackupFailed'), true); return; }
            if (saveBackupState) saveBackupState.auto = res.auto;
            if (settingsView === 'save-backup') renderSaveBackupView();
        }).catch(ignoreError);
    } else if (row.type === 'backup') {
        if (saveBackupRunning) return;
        openSaveRestore(row.backup);
    }
}

function handleSaveBackupInput(gp) {
    if (saveBackupDirBrowser.isOpen()) { saveBackupDirBrowser.handle(gp); return; }
    if (saveRestore) {
        const bs = saveBackupButtonStates;
        edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed, (rep) => saveRestoreList.moveFocus(-1, rep));
        edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed, (rep) => saveRestoreList.moveFocus(1, rep));
        edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => { if (!saveRestore.busy) saveRestoreList.select(); });
        edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
            feedback('back');
            if (!saveRestore.busy) closeSaveRestore();
        });
        return;
    }
    const count = saveBackupRows().length;
    navList(gp, saveBackupButtonStates, {
        count,
        move: (d, repeated) => { saveBackupFocus = stepIndex(saveBackupFocus, d, count, repeated); renderSaveBackupView(); },
        onSelect: () => selectSaveBackupRow(),
        onBack: () => backToSettingsMenu(gp),
    });
}

// main's `save-backup-done` push (wired by renderer/ipc.js): toast + refresh of the open view.
function onSaveBackupDone(res) {
    saveBackupRunning = false;
    // The automatic backup is silent if it succeeded (no toast on return from a game); it reports errors.
    if (res && res.ok) { if (!res.auto) showStatus(tr('toast.saveBackupDone', { size: formatBytes(res.bytes) })); }
    else showStatus(tr('toast.saveBackupFailed'), true);
    if (typeof settingsView !== 'undefined' && settingsView === 'save-backup' && !saveRestore) openSaveBackupView(false);
}

// main's `save-restore-done` push: toast + back to the main list (with fresh state).
function onSaveRestoreDone(res) {
    saveRestore = null;
    saveRestoreList.clearArm();
    if (res && res.ok) showStatus(tr('toast.saveRestoreDone'));
    else {
        const err = res && res.error;
        showStatus(tr(err === 'busy' ? 'toast.saveRestoreBusy' : (err === 'game-running' ? 'toast.saveRestoreGame' : 'toast.saveRestoreFailed')), true);
    }
    if (typeof settingsView !== 'undefined' && settingsView === 'save-backup') openSaveBackupView(false);
}

SETTINGS_VIEWS['save-backup'] = { open: openSaveBackupView, handle: handleSaveBackupInput };
