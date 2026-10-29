// Settings → Games → "Clear cache" subview: the launcher's own rebuildable caches (cover cache + the worker scans' meta cache,
// lib/games/games-cache.js) — their size at the top, below a "Clear now" row with a 2-step confirmation (`createArmedActionList`, like
// "Settings backups"). After clearing, main rescans in the background (covers come back with the scans / downloads). Does NOT touch the manual
// cover overrides, the config or the log. Load order: after settings.js.

let gamesCacheInfo = null; // null = loading; { ok, items: [{ id, bytes, files }] }
let gamesCacheBusy = false;
let gamesCacheButtonStates = {};

const GAMES_CACHE_LABEL_KEYS = { covers: 'sv.cacheCovers', scan: 'sv.cacheScan' };

const gamesCacheList = createArmedActionList({
    rows: [{ id: 'clear', labelKey: 'sv.cacheClearNow' }],
    onConfirm: () => { clearGamesCacheNow().catch(ignoreError); },
    rerender: () => renderGamesCacheView(),
    isStillOpen: () => settingsView === 'games-cache',
});

async function clearGamesCacheNow() {
    gamesCacheBusy = true;
    renderGamesCacheView();
    const res = await window.launcher.clearGamesCache().catch(() => ({ ok: false, freedBytes: 0 }));
    gamesCacheBusy = false;
    showStatus(res && res.ok ? tr('toast.cacheCleared', { size: formatBytes(res.freedBytes || 0) }) : tr('toast.cacheClearFailed'), !(res && res.ok));
    if (settingsView === 'games-cache') await loadGamesCacheInfo();
}

async function loadGamesCacheInfo() {
    gamesCacheInfo = null;
    renderGamesCacheView();
    const res = await window.launcher.getGamesCacheInfo().catch(() => ({ ok: false, items: [] }));
    if (settingsView !== 'games-cache') return; // left meanwhile
    gamesCacheInfo = res;
    renderGamesCacheView();
}

function openGamesCacheView() {
    gamesCacheButtonStates = { cross: true }; //
    gamesCacheList.reset();
    setSubviewFrame({ title: tr('menu.games-cache'), hint: 'hint.select' });
    loadGamesCacheInfo().catch(ignoreError);
}

function renderGamesCacheView() {
    const el = $('settingsContent');
    if (!gamesCacheInfo) { el.innerHTML = skeletonList(3); return; }
    if (!gamesCacheInfo.ok) { renderSubviewError(tr('sv.diagQueryFailed')); return; }
    const sizes = gamesCacheInfo.items.map((d) => `<div class="settings-item">${esc(tr(GAMES_CACHE_LABEL_KEYS[d.id] || d.id))} — ${esc(formatBytes(d.bytes))}</div>`).join('');
    const action = gamesCacheBusy ? `<div class="settings-item focused"><span class="bt-name">${esc(tr('sv.cacheClearing'))}</span></div>` : gamesCacheList.rowsHtml();
    el.innerHTML = `<div class="settings-subhead">${esc(tr('sv.cacheHint'))}</div>${sizes}${action}`;
    scrollSettingsFocusIntoView();
}

function handleGamesCacheInput(gp) {
    const bs = gamesCacheButtonStates;
    const ready = !!(gamesCacheInfo && gamesCacheInfo.ok) && !gamesCacheBusy;
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => { if (ready) gamesCacheList.select(); });
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        gamesCacheList.clearArm();
        backToSettingsMenu(gp);
    });
}

SETTINGS_VIEWS['games-cache'] = { open: openGamesCacheView, handle: handleGamesCacheInput };
