// Favorite pinning of the Games panel (△): the key set of the `favoriteGames` config key, the rows of the `★ FAVORITE` filter, the badge,
// pin/unpin and refreshing the open panel after a cover download. The `gamesPanelFavorites` state lives in games-panel.js.

function favoriteKeySet() {
    return new Set(gamesPanelFavorites.map((f) => f.key));
}

// The favoriteGames entry from a games-grid row (type 'game').

function favoriteEntryFromGameRow(row) {
    const { kind, params } = GAME_SOURCE_BY_ID[row.source].launch(row);
    return { key: gameRowKey(row), name: row.name, cover: row.cover || null, kind, params };
}

// The rows of the 'fav' filter: the stored favorites as game cells (`sourceLabel` for the badge).

function favoriteRows() {
    return gamesPanelFavorites.map((f) => ({
        type: 'favorite', key: f.key, name: f.name, cover: f.cover || null,
        kind: f.kind, params: f.params || {}, sourceLabel: favoriteBadgeLabel(f),
    }));
}


function favoriteBadgeLabel(fav) {
    if (fav.kind === 'retroarch') return SOURCE_FILTER_LABELS.retro;
    if (fav.kind === 'steam') return 'STEAM';
    if (fav.kind === 'lutris') return 'LUTRIS';
    if (fav.kind === 'heroic') return GAME_SOURCE_BY_ID[fav.params && fav.params.runner]?.label || 'HEROIC';
    if (fav.kind === 'custom') {
        const l = (typeof launchers !== 'undefined' ? launchers : []).find((x) => x.id === (fav.params && fav.params.launcherId));
        return l ? String(l.name).toUpperCase() : 'OTHER';
    }
    return EMULATOR_SOURCE_BY_ID[fav.kind]?.label || '★';
}

// The recent/favorite-shaped entry of the focused item (root grid/list OR RetroArch system ROM list) — `{ key, name, cover, kind, params }` —
// or `null` (e.g. a RetroArch system row). The shared source of pinning (△) AND the details view (hold ✕, games-panel-details.js).
// `includeRecent` also returns the focused item of the "Recently played" bar (pinning there has been a no-op since v1).
function focusedGameEntry({ includeRecent = false } = {}) {
    if (gamesPanelSystem) {
        const g = systemGamesView()[gamesPanelFocusIndex];
        if (!g) return null;
        return {
            key: `retroarch:${gamesPanelSystem}:${g.label}`, name: g.label, cover: g.cover || null, kind: 'retroarch',
            params: { system: gamesPanelSystem, path: g.path },
        };
    }
    const row = gamesPanelVisibleRows[gamesPanelFocusIndex];
    if (!row) return null;
    if (row.type === 'favorite') {
        return { key: row.key, name: row.name, cover: row.cover || null, kind: row.kind, params: row.params || {} };
    }
    if (row.type === 'game') return gameRowKey(row) ? favoriteEntryFromGameRow(row) : null;
    if (row.type === 'unified') {
        return { key: row.favKey, name: row.name, cover: row.cover || null, kind: row.launch.kind, params: row.launch.params };
    }
    if (EMULATOR_SOURCE_BY_TYPE[row.type]) {
        const src = EMULATOR_SOURCE_BY_TYPE[row.type];
        const { kind, params } = src.launch(row);
        return { key: `${src.keyPrefix}-${row[src.idField]}`, name: row.name, cover: row.cover || null, kind, params };
    }
    if (includeRecent && row.type === 'recent') {
        const it = row.items && row.items[gamesPanelRecentItemFocus];
        return it ? { key: it.key, name: it.name, cover: it.cover || null, kind: it.kind, params: it.params || {} } : null;
    }
    return null;
}

// Pins/unpins an entry (the `favoriteGames` config key) + refreshes the open panel. A Promise — the details view redraws its own "Pin" row
// at the end.
function toggleFavoriteEntry(entry) {
    if (!entry || !entry.key) return Promise.resolve(null);
    return window.launcher.toggleFavoriteGame(entry).then((res) => {
        if (!gamesPanel.isOpen() || !res) return res;
        gamesPanelFavorites = Array.isArray(res.list) ? res.list : [];
        // If we unpinned the last favorite in the 'fav' filter → back to 'all'.
        if (gamesPanelSource === 'fav' && !gamesPanelFavorites.length) gamesPanelSource = 'all';
        feedback('nav');
        showStatus(res.favorited ? tr('games.pinned') : tr('games.unpinned'));
        renderGamesPanelHint();
        renderGamesPanel();
        return res;
    });
}

// Pin/unpin of the focused row (△).
function toggleFavoriteFocused() {
    toggleFavoriteEntry(focusedGameEntry()).catch(ignoreError);
}

// The same "running-changed" nudge, only for the cover download of the favorite RetroArch games — if the Games panel is open, it refetches
// the favorite list so the cover shows up WITHOUT reopening the panel as soon as the background download finished.

function refreshGamesPanelFavoritesIfOpen() {
    if (!gamesPanel.isOpen()) return;
    window.launcher.getFavoriteGames().then((favs) => {
        if (!gamesPanel.isOpen()) return;
        gamesPanelFavorites = Array.isArray(favs) ? favs : [];
        renderGamesPanel();
    }).catch(ignoreError);
}
