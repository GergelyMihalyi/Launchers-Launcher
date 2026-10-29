// Launcher card quick actions: a LONG ✕ press on the focused REAL launcher card (not GAMES_CARD, not the Continue/quick-launch bar) opens
// a `#cardMenuOverlay` ("Move to the start" / "Accent color ▸" / "Remove" — the latter only on a custom launcher). The hold timing is in
// gamepad.js `handleCardCrossInput()`; a short ✕ LAUNCHES (`navActivate` runs on RELEASE). Load order: AFTER carousel.js/games-panel.js,
// BEFORE gamepad.js. Background: docs/dev/renderer/home.md#card-quick-actions

let cardMenuLauncherId = null;
let cardMenuPage = 'root'; // 'root' | 'accent'
let cardMenuFocus = 0;
// `launchers-changed` (set-launcher-order / remove-launcher / set-launcher-accent) triggers a generic "ORDER SAVED" toast in
// renderer/ipc.js — the card menu shows its own, more precise toast, so the next generic one is suppressed (once).
let suppressLaunchersToast = false;

// Remove = confirmation + undo. The first ✕ on the "Remove" row only ARMS it (the system menu pattern, resets by itself after
// `CARD_REMOVE_ARM_MS`), the second executes; after that, for `CARD_REMOVE_UNDO_MS` △ on the home screen BRINGS BACK the launcher instead of
// opening the Games panel (main keeps it for 30 s, `LAUNCHER_REMOVE_UNDO_MS`).
const CARD_REMOVE_ARM_MS = 3000;
const CARD_REMOVE_UNDO_MS = 8000;
let cardMenuRemoveArmed = false;
let cardMenuArmTimer = null;
// `{ id, name, until, toast }` — the undoable removal (`toast` is the visible text, closed early after the undo), or null.
let pendingLauncherUndo = null;

function clearCardMenuArm() {
    if (cardMenuArmTimer) { clearTimeout(cardMenuArmTimer); cardMenuArmTimer = null; }
    cardMenuRemoveArmed = false;
}

// The home screen's △ asks this (renderer/gamepad.js): is there still a valid undo.
function launcherUndoPending(now = Date.now()) {
    return !!pendingLauncherUndo && now < pendingLauncherUndo.until;
}

function undoLauncherRemoval() {
    const u = pendingLauncherUndo;
    pendingLauncherUndo = null;
    if (!u) return;
    suppressLaunchersToast = true;
    window.launcher.undoRemoveLauncher(u.id);
    dismissStatus(u.toast);
    showStatus(tr('toast.cardRestored', { name: u.name.toUpperCase() }));
}

// A fixed palette for the kiosk (not a full HSV picker) — reuses the `.theme-swatch` pattern. `hex: null` = "Default" (deletes the
// `launcherAccents` entry → back to the default / the global --accent).
const CARD_ACCENT_PALETTE = [
    { hex: null },
    { hex: '#1a9fff' }, { hex: '#7a5cff' }, { hex: '#ff7a2f' }, { hex: '#2ecc71' },
    { hex: '#ff4f9d' }, { hex: '#e74c3c' }, { hex: '#22d3ee' }, { hex: '#f5b301' },
];

// Is the focus on a real launcher card (not GAMES_CARD, not a bar)? -> the launcher id, or null.
function focusedLauncherCardId() {
    if (recentBarFocus >= 0 || continueFocus >= 0) return null;
    const card = cards[focusedIndex];
    if (!card) return null;
    const id = card.dataset.app;
    if (id === GAMES_CARD_ID) return null;
    return launchers.some((l) => l.id === id) ? id : null;
}

// Lifecycle on the shared `createOverlay` (renderer/util.js).
const cardMenu = createOverlay({
    elementId: 'cardMenuOverlay',
    // The opening ✕ hold / □ may still be held — the menu must not take it as an immediate selection.
    enterStates: { cross: true },
    // The main nav's ✕/PS edge state: if an action was chosen with ✕, the main branch must not take it as a new launch on the next frame.
    syncOnClose: () => ({ states: buttonStates, keys: ['cross', 'ps'] }),
    onOpen: (launcherId) => {
        cardMenuLauncherId = launcherId;
        cardMenuPage = 'root';
        cardMenuFocus = 0;
        clearCardMenuArm();
        renderCardMenu();
    },
    onClose: () => clearCardMenuArm(),
});

function openCardMenu(launcherId) { cardMenu.open(launcherId); }

function closeCardMenu(gp) { cardMenu.close(gp); }

function cardMenuLauncher() {
    return launchers.find((l) => l.id === cardMenuLauncherId) || null;
}

// Is the launcher id known in the Games panel's source model (renderer/games-panel/games-panel.js LAUNCHER_ID_TO_GAMES_SOURCE) — the
// "Open games" row only appears for such a launcher (a custom/unknown launcher has no "game list").
function launcherHasGamesEntry(id) {
    return id === 'heroic' || !!LAUNCHER_ID_TO_GAMES_SOURCE[id] || customGameLauncherIds.has(id);
}

function cardMenuRootRows() {
    const l = cardMenuLauncher();
    const rows = [{ id: 'toFront', label: tr('card.menuToFront') }];
    if (l && launcherHasGamesEntry(l.id)) rows.push({ id: 'games', label: tr('card.menuGames') });
    rows.push({ id: 'accent', label: tr('card.menuAccent') });
    if (l && l.custom) rows.push({ id: 'remove', label: tr('card.menuRemove') });
    return rows;
}

// Choosing the "Open games" row: the card menu closes in any case (the user lands either in the Games panel or — for an empty source,
// by user decision — in the card view); openGamesPanelForLauncher (renderer/games-panel/games-panel.js) decides asynchronously whether
// there is a source to open.
function openLauncherGamesFromCardMenu(launcherId, gp) {
    const name = (cardMenuLauncher() || {}).name || '';
    closeCardMenu(gp);
    openGamesPanelForLauncher(launcherId).then((opened) => {
        if (!opened) showStatus(tr('toast.cardGamesEmpty', { name }));
    }).catch(ignoreError);
}

function renderCardMenu() {
    const l = cardMenuLauncher();
    $('cardMenuTitle').textContent = l ? l.name : tr('card.menuTitle');
    $('cardMenuHint').innerHTML = subviewHint('hint.select');

    if (cardMenuPage === 'accent') {
        const cur = (l && l.accent) || null;
        $('cardMenuContent').innerHTML = CARD_ACCENT_PALETTE.map((c, i) => {
            const sw = c.hex
                ? `<span class="theme-swatch"><span style="background:${c.hex}"></span></span>`
                : '';
            const label = c.hex ? c.hex.toUpperCase() : tr('card.accentDefault');
            const tag = (c.hex || null) === cur ? ` ${currentTag()}` : '';
            return `<div class="settings-item ${i === cardMenuFocus ? 'focused' : ''}">${sw}<span class="bt-name">${esc(label)}</span>${tag}</div>`;
        }).join('');
        return;
    }

    const rows = cardMenuRootRows();
    $('cardMenuContent').innerHTML = rows.map((r, i) => {
        const armed = r.id === 'remove' && cardMenuRemoveArmed;
        const label = armed ? tr('sv.powerConfirm', { confirm: btnGlyph('confirm') }) : r.label;
        const cls = ['settings-item'];
        if (i === cardMenuFocus) cls.push('focused');
        if (armed) cls.push('armed');
        return `<div class="${cls.join(' ')}"><span class="bt-name">${esc(label)}</span></div>`;
    }).join('');
}

function selectCardMenuRow(gp, row) {
    if (!row) return;
    if (row.id === 'games') {
        openLauncherGamesFromCardMenu(cardMenuLauncherId, gp);
        return;
    }
    if (row.id === 'accent') {
        const cur = (cardMenuLauncher() || {}).accent || null;
        const idx = CARD_ACCENT_PALETTE.findIndex((c) => (c.hex || null) === cur);
        cardMenuPage = 'accent';
        cardMenuFocus = idx >= 0 ? idx : 0;
        renderCardMenu();
        return;
    }
    if (row.id === 'toFront') {
        const ids = [cardMenuLauncherId, ...launchers.filter((l) => l.id !== cardMenuLauncherId).map((l) => l.id)];
        suppressLaunchersToast = true;
        window.launcher.setLauncherOrder(ids);
        showStatus(tr('toast.cardToFront'));
        closeCardMenu(gp);
        return;
    }
    if (row.id === 'remove') {
        if (!cardMenuRemoveArmed) {
            cardMenuRemoveArmed = true;
            feedback('nav');
            renderCardMenu();
            cardMenuArmTimer = setTimeout(() => {
                cardMenuArmTimer = null;
                cardMenuRemoveArmed = false;
                if (cardMenu.isOpen()) renderCardMenu();
            }, CARD_REMOVE_ARM_MS);
            return;
        }
        clearCardMenuArm();
        feedback('launch');
        const name = (cardMenuLauncher() || {}).name || '';
        const toast = tr('toast.cardRemovedUndo', { name: name.toUpperCase(), undo: btnGlyph('menu') });
        pendingLauncherUndo = { id: cardMenuLauncherId, name, until: Date.now() + CARD_REMOVE_UNDO_MS, toast };
        suppressLaunchersToast = true;
        window.launcher.removeLauncher(cardMenuLauncherId);
        showStatus(toast, false, { ms: CARD_REMOVE_UNDO_MS });
        closeCardMenu(gp);
    }
}

function handleCardMenuInput(gp) {
    if (cardMenuPage === 'accent') {
        const count = CARD_ACCENT_PALETTE.length;
        navList(gp, cardMenu.states, {
            count,
            move: (d, repeated) => { cardMenuFocus = stepIndex(cardMenuFocus, d, count, repeated); renderCardMenu(); },
            onSelect: () => {
                const c = CARD_ACCENT_PALETTE[cardMenuFocus];
                suppressLaunchersToast = true;
                window.launcher.setLauncherAccent({ id: cardMenuLauncherId, accent: c.hex });
                showStatus(tr('toast.cardAccentSet'));
                closeCardMenu(gp);
            },
            onBack: () => {
                // The index of the "Accent color" row is not a fixed 1 — the "Open games" row is present or not per launcher in the root list, see
                // cardMenuRootRows().
                const rootRows = cardMenuRootRows();
                cardMenuPage = 'root';
                cardMenuFocus = Math.max(0, rootRows.findIndex((r) => r.id === 'accent'));
                renderCardMenu();
            },
        });
        return;
    }
    const rows = cardMenuRootRows();
    navList(gp, cardMenu.states, {
        count: rows.length,
        move: (d, repeated) => { cardMenuFocus = stepIndex(cardMenuFocus, d, rows.length, repeated); clearCardMenuArm(); renderCardMenu(); },
        onSelect: () => selectCardMenuRow(gp, rows[cardMenuFocus]),
        onBack: () => closeCardMenu(gp),
    });
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { CARD_ACCENT_PALETTE, CARD_REMOVE_UNDO_MS });
}
