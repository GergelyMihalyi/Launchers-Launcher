// Settings → Startup → "Close when entering TV mode" subview. The CURRENTLY running flatpak apps + the already selected `tvMode.closeFlatpak`
// entries (the non-running ones too, so they can be removed) — as a checkbox list. Checked = `bin/tv-mode-enter.sh` `flatpak kill`s it when
// entering TV mode. `closeNative` + `preCommands` DELIBERATELY stay hand-edited `config.json` (no `pkill -f`) — a hint says so.
// ▲▼ = row, ✕ = on/off, ○/PS = back. Load order: after settings.js.

let tvApps = [];              // the merged, sorted appid list
let tvSelected = new Set();   // the checked appids (`closeFlatpak`)
let tvRunning = new Set();    // what is running (for the badge)
let tvModeFocusIndex = 0;
let tvModeButtonStates = {};

async function openTvModeView() {
    setSubviewFrame({ title: tr('menu.tv-mode'), hint: 'hint.toggle', skeleton: true });
    tvModeButtonStates = { cross: true };
    tvModeFocusIndex = 0;
    const res = await window.launcher.listTvModeApps().catch(() => null);
    if (settingsView !== 'tv-mode') return;
    const running = (res && Array.isArray(res.running)) ? res.running : [];
    const selected = (res && Array.isArray(res.selected)) ? res.selected : [];
    tvRunning = new Set(running);
    tvSelected = new Set(selected);
    tvApps = [...new Set([...running, ...selected])].sort();
    renderTvModeView();
}

function renderTvModeView() {
    if (!tvApps.length) {
        $('settingsContent').innerHTML = emptyState(tr('sv.tvNoApps'), tr('sv.tvManualNote'));
        return;
    }
    const list = tvApps.map((id, i) => {
        const on = tvSelected.has(id);
        const runTag = tvRunning.has(id) ? ` ${currentTag(tr('sv.tvRunning'))}` : '';
        const box = on ? '☑' : '☐';
        return `<div class="settings-item ${i === tvModeFocusIndex ? 'focused' : ''}">${box} <span class="bt-name">${esc(id)}</span>${runTag}</div>`;
    }).join('');
    $('settingsContent').innerHTML = list
        + `<div class="settings-subhead">${esc(tr('sv.tvManualHead'))}</div>`
        + emptyState(tr('sv.tvManualNote'));
    scrollSettingsFocusIntoView();
}

function commitTvMode() {
    window.launcher.setTvMode({ closeFlatpak: [...tvSelected].sort() });
}

function handleTvModeInput(gp) {
    navList(gp, tvModeButtonStates, {
        count: tvApps.length,
        move: (d, repeated) => {
            tvModeFocusIndex = stepIndex(tvModeFocusIndex, d, tvApps.length, repeated);
            renderTvModeView();
        },
        onSelect: () => {
            const id = tvApps[tvModeFocusIndex];
            if (!id) return;
            if (tvSelected.has(id)) tvSelected.delete(id);
            else tvSelected.add(id);
            commitTvMode();
            renderTvModeView();
        },
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['tv-mode'] = { open: openTvModeView, handle: handleTvModeInput };
