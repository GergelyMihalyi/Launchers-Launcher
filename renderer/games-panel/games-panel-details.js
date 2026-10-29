// The Games panel's game details view: a LONG ✕ press on a game (a short ✕ launches; □ is the source filter here) opens an info card:
// cover, source, playtime + last played (the launcher's AND the emulator's/client's bookkeeping), ROM file path + size, the path of the manual
// cover override. Actions: launch / pin (△ too) / back. Data from the `get-game-details` invoke (lib/games/game-details.js); lifecycle:
// `createOverlay`. Load order: AFTER games-panel-filter.js, BEFORE games-panel.js. The pure `gameDetailsFacts` is exported
// (test/games-panel/games-panel-details.test.js). Background: docs/dev/games-panel.md#details-view

// From Node (to test the pure helpers) the shared infra comes from util.js — globals already loaded in the browser (the keyboard.js /
// setup-wizard.js pattern).
if (typeof createOverlay === 'undefined' && typeof module !== 'undefined') {
    const util = module.require('../util.js');
    Object.assign(globalThis, {
        createOverlay: util.createOverlay, formatDuration: util.formatDuration, formatDate: util.formatDate,
        formatBytes: util.formatBytes,
    });
}

let gameDetailsEntry = null; // { key, name, cover, kind, params } — the opened game
let gameDetailsData = null; // the `get-game-details` response, `null` until loaded
let gameDetailsFocus = 0;
let gameDetailsSeq = 0; // to drop a stale response (requested for another game)
let gameDetailsOptions = ''; // the game's saved launch options (lib/launch/launch-options.js), empty until loaded
// Manual cover picker (inside the details view): `null` = not open; otherwise { items, focus, loading }.
let gameDetailsCoverPicker = null;

// Launch options only make sense for a path-based launch (emulators, RetroArch, custom ROM source) — the URL-based launch of
// Steam/Heroic/Lutris takes no extra arguments. RPCS3 (title-ID based) is left out.
function gameOptionsSupported(kind) {
    return kind === 'retroarch' || kind === 'custom' || (!!EMULATOR_SOURCE_BY_ID[kind] && kind !== 'rpcs3');
}

// The main-side key (lib/ipc/launch-ipc.js `withLaunchOptions`): for RetroArch the ROM path (the playlist label is not known at selection
// time), otherwise the game's favorite key.
function gameOptionsKey(entry) {
    if (!entry) return '';
    if (entry.kind === 'retroarch') return entry.params && entry.params.path ? `retroarch-rom:${entry.params.path}` : '';
    return entry.key || '';
}

const gamesDetails = createOverlay({
    elementId: 'gamesDetailsOverlay',
    // The opening ✕ (held long) is still pressed — no immediate "Launch".
    enterStates: { cross: true },
    // The Games panel's button watching did not run while the card was open.
    syncOnClose: () => ({ states: gamesPanel.states, keys: ['cross', 'cancel', 'pin'] }),
    onOpen: (entry) => {
        gameDetailsEntry = entry;
        gameDetailsData = null;
        gameDetailsFocus = 0;
        gameDetailsOptions = '';
        gameDetailsCoverPicker = null;
        const seq = ++gameDetailsSeq;
        $('gamesDetailsTitle').textContent = entry.name || '';
        $('gamesDetailsHint').innerHTML =
            `<span>▲▼ ${esc(tr('hint.nav'))}</span>`
            + `<span>${btnIcon('confirm')} ${esc(tr('hint.select'))}</span>`
            + `<span>${btnIcon('menu')} ${esc(tr('games.hintPin'))}</span>`
            + `<span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>`;
        renderGameDetails();
        if (gameOptionsSupported(entry.kind) && gameOptionsKey(entry)) {
            window.launcher.getGameLaunchOption(gameOptionsKey(entry)).then((res) => {
                if (seq !== gameDetailsSeq || !gamesDetails.isOpen()) return;
                gameDetailsOptions = res && res.ok && typeof res.text === 'string' ? res.text : '';
                renderGameDetails();
            }).catch(ignoreError);
        }
        window.launcher.getGameDetails({ key: entry.key, kind: entry.kind, params: entry.params || {} })
            .then((res) => {
                if (seq !== gameDetailsSeq || !gamesDetails.isOpen()) return;
                gameDetailsData = res && res.ok ? res : { ok: false };
                renderGameDetails();
            })
            .catch(ignoreError);
    },
    onClose: () => {
        gameDetailsEntry = null;
        gameDetailsData = null;
        renderGamesPanel();
    },
});

// Opens from the focused item (called by the ✕-hold branch of games-panel.js) — `false` if there is nothing to show (e.g. a RetroArch system
// row); the press then runs as a short ✕ (on release).
function openGameDetailsForFocused() {
    const entry = focusedGameEntry({ includeRecent: true });
    if (!entry || !entry.key || !entry.kind) return false;
    feedback('nav');
    gamesDetails.open(entry);
    return true;
}

function closeGameDetails(gp) { gamesDetails.close(gp); }

// The card's "fact" rows from the `get-game-details` response: `[{ label, value, note?, path? }]`. Pure (`t` is `tr` — overridable for tests).
// Playtime: the emulator's/client's OWN measurement if there is one (it also sees launches outside the launcher), otherwise the ones launched
// from the launcher; last played is the later of the two.
function gameDetailsFacts(details, t = (typeof tr === 'function' ? tr : (k) => k)) {
    if (!details || details.ok === false) return [];
    const facts = [];
    const nat = details.native || null;
    const la = details.launcher || null;
    if (nat && nat.playtimeMs > 0) {
        facts.push({ label: t('games.detailsPlaytime'), value: formatDuration(nat.playtimeMs), note: t('games.detailsBySource', { source: nat.label }) });
    } else if (la && la.totalMs > 0) {
        facts.push({ label: t('games.detailsPlaytime'), value: formatDuration(la.totalMs), note: t('games.detailsByLauncher') });
    }
    const lastTimes = [nat && nat.lastPlayedAt, la && la.lastLaunchedAt ? Date.parse(la.lastLaunchedAt) : null]
        .filter((x) => Number.isFinite(x) && x > 0);
    if (lastTimes.length) facts.push({ label: t('games.detailsLastPlayed'), value: formatDate(new Date(Math.max(...lastTimes))) });
    if (la && la.count > 0) facts.push({ label: t('games.detailsLaunchCount'), value: `${la.count}×` });
    const meta = details.metadata || null;
    if (meta && meta.developer) facts.unshift({ label: t('games.detailsDeveloper'), value: meta.developer });
    if (meta && meta.storeUrl) facts.push({ label: t('games.detailsStore'), value: meta.storeUrl, path: true });
    const f = details.file;
    if (f && f.path) {
        const size = f.exists && !f.isDir ? formatBytes(f.sizeBytes) : '';
        facts.push({
            label: t('games.detailsFile'), value: f.path, path: true,
            note: !f.exists ? t('games.detailsFileMissing') : (f.isDir ? t('games.detailsFolder') : size),
        });
    }
    const c = details.cover || {};
    if (c.override) facts.push({ label: t('games.detailsCoverOverride'), value: c.override, path: true, note: t('games.detailsCoverActive') });
    else if (c.suggestion) facts.push({ label: t('games.detailsCoverOverride'), value: c.suggestion, path: true, note: t('games.detailsCoverHow') });
    return facts;
}

function gameDetailsActions() {
    const pinned = !!(gameDetailsEntry && favoriteKeySet().has(gameDetailsEntry.key));
    const options = gameDetailsEntry && gameOptionsSupported(gameDetailsEntry.kind) && gameOptionsKey(gameDetailsEntry)
        ? [{ id: 'options', label: `${tr('games.detailsOptions')}: ${gameDetailsOptions || tr('games.detailsOptionsNone')}` }] : [];
    return [
        { id: 'launch', label: tr('games.detailsLaunch') },
        { id: 'pin', label: pinned ? tr('games.detailsUnpin') : tr('games.detailsPin') },
        ...options,
        ...(gameDetailsEntry && overrideKeyOk(gameDetailsEntry.key) ? [{ id: 'cover', label: tr('games.detailsCoverPick') }] : []),
        { id: 'hide', label: gameDetailsEntry && gamesHiddenGames.has(gameDetailsEntry.key) ? tr('games.detailsUnhide') : tr('games.detailsHide') },
        { id: 'back', label: tr('hint.back') },
    ];
}

// The manual cover override only makes sense for a game with a `<source>-game-<id>` / `retroarch:<system>:<title>` key (mirror of
// `overrideTargetForKey` in lib/launchers/shared/cover-override.js).
function overrideKeyOk(key) {
    return /^retroarch:[^:]+:.+$/.test(String(key || '')) || /^[a-z0-9]+-game-.+$/.test(String(key || ''));
}

function coverPickerRows() {
    const hasOverride = !!(gameDetailsData && gameDetailsData.cover && gameDetailsData.cover.override);
    const p = gameDetailsCoverPicker;
    return [
        ...(hasOverride ? [{ id: 'clear', label: tr('games.coverClear') }] : []),
        ...((p && p.items) || []).map((it) => ({ id: 'image', path: it.path, label: `${it.name} (${formatBytes(it.bytes)})` })),
    ];
}

function renderCoverPicker() {
    const p = gameDetailsCoverPicker;
    const rows = coverPickerRows();
    if (p.focus >= rows.length) p.focus = Math.max(0, rows.length - 1);
    let html = `<div class="settings-subhead">${esc(tr('games.coverPickHint'))}</div>`;
    if (p.loading) html += loadingBlock('sm');
    else if (!rows.length) html += emptyState(tr('games.coverPickEmpty'), tr('games.coverPickEmptyHint'));
    else html += rows.map((r, i) => `<div class="settings-item${i === p.focus ? ' focused' : ''}">${esc(r.label)}</div>`).join('');
    $('gamesDetailsContent').innerHTML = html;
    const f = document.querySelector('#gamesDetailsContent .settings-item.focused');
    if (f) f.scrollIntoView({ block: 'nearest' });
}

function openCoverPicker() {
    gameDetailsCoverPicker = { items: [], focus: 0, loading: true };
    renderCoverPicker();
    const seq = gameDetailsSeq;
    window.launcher.listCoverImages().then((res) => {
        if (!gameDetailsCoverPicker || seq !== gameDetailsSeq) return;
        gameDetailsCoverPicker.items = res && res.ok ? res.items || [] : [];
        gameDetailsCoverPicker.loading = false;
        renderCoverPicker();
    }).catch(ignoreError);
}

function chooseCoverRow() {
    const e = gameDetailsEntry;
    const row = coverPickerRows()[gameDetailsCoverPicker.focus];
    if (!e || !row) return;
    const done = (res, okKey) => {
        showStatus(res && res.ok ? tr(okKey) : tr('toast.coverFailed'), !(res && res.ok));
        if (!(res && res.ok)) return;
        gameDetailsCoverPicker = null;
        if (gamesDetails.isOpen()) {
            window.launcher.getGameDetails({ key: e.key, kind: e.kind, params: e.params || {} })
                .then((d) => { if (gamesDetails.isOpen()) { gameDetailsData = d && d.ok ? d : gameDetailsData; renderGameDetails(); } })
                .catch(ignoreError);
            renderGameDetails();
        }
        refreshGamesPanel().catch(ignoreError); // the new cover should show in the lists too
    };
    if (row.id === 'clear') window.launcher.clearCoverOverride(e.key).then((r) => done(r, 'toast.coverCleared')).catch(ignoreError);
    else window.launcher.setCoverOverride(e.key, row.path).then((r) => done(r, 'toast.coverSet')).catch(ignoreError);
}

function renderGameDetails() {
    const e = gameDetailsEntry;
    if (!e) return;
    if (gameDetailsCoverPicker) { renderCoverPicker(); return; }
    const pinned = favoriteKeySet().has(e.key);
    const cover = e.cover
        ? `<img class="game-details-img" src="${esc(fileUrl(e.cover))}" alt="">`
        : `<div class="game-details-noart">${esc(e.name || '')}</div>`;
    const system = e.kind === 'retroarch' && e.params && e.params.system ? ` · ${esc(e.params.system)}` : '';
    let factsHtml;
    if (!gameDetailsData) factsHtml = loadingBlock('sm');
    else if (gameDetailsData.ok === false) factsHtml = `<div class="game-details-note">${esc(tr('games.detailsFailed'))}</div>`;
    else {
        const facts = gameDetailsFacts(gameDetailsData);
        factsHtml = facts.length
            ? `<dl class="game-details-facts">${facts.map((f) => `
                <dt>${esc(f.label)}</dt>
                <dd${f.path ? ' class="game-details-path"' : ''}>${esc(f.value)}${f.note ? ` ${currentTag(f.note, { paren: true })}` : ''}</dd>`).join('')}</dl>`
            : `<div class="game-details-note">${esc(tr('games.detailsNoData'))}</div>`;
    }
    const meta = gameDetailsData && gameDetailsData.ok !== false ? gameDetailsData.metadata : null;
    const descHtml = meta && meta.description ? safeHtml`<div class="game-details-desc">${meta.description}</div>` : '';
    const heroHtml = meta && meta.hero ? safeHtml`<img class="game-details-hero" src="${fileUrl(meta.hero)}" alt="">` : '';
    const actions = gameDetailsActions().map((a, i) =>
        `<div class="settings-item${i === gameDetailsFocus ? ' focused' : ''}">${esc(a.label)}</div>`).join('');
    $('gamesDetailsContent').innerHTML = `
        ${heroHtml}
        <div class="game-details">
            <div class="game-details-cover">${cover}</div>
            <div class="game-details-info">
                <div class="game-details-source">${currentTag(favoriteBadgeLabel(e))}${system}${pinned ? ` <span class="game-details-pin">★ ${esc(tr('games.detailsPinned'))}</span>` : ''}</div>
                ${factsHtml}
                ${descHtml}
            </div>
        </div>
        <div class="game-details-actions">${actions}</div>`;
    wireCoverFallback($('gamesDetailsContent'), '.game-details-img', () => e.name || '');
}

function toggleGameDetailsFavorite() {
    if (!gameDetailsEntry) return;
    toggleFavoriteEntry(gameDetailsEntry).then(() => {
        if (gamesDetails.isOpen()) renderGameDetails();
    }).catch(ignoreError);
}

// Hide / restore from the details view: after hiding, the view closes (the game dropped out of the list), the toast says where it can be
// restored; on restore (with hidden ones shown) the view stays.
function hideGameFromDetails(gp) {
    const e = gameDetailsEntry;
    if (!e) return;
    const nowHidden = toggleGameHidden(e.key);
    feedback('nav');
    if (nowHidden && !gamesShowHidden) {
        closeGameDetails(gp);
        showStatus(tr('games.hiddenToast', { name: e.name || '' }), false, { ms: 3500 });
    } else {
        showStatus(tr(nowHidden ? 'games.hiddenShort' : 'games.unhiddenToast'));
        renderGameDetails();
    }
}

// Editing the launch options with the on-screen keyboard (DONE = save; empty text deletes). main rejects unparseable / forbidden text (e.g.
// `LD_PRELOAD=…`, an unterminated quote) — the toast says so.
function editGameLaunchOptions() {
    const e = gameDetailsEntry;
    if (!e) return;
    const key = gameOptionsKey(e);
    openKeyboard({
        title: tr('games.optionsTitle'), initial: gameDetailsOptions, maxLength: 300, layout: 'full',
        ownerStates: gamesDetails.states,
        onConfirm: (text) => {
            window.launcher.setGameLaunchOption(key, text).then((res) => {
                if (!res || !res.ok) { showStatus(tr('toast.launchOptionsRejected'), true); return; }
                gameDetailsOptions = res.text || '';
                showStatus(tr(gameDetailsOptions ? 'toast.launchOptionsSaved' : 'toast.launchOptionsCleared'));
                if (gamesDetails.isOpen()) renderGameDetails();
            }).catch(ignoreError);
        },
        onCancel: () => {},
    });
}

function handleGameDetailsInput(gp) {
    if (gameDetailsCoverPicker) {
        const rows = coverPickerRows();
        navList(gp, gamesDetails.states, {
            count: rows.length,
            move: (dd, repeated) => { gameDetailsCoverPicker.focus = stepIndex(gameDetailsCoverPicker.focus, dd, rows.length, repeated); renderCoverPicker(); },
            onSelect: () => { if (!gameDetailsCoverPicker.loading) chooseCoverRow(); },
            onBack: () => { gameDetailsCoverPicker = null; renderGameDetails(); },
        });
        return;
    }
    const actions = gameDetailsActions();
    navList(gp, gamesDetails.states, {
        count: actions.length,
        move: (d, repeated) => { gameDetailsFocus = stepIndex(gameDetailsFocus, d, actions.length, repeated); renderGameDetails(); },
        onSelect: () => {
            const a = actions[gameDetailsFocus];
            if (!a) return;
            if (a.id === 'launch') {
                const e = gameDetailsEntry;
                closeGameDetails(gp);
                startGameLaunch({ kind: e.kind, params: e.params || {}, name: e.name, cover: e.cover, fromPanel: true });
            } else if (a.id === 'pin') {
                toggleGameDetailsFavorite();
            } else if (a.id === 'cover') {
                openCoverPicker();
            } else if (a.id === 'options') {
                editGameLaunchOptions();
            } else if (a.id === 'hide') {
                hideGameFromDetails(gp);
            } else {
                closeGameDetails(gp);
            }
        },
        onBack: () => closeGameDetails(gp),
    });
    edge(gamesDetails.states, 'pin', gp.buttons[BTN.triangle]?.pressed, () => toggleGameDetailsFavorite());
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { gameDetailsFacts });
}
