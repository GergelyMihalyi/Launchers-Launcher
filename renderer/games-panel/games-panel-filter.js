// The Games panel's source filter popup (□ Square): which launchers appear in the ALL view (`gamesHiddenSources` config key). The popup uses
// the shared `createOverlay` (renderer/util.js).

// Source filter popup (□ Square): which launchers should NOT appear in the ALL (mixed) view. Only narrows the ALL aggregation — the source's
// own chip (L2/R2 cycle) and the "Open games" quick-menu row still reach it. Persistent (`gamesHiddenSources` config key).
let gamesHiddenSources = new Set();

// Individually hidden games (`hiddenGames` config key: favorite keys). The Set is ALWAYS recreated on change (the ALL list's memo watches
// identity). `gamesShowHidden` = whether the panel should show the hidden ones (marked) in this run — needed for restoring.
let gamesHiddenGames = new Set();
let gamesShowHidden = false;
const GAMES_SHOW_HIDDEN_ROW = '__showHidden';

// "NEW" badge: the keys of the games that appeared in the last 7 days and were not launched yet (main's `note-games-seen` response).
// Recreated on change, like `gamesHiddenGames`.
let gamesNewKeys = new Set();

/** The "NEW" marker (prefix) in the list — only if the key is among the fresh games. */
function newMark(key) {
    return key && gamesNewKeys.has(key) ? `${tr('games.newBadge')} · ` : '';
}

/** Is the game with this key hidden in the current view ("show hidden" overrides it). */
function isGameFiltered(key) {
    return !gamesShowHidden && !!key && gamesHiddenGames.has(key);
}

/** The hidden-game marker in the lists (only visible with "show hidden"). */
function hiddenMark(key) {
    return gamesShowHidden && key && gamesHiddenGames.has(key) ? '🚫 ' : '';
}

/** Hides / restores a game; `true` = hidden now. Persists + redraws. */
function toggleGameHidden(key) {
    if (!key) return false;
    const next = new Set(gamesHiddenGames);
    const wasHidden = next.delete(key);
    if (!wasHidden) next.add(key);
    gamesHiddenGames = next;
    window.launcher.setHiddenGames([...next]);
    return !wasHidden;
}

let gamesFilterSources = []; // the currently available source-id list captured when the popup opened

let gamesFilterFocusIndex = 0;

// --- Source filter popup (□ Square) ---
// A toggle list of which launchers appear in the ALL (mixed) view. A standalone overlay (`#gamesFilterOverlay`) ABOVE the Games panel — the
// `renderer/launcher-install.js` pattern (a nested popup inside an already open overlay).


// The source filter popup — lifecycle on the shared `createOverlay` (renderer/util.js).
const gamesFilter = createOverlay({
    elementId: 'gamesFilterOverlay',
    // The popup must not take the opening Square as an immediate selection while it is still held.
    enterStates: { square: true },
    // The underlying Games panel's button watching did not run while the popup was open — the physical state of the closing button
    // (Circle/PS/Square) must be synced to the panel.
    syncOnClose: () => ({ states: gamesPanel.states, keys: ['cross', 'cancel', 'square'] }),
    onOpen: () => {
        gamesFilterSources = [...filterableSources(), ...(gamesHiddenGames.size ? [GAMES_SHOW_HIDDEN_ROW] : [])];
        gamesFilterFocusIndex = 0;
        $('gamesFilterTitle').textContent = tr('games.sourceFilterTitle');
        $('gamesFilterHint').innerHTML =
            `<span>▲▼ ${esc(tr('hint.nav'))}</span>`
            + `<span>${btnIcon('confirm')} ${esc(tr('hint.toggle'))}</span>`
            + `<span>${btnIcon('back')} / ${btnIcon('alt')} ${esc(tr('hint.close'))}</span>`;
        renderGamesSourceFilter();
    },
    onClose: () => renderGamesPanel(),
});

function openGamesSourceFilter() { gamesFilter.open(); }

function closeGamesSourceFilter(gp) { gamesFilter.close(gp); }


function toggleGamesHiddenSource(id) {
    if (!id) return;
    if (id === GAMES_SHOW_HIDDEN_ROW) {
        gamesShowHidden = !gamesShowHidden;
        renderGamesSourceFilter();
        return;
    }
    if (gamesHiddenSources.has(id)) gamesHiddenSources.delete(id);
    else gamesHiddenSources.add(id);
    window.launcher.setGamesHiddenSources([...gamesHiddenSources]);
    renderGamesSourceFilter();
}


function renderGamesSourceFilter() {
    if (!gamesFilterSources.length) {
        $('gamesFilterContent').innerHTML = emptyState(tr('games.empty'));
        return;
    }
    $('gamesFilterContent').innerHTML = gamesFilterSources.map((id, i) => {
        if (id === GAMES_SHOW_HIDDEN_ROW) {
            const focusedRow = i === gamesFilterFocusIndex ? ' focused' : '';
            return `<div class="settings-subhead">${esc(tr('games.hiddenGames'))}</div>`
                + `<div class="settings-item${focusedRow}">${gamesShowHidden ? '☑' : '☐'} <span class="bt-name">${esc(tr('games.showHidden', { n: gamesHiddenGames.size }))}</span></div>`;
        }
        const on = !gamesHiddenSources.has(id);
        const box = on ? '☑' : '☐';
        const focused = i === gamesFilterFocusIndex ? ' focused' : '';
        return `<div class="settings-item${focused}">${box} <span class="bt-name">${esc(filterChipLabel(id))}</span></div>`;
    }).join('');
}


function handleGamesFilterInput(gp) {
    const count = gamesFilterSources.length;
    navList(gp, gamesFilter.states, {
        count,
        move: (d, repeated) => { gamesFilterFocusIndex = stepIndex(gamesFilterFocusIndex, d, count, repeated); renderGamesSourceFilter(); },
        onSelect: () => toggleGamesHiddenSource(gamesFilterSources[gamesFilterFocusIndex]),
        onBack: () => closeGamesSourceFilter(gp),
    });
    edge(gamesFilter.states, 'square', gp.buttons[BTN.square]?.pressed, () => closeGamesSourceFilter(gp));
}
