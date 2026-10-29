// Games panel — rendering: every HTML builder lives here (source-filter chip row, cover grid `gamesGridHtml`, text lists, the RetroArch system
// view `renderGamesPanelSystemList`, the virtualized windowed render `unifiedSectionHtml`/`virtualWindow`/`virtualPadding`) + the main
// dispatcher `renderGamesPanel`. `filteredGamesRows()`/`buildUnifiedRows()` give the rows of the active filter (memoized for the ~16,000 item
// ALL list). Load order: AFTER games-panel-sources.js / -covers.js / -search.js. The pure helpers (`nextLetterIndex`/`gridNavIndex`/
// `nextInCycle`/`retroGroupsToUnifiedRows`/`mergeSortedByName`/`virtualWindow`/`virtualPadding`/`toUnifiedRow`/`gridCellLabel`/`gridCellKey`/
// `isGridRow`/`effectiveViewMode`/`sourceIncluded`/`retroSystemShort`) are exported (test/games-panel/games-panel.test.js; under Node
// `GAME_SOURCE_BY_ID`/`EMULATOR_SOURCE_BY_TYPE`/`gameRowKey` come from games-panel-sources.js). Background: docs/dev/games-panel.md#the-panel-ui
if (typeof GAME_SOURCE_BY_ID === 'undefined' && typeof module !== 'undefined') {
    // eslint-disable-next-line no-undef
    Object.assign(globalThis, module.require('./games-panel-sources.js'));
}


// --- Pure navigation helpers (test/games-panel/games-panel.test.js) ---

function firstLetterOf(s) {
    return String(s == null ? '' : s).trim().charAt(0).toUpperCase();
}

// Letter jump: jumps to the START of the next initial-letter group in the `dir` (+1 / -1) direction. Down (dir<0): if we are not at the start
// of the current group, first there; from there to the start of the previous group. Empty/bad index -> unchanged.

function nextLetterIndex(labels, fromIdx, dir) {
    const n = labels.length;
    if (!n) return 0;
    let i = Math.max(0, Math.min(n - 1, fromIdx));
    const cur = firstLetterOf(labels[i]);
    if (dir > 0) {
        for (let j = i + 1; j < n; j++) {
            if (firstLetterOf(labels[j]) !== cur) return j;
        }
        return n - 1;
    }
    // dir < 0
    let start = i;
    while (start - 1 >= 0 && firstLetterOf(labels[start - 1]) === cur) start--;
    if (start < i) return start; // we were not at the start of the group -> jump to the start of the group
    if (start === 0) return 0;
    const prev = firstLetterOf(labels[start - 1]);
    let j = start - 1;
    while (j - 1 >= 0 && firstLetterOf(labels[j - 1]) === prev) j--;
    return j;
}

// Wrapping step on a list (source filter chips). Unknown/missing `current` -> starts from the beginning of the list.

function nextInCycle(list, current, dir) {
    if (!list.length) return current;
    let i = list.indexOf(current);
    if (i < 0) i = 0;
    return list[(i + dir + list.length) % list.length];
}

// The actual grid/list mode of source `id` per the `gamesViewMode` config key — the renderer-side mirror of `resolveGamesViewMode()` in
// `lib/prefs.js` (`lib/` and `renderer/` are separate runtimes, no shared require, see "Preload and the sandbox" in docs/dev/architecture.md).
// Missing/invalid entry -> `list` for `all`, `grid` for every other source (the default from BEFORE the switch existed).

function effectiveViewMode(map, id) {
    const v = map && map[id];
    return v === 'grid' || v === 'list' ? v : (id === 'all' ? 'list' : 'grid');
}


// Grid navigation: optional `headRows` full-width rows (the "Recently played" summary bar) + a grid of `nGames` cells (`cols` columns) + then
// `total - headRows - nGames` list rows (retro systems). Returns the new flat index by `dir` ('up'|'down'|'left'|'right'). From the head row
// down it steps to the start of the grid (or with an empty grid straight to the list); from the bottom edge of the grid down to the first
// list row; from the top of the list up back to the last grid row (or with an empty grid to the head row).

function gridNavIndex(idx, dir, cols, nGames, total, headRows = 0) {
    cols = Math.max(1, cols);
    let i = Math.max(0, Math.min(total - 1, idx));
    if (i < headRows) {
        if (dir === 'down') return headRows < total ? headRows : i;
        return i; // ◀▶ of the head row is handled by the caller (sub-index within the row)
    }
    if (i < headRows + nGames) {
        const gi = i - headRows;
        if (dir === 'left') return gi % cols === 0 ? i : i - 1;
        if (dir === 'right') return (gi + 1 < nGames && (gi + 1) % cols !== 0) ? i + 1 : i;
        if (dir === 'up') {
            if (gi - cols >= 0) return i - cols;
            return headRows > 0 ? headRows - 1 : i;
        }
        if (dir === 'down') {
            const down = i + cols;
            if (down < headRows + nGames) return down;
            return (headRows + nGames) < total ? headRows + nGames : i; // last grid row -> first retro row
        }
        return i;
    }
    // retro list rows
    if (dir === 'up') {
        if (i - 1 >= headRows + nGames) return i - 1;
        if (nGames > 0) return headRows + nGames - 1;
        if (headRows > 0) return headRows - 1;
        return 0;
    }
    if (dir === 'down') return i + 1 < total ? i + 1 : i;
    return i;
}


function renderGamesPanelHint() {
    const retroGrid = gamesPanelSystem && effectiveViewMode(gamesViewModeMap, 'retro') === 'grid';
    // With an active (non-empty) search the first back press only clears the search.
    const searchHint = `<span>${btnIcon('view')} ${esc(tr('games.hintSearch'))}</span>`;
    const closeLabel = gamesPanelQuery ? tr('games.hintClearSearch') : tr('hint.close');
    const backLabel = gamesPanelQuery ? tr('games.hintClearSearch') : tr('hint.back');
    $('gamesPanelHint').innerHTML = gamesPanelSystem ? `
        <span>${retroGrid ? '▲▼◀▶' : '▲▼'} ${esc(tr('hint.nav'))}</span>
        <span>L2 / R2 ${esc(tr('games.hintLetter'))}</span>
        ${searchHint}
        <span>${btnIcon('menu')} ${esc(tr('games.hintPin'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('bar.launch'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('games.hintDetailsHold'))}</span>
        <span>${btnIcon('back')} ${esc(backLabel)}</span>
    ` : `
        <span>▲▼◀▶ ${esc(tr('hint.nav'))}</span>
        ${availableSources().length > 1 ? `<span>L2 / R2 ${esc(tr('games.hintFilter'))}</span>` : ''}
        ${(filterableSources().length > 1 || gamesHiddenGames.size) ? `<span>${btnIcon('alt')} ${esc(tr('games.hintSourceFilter'))}</span>` : ''}
        ${searchHint}
        <span>R3 ${esc(tr('games.hintSort'))}</span>
        <span>${btnIcon('menu')} ${esc(tr('games.hintPin'))}</span>
        <span>${btnIcon('start')} ${esc(tr('games.hintRefresh'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('games.hintOpenLaunch'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('games.hintDetailsHold'))}</span>
        <span>${btnIcon('back')} ${esc(closeLabel)}</span>
    `;
}

// The source filter chips of the root view: always 'all', + 'fav' if there is a pinned favorite, + every source actually present
// (Steam/GOG/Epic/Amazon), + 'retro' if there is a RetroArch system.

function availableSources() {
    const out = ['all'];
    if (gamesPanelFavorites.length) out.push('fav');
    for (const s of GAME_SOURCES) {
        if (gamesPanelRows.some((r) => r.type === 'game' && r.source === s.id)) out.push(s.id);
    }
    if (gamesPanelRows.some((r) => r.type === 'retro-system')) out.push('retro');
    for (const s of EMULATOR_SOURCES) {
        if (gamesPanelRows.some((r) => r.type === s.type)) out.push(s.id);
    }
    return out;
}

// The source ids toggleable in the `gamesFilterOverlay` popup — the same list as the chip row (`availableSources()` MINUS 'all'/'fav', as
// those are not launcher sources).

function filterableSources() {
    return availableSources().filter((s) => s !== 'all' && s !== 'fav');
}

// Pure core: should the rows of source `id` appear under the `source` chip, given that `hiddenIds` (Set) holds the source ids excluded in
// the filter popup. For `source === 'all'` (ALL) the exclusion counts; for a specific chip (L2/R2 cycle) it does NOT.

function sourceIncluded(source, hiddenIds, id) {
    if (source === 'all') return !hiddenIds.has(id);
    return source === id;
}

// Wrapper reading the module state (`gamesPanelSource`/`gamesHiddenSources`) for `filteredGamesRows()`.

function includeSource(id) {
    return sourceIncluded(gamesPanelSource, gamesHiddenSources, id);
}

// The source id of a `list-games-recent` item (`{ kind, params }`) — from the same id set as `filteredGamesRows()`/`filterableSources()`.
// The `kind` of Heroic items is ALWAYS just 'heroic' (the store is in `params.runner`: gog / legendary / nile), RetroArch's 'retroarch' kind
// maps to the games panel's 'retro' source id, every other kind matches the source id 1:1.

function recentItemSourceId(item) {
    if (!item) return null;
    if (item.kind === 'heroic') return (item.params && item.params.runner) || null;
    if (item.kind === 'retroarch') return 'retro';
    return item.kind || null;
}


// --- Rendering ---

function renderGamesPanel() {
    if (gamesPanelSystem) {
        renderGamesPanelSystemList();
        return;
    }
    if (!gamesPanelLoadOk) {
        $('gamesPanelContent').innerHTML =
            emptyState(tr('games.listFailed'), `${btnGlyph('back')} ${tr('hint.close').toUpperCase()}`);
        return;
    }
    if (!gamesPanelRows.length) {
        $('gamesPanelContent').innerHTML = emptyState(tr('games.empty'));
        return;
    }

    const sources = availableSources();
    if (!sources.includes(gamesPanelSource)) gamesPanelSource = 'all';
    const { gameRows, retroRows, emulatorRows, unifiedRows } = filteredGamesRows();
    // The summary recent bar from EVERY launcher — only in the "ALL" filter (for a source-specific chip the mixed content of the bar would be
    // misleading), at the VERY TOP of the list, above both the shared list AND the retro list. Items from sources turned off in the filter popup
    // are left out.
    const recentItems = gamesPanelRecent.filter((it) => !gamesHiddenSources.has(recentItemSourceId(it)));
    // During an active search the bar is hidden (not filtered — it would cause index shifts and confusion above the results).
    const searching = isSearchActive(gamesPanelQuery);
    const recentRow = (recentGamesUiState.gamesPanelRecent && gamesPanelSource === 'all' && recentItems.length && !searching)
        ? { type: 'recent', items: recentItems } : null;
    gamesPanelShownUnified = unifiedRows;

    // The focus index moves on the flat list [recentRow?, ...gameRows, ...unifiedRows, ...retroRows, ...<emulator sections in registry order>]:
    // the recent bar (if any) as ONE row at index 0; in the "ALL" view the shared `unifiedRows` list follows in place of `gameRows` (always
    // empty), with any other source filter the grid/list sections (`unifiedRows` is always empty there). The offset of the emulator sections
    // comes from an accumulator.
    const headRows = recentRow ? 1 : 0;
    const afterGrid = headRows + gameRows.length;
    const afterUnified = afterGrid + unifiedRows.length;
    const afterRetro = afterUnified + retroRows.length;
    /** @type {{ id: string, rows: any[], offset: number }[]} */
    const emulatorSections = [];
    let totalRows = afterRetro;
    for (const src of EMULATOR_SOURCES) {
        const rows = emulatorRows[src.id];
        if (!rows || !rows.length) continue;
        emulatorSections.push({ id: src.id, rows, offset: totalRows });
        totalRows += rows.length;
    }
    gamesPanelVisibleRows = [
        ...(recentRow ? [recentRow] : []), ...gameRows, ...unifiedRows, ...retroRows,
        ...emulatorSections.flatMap((sec) => sec.rows),
    ];
    applyPendingGamesFocus(); // location memory (games-panel.js)
    gamesPanelFocusIndex = gamesPanelVisibleRows.length
        ? Math.min(gamesPanelFocusIndex, gamesPanelVisibleRows.length - 1) : 0;
    // Every present source is turned off in the filter popup -> the ALL view would stay empty (the chip row and the Square hint are still
    // needed so they can be turned back on).
    const allHiddenNote = (gamesPanelSource === 'all' && !totalRows && gamesHiddenSources.size && !searching)
        ? emptyState(tr('games.allHiddenEmpty')) : '';
    const searchEmptyNote = (searching && !totalRows)
        ? emptyState(tr('games.searchEmpty', { q: gamesPanelQuery.trim() })) : '';
    $('gamesPanelContent').innerHTML =
        (sources.length > 1 ? gamesFilterHtml(sources) : '')
        + gamesSearchBarHtml(totalRows - headRows)
        + (searching ? '' : romAccessWarningHtml(gamesPanelRomAccess, gamesPanelSource))
        + allHiddenNote
        + searchEmptyNote
        + (recentRow ? recentGamesHtml(recentRow) : '')
        + (gameRows.length ? (gameRows[0].grid ? gamesGridHtml(gameRows, headRows) : gameRowsListHtml(gameRows, headRows)) : '')
        + (unifiedRows.length ? unifiedSectionHtml(unifiedRows, afterGrid) : '')
        + (retroRows.length ? retroSystemsHtml(retroRows, afterUnified) : '')
        + emulatorSections.map((sec) => emulatorRowsHtml(sec.id, sec.rows, sec.offset)).join('');
    afterGamesPanelRender();
    if ((gamesPanelSource === 'all' || gamesPanelSource === 'retro') && gamesPanelRetroUnified) scheduleUnifiedRetroCoverFetch();
    // Lazy cover download of the network-downloading emulator grids (registry `networkCover`) — only the section of the ACTIVE source chip is
    // non-empty (per `includeSource()` of `filteredGamesRows()`).
    for (const sec of emulatorSections) {
        if (EMULATOR_SOURCE_BY_ID[sec.id].networkCover) scheduleNetworkCoverFetch(sec.id, sec.rows, sec.offset);
    }
}

// Warning about flatpak emulator ROM folders the sandbox does not see: all of them in "ALL", only its own on an emulator's chip; not
// focusable (does not shift the flat list's indexes).
function romAccessWarningHtml(hidden, source) {
    const list = (Array.isArray(hidden) ? hidden : []).filter((h) => source === 'all' || h.source === source);
    if (!list.length) return '';
    const lines = list.map((h) => `<div>⚠ ${esc(tr('games.romAccessHidden', { name: h.name, dir: h.dir }))}</div>`);
    return `<div class="games-rom-access-warn">${lines.join('')}`
        + `<div class="games-rom-access-hint">${esc(tr('games.romAccessHint'))}</div></div>`;
}

// The summary "recently played" row at the top of the "ALL" filter (10 mini covers, from every launcher) — ALWAYS sits at index 0 of the
// flat list, ◀▶ moves on the `gamesPanelRecentItemFocus` sub-index (see handleGamesPanelInput onHorizontal()).

function recentGamesHtml(recentRow) {
    const rowFocused = gamesPanelFocusIndex === 0;
    const items = recentRow.items.map((it, i) => {
        const focused = rowFocused && i === gamesPanelRecentItemFocus;
        const inner = it.cover
            ? `<img src="${fileUrl(it.cover)}" alt="" decoding="async">`
            : `<span class="recent-game-noart">${esc(it.name)}</span>`;
        return `<button class="recent-game${focused ? ' focused' : ''}" data-name="${esc(it.name)}" title="${esc(it.name)}">${inner}</button>`;
    }).join('');
    return `<div class="settings-subhead">${esc(tr('games.recentSubhead'))}</div>`
        + `<div class="games-recent-row${rowFocused ? ' row-focused' : ''}">${items}</div>`;
}


// Source filter: the 'retro' chip hides the grid, any game chip the retro list; 'fav' only the pinned favorites; an emulator chip narrows to
// its own row(s) (`emulatorRows[id]`). 'all' (ALL) merges the rows of Steam/GOG/Epic/Amazon/Lutris + every EMULATOR_SOURCES emulator into ONE
// alphabetical `unifiedRows` list, EXCEPT RetroArch (`retroRows` stays separate below). Every returned row gets a `row.grid` boolean field
// (`gamesViewMode`: `★ FAVORITE` and ALL with the `'all'` mode, the individual chips with their own id; the RetroArch system summary is never a
// grid) — read by the section choice of `renderGamesPanel()` and by `isGridRow()`.


function filteredGamesRows() {
    const gridOf = (id) => effectiveViewMode(gamesViewModeMap, id) === 'grid';
    // Live search: AFTER the chip filtering, on the active source's rows — with an inactive search (< SEARCH_MIN_CHARS) `find` is the identity.
    // Filtering runs on the ORIGINAL row objects (the `_sk` key is cached there), the `tag()` copies only come after.
    const q = gamesPanelQuery;
    const searching = isSearchActive(q);
    const find = (rows) => (searching ? searchRows(rows, q) : rows);
    if (gamesPanelSource === 'fav') {
        const grid = gridOf('all');
        return { gameRows: find(favoriteRows()).map((r) => ({ ...r, grid })), retroRows: [], emulatorRows: {}, unifiedRows: [] };
    }
    if (gamesPanelSource === 'all') {
        const grid = gridOf('all');
        const unifiedRows = find(buildUnifiedRows(grid));
        // If the full RetroArch ROM set is already merged into the shared list, the per-system summary is unnecessary (the RETRO chip's drill-down
        // stays); until it is loaded (or if it failed), the summary shows the old way.
        const retroMerged = includeSource('retro') && !!(gamesPanelRetroUnified && gamesPanelRetroUnified.length);
        let retroRows = (includeSource('retro') && !retroMerged)
            ? gamesPanelRows.filter((r) => r.type === 'retro-system') : [];
        // Until the ROM set is loaded, the system summary is filtered by the system NAME.
        if (searching) retroRows = searchRows(retroRows, q, (r) => r.system);
        return { gameRows: [], retroRows, emulatorRows: {}, unifiedRows };
    }
    const tag = (rows, id) => { const grid = gridOf(id); return rows.map((r) => ({ ...r, grid })); };
    const sortMode = effectiveSortMode(gamesSortModeMap, gamesPanelSource);
    const sorted = (rows) => sortGameRows(rows, sortMode, gamesSortStats)
        .filter((r) => !isGameFiltered(sortKeyOfRow(r)));
    const gameRows = tag(find(sorted(gamesPanelRows.filter((r) => r.type === 'game' && includeSource(r.source)))), gamesPanelSource);
    let retroRows = includeSource('retro') ? gamesPanelRows.filter((r) => r.type === 'retro-system') : [];
    let unifiedRows = [];
    if (searching && retroRows.length) {
        if (gamesPanelRetroUnified && gamesPanelRetroUnified.length) {
            // RETRO chip + search: instead of the system summary, a FLAT list of ROM matches across systems. The copies point to the persistent row via
            // `_src` (the lazy cover patch writes back there).
            const grid = gridOf('retro');
            unifiedRows = searchRows(gamesPanelRetroUnified, q).map((r) => ({ ...r, grid, _src: r }));
            retroRows = [];
        } else {
            retroRows = searchRows(retroRows, q, (r) => r.system); // no ROM set yet: by system name
        }
    }
    // The own sections of the registry emulators (EMULATOR_SOURCES) — source id → rows (at most one non-empty per the active chip; the render
    // walks them in registry order).
    /** @type {Record<string, any[]>} */
    const emulatorRows = {};
    for (const src of EMULATOR_SOURCES) {
        if (!includeSource(src.id)) continue;
        const rows = tag(find(sorted(gamesPanelRows.filter((r) => r.type === src.type))), src.id);
        if (rows.length) emulatorRows[src.id] = rows;
    }
    return { gameRows, retroRows, emulatorRows, unifiedRows };
}


function filterChipLabel(s) {
    if (s === 'all') return tr('games.filterAll');
    if (s === 'fav') return tr('games.filterFav');
    if (s === CUSTOM_GAMES_SOURCE_ID) return tr('games.filterCustom');
    return SOURCE_FILTER_LABELS[s] || s.toUpperCase();
}


function gamesFilterHtml(sources) {
    return '<div class="games-filter">' + sources.map((s) => (
        `<span class="games-filter-chip${s === gamesPanelSource ? ' active' : ''}">${esc(filterChipLabel(s))}</span>`
    )).join('') + '</div>';
}

// Source badge/favorite key of `gamesGridHtml()` — besides the 'game' (Steam/Heroic/Lutris, `GAME_SOURCE_BY_ID`) and 'favorite' rows it also
// recognizes the `EMULATOR_SOURCES` rows (Ryujinx, PCSX2, RPCS3, PPSSPP, …) AND the `'unified'` rows of the "ALL" view (`toUnifiedRow()`
// already carries the `sourceLabel`/`favKey` field), with the `${keyPrefix}-${row[idField]}` pattern already proven in
// `toggleFavoriteFocused()`.

function gridCellLabel(row) {
    if (row.type === 'unified' || row.type === 'favorite') return row.sourceLabel;
    if (row.type === 'game') return GAME_SOURCE_BY_ID[row.source]?.label || String(row.source).toUpperCase();
    const src = EMULATOR_SOURCE_BY_TYPE[row.type];
    return row.badge || (src ? src.label : '');
}


function gridCellKey(row) {
    if (row.type === 'unified') return row.favKey;
    if (row.type === 'favorite') return row.key;
    if (row.type === 'game') return gameRowKey(row);
    const src = EMULATOR_SOURCE_BY_TYPE[row.type];
    return src ? `${src.keyPrefix}-${row[src.idField]}` : null;
}

// Is a `gamesPanelVisibleRows` row rendered as a grid cell (not a list row) — `nGames` of `handleGamesPanelInput()` uses it to decide the
// column/row navigation of `gridNavIndex()`. Reads the `row.grid` field set at render time by `filteredGamesRows()`: 'game'/'favorite'/an
// `EMULATOR_SOURCES` row is a grid by default (`row.grid !== false`), 'unified' (ALL) a list by default (`row.grid === true`), everything
// else (retro-system summary, recent bar) is never a grid.

function isGridRow(row) {
    if (row.type === 'unified') return row.grid === true;
    if (row.type === 'game' || row.type === 'favorite') return row.grid !== false;
    if (EMULATOR_SOURCE_BY_TYPE[row.type]) return row.grid !== false;
    return false;
}


function gamesGridHtml(gameRows, offset = 0, virt = null) {
    const pinned = favoriteKeySet();
    const cells = gameRows.map((row, i) => {
        const focused = offset + i === gamesPanelFocusIndex ? ' focused' : '';
        const srcLabel = gridCellLabel(row);
        const key = gridCellKey(row);
        const isPinned = row.type === 'favorite' || (!!key && pinned.has(key));
        const hiddenCls = hiddenMark(key) ? ' game-cell-hidden' : '';
        const isNew = !!key && gamesNewKeys.has(key);
        const inner = row.cover
            ? `<img src="${fileUrl(row.cover)}" alt="" loading="lazy" decoding="async">`
            : `<div class="game-cell-noart">${esc(row.name)}</div>`;
        return `<div class="game-cell${focused}${hiddenCls}" data-name="${esc(row.name)}" role="button" aria-label="${esc(`${row.name} (${srcLabel})`)}">`
            + inner
            + (isPinned ? '<span class="game-cell-pin">★</span>' : '')
            + (isNew ? `<span class="game-cell-new">${esc(tr('games.newBadge'))}</span>` : '')
            + `<span class="game-cell-source">${esc(srcLabel)}</span>`
            + `<span class="game-cell-title">${esc(row.name)}</span>`
            + `</div>`;
    });
    return `<div class="games-grid"${virtAttrs(virt)}>${cells.join('')}</div>`;
}

// The list-mode counterpart of `gamesGridHtml()` — for the 'game' (Steam/GOG/Epic/Amazon/Lutris, in a single-source view) AND 'favorite'
// (★ FAVORITE filter) rows, if `gamesViewMode` sets 'list' for that source. Without a cover, star+name — uses the SAME favorite recognition as
// the grid branch through `gridCellKey()`, so the "★" marker is consistent between the two views.

function gameRowsListHtml(rows, offset) {
    const pinned = favoriteKeySet();
    const items = rows.map((row, j) => {
        const focused = offset + j === gamesPanelFocusIndex ? ' focused' : '';
        const key = gridCellKey(row);
        const isPinned = row.type === 'favorite' || (!!key && pinned.has(key));
        return `<div class="settings-item${focused}">${hiddenMark(key)}${isPinned ? '★ ' : ''}${esc(newMark(key))}${esc(row.name)}</div>`;
    });
    return `<div class="settings-list games-retro-list">${items.join('')}</div>`;
}


function retroSystemsHtml(retroRows, offset) {
    const rows = retroRows.map((row, j) => {
        const focused = offset + j === gamesPanelFocusIndex ? ' focused' : '';
        return `<div class="settings-item${focused}"><span class="bt-name">${esc(row.system)}</span> ${currentTag(`${row.count} ROM`, { paren: true })}</div>`;
    });
    return `<div class="settings-subhead">${esc(tr('games.retroSubhead'))}</div>`
        + `<div class="settings-list games-retro-list">${rows.join('')}</div>`;
}

// Shared row renderer for the emulator launchers listed ONE BY ONE in the root view, WITHOUT a drill-down (ONLY RetroArch gets an intermediate
// "N games" drill-down: `renderGamesPanelSystemList`). `keyPrefix`/`idField`/`subheadKey` come from `EMULATOR_SOURCES` (RPCS3's favorite key
// is `row.titleId`, the others' `row.id`); the renderer of one source's OWN chip view, called through `emulatorSourceHtml(id, rows, offset)`.

function emulatorGamesHtml(rows, offset, keyPrefix, idField, subheadKey) {
    const pinned = favoriteKeySet();
    const items = rows.map((row, j) => {
        const focused = offset + j === gamesPanelFocusIndex ? ' focused' : '';
        const key = `${keyPrefix}-${row[idField]}`;
        const star = pinned.has(key) ? '★ ' : '';
        return `<div class="settings-item${focused}">${hiddenMark(key)}${star}${esc(newMark(key))}${esc(row.name)}</div>`;
    });
    return `<div class="settings-subhead">${esc(tr(subheadKey))}</div>`
        + `<div class="settings-list games-retro-list">${items.join('')}</div>`;
}


function emulatorSourceHtml(id, rows, offset) {
    const src = EMULATOR_SOURCE_BY_ID[id];
    return emulatorGamesHtml(rows, offset, src.keyPrefix, src.idField, src.subheadKey);
}

// Decides by the `row.grid` set in `filteredGamesRows()` (`gamesViewMode` config key): cover grid (`gamesGridHtml()`) or text list
// (`emulatorSourceHtml()`). `rows` is never empty when called here (`renderGamesPanel()` guards with `.length`). This is the ONLY place where
// `renderGamesPanel()` renders the individual emulator sections.

function emulatorRowsHtml(id, rows, offset) {
    return rows[0].grid ? gamesGridHtml(rows, offset) : emulatorSourceHtml(id, rows, offset);
}

// The lazy, windowed download of the missing covers of the Ryujinx/PCSX2/Dolphin/DuckStation cover grid is done by
// `scheduleNetworkCoverFetch()`/`fetchVisibleNetworkCovers()` (above), called from the tail of `renderGamesPanel()`


// ONLY the renderer of the RetroArch system ROM list (drill-down) — cover grid OR text list per `gamesViewMode.retro`. In grid mode there is
// no source badge; a missing cover gets `.game-cell-noart` (the `cover` comes from local discovery or the patch of a
// `scheduleRetroCoverFetch()` batch). List mode has no cover, so scheduling the download is skipped too.

function renderGamesPanelSystemList() {
    if (!gamesPanelSystemGames.length) {
        $('gamesPanelContent').innerHTML =
            emptyState(tr('games.emptyList'), `${btnGlyph('back')} ${tr('hint.back').toUpperCase()}`);
        return;
    }
    const pinned = favoriteKeySet();
    // With an active search the filtered view (`systemGamesView`) — the focus index moves on it too.
    const view = systemGamesView();
    const bar = gamesSearchBarHtml(view.length);
    if (!view.length) {
        $('gamesPanelContent').innerHTML =
            bar + emptyState(tr('games.searchEmpty', { q: gamesPanelQuery.trim() }));
        return;
    }
    if (gamesPanelFocusIndex > view.length - 1) gamesPanelFocusIndex = view.length - 1;
    if (effectiveViewMode(gamesViewModeMap, 'retro') === 'list') {
        const items = view.map((g, i) => {
            const focused = i === gamesPanelFocusIndex ? ' focused' : '';
            const key = `retroarch:${gamesPanelSystem}:${g.label}`;
            const star = pinned.has(key) ? '★ ' : '';
            return `<div class="settings-item${focused}">${hiddenMark(key)}${star}${esc(g.label)}</div>`;
        });
        $('gamesPanelContent').innerHTML = `${bar}<div class="settings-list games-retro-list">${items.join('')}</div>`;
        afterGamesPanelRender();
        return;
    }
    const cells = view.map((g, i) => {
        const focused = i === gamesPanelFocusIndex ? ' focused' : '';
        const isPinned = pinned.has(`retroarch:${gamesPanelSystem}:${g.label}`);
        const hiddenCls = hiddenMark(`retroarch:${gamesPanelSystem}:${g.label}`) ? ' game-cell-hidden' : '';
        const inner = g.cover
            ? `<img src="${fileUrl(g.cover)}" alt="" loading="lazy" decoding="async">`
            : `<div class="game-cell-noart">${esc(g.label)}</div>`;
        return `<div class="game-cell${focused}${hiddenCls}" data-name="${esc(g.label)}">`
            + inner
            + (isPinned ? '<span class="game-cell-pin">★</span>' : '')
            + `<span class="game-cell-title">${esc(g.label)}</span>`
            + `</div>`;
    });
    $('gamesPanelContent').innerHTML = `${bar}<div class="games-grid">${cells.join('')}</div>`;
    afterGamesPanelRender();
    scheduleRetroCoverFetch();
}


// After rendering: measure the cover grid's column count (decided by CSS auto-fill) + scroll the focused item into view.

function afterGamesPanelRender() {
    requestAnimationFrame(() => {
        const grid = /** @type {HTMLElement|null} */ (document.querySelector('#gamesPanelContent .games-grid'));
        if (grid) {
            // Broken / missing cover -> title placeholder (like the carousel's FALLBACK_ICON).
            /** @type {NodeListOf<HTMLImageElement>} */ (grid.querySelectorAll('.game-cell > img')).forEach((img) => {
                const swap = () => {
                    const div = document.createElement('div');
                    div.className = 'game-cell-noart';
                    div.textContent = /** @type {HTMLElement|null} */ (img.closest('.game-cell'))?.dataset.name || '';
                    img.replaceWith(div);
                };
                img.addEventListener('error', swap, { once: true });
                if (img.complete && img.naturalWidth === 0) swap(); // already failed before the listener
            });
            const cells = /** @type {NodeListOf<HTMLElement>} */ (grid.querySelectorAll('.game-cell'));
            if (cells.length) {
                const top0 = cells[0].offsetTop;
                let cols = 0;
                for (const cell of cells) {
                    if (cell.offsetTop !== top0) break;
                    cols++;
                }
                gamesPanelGridCols = Math.max(1, cols);
                // Windowed grid (see `unifiedSectionHtml`): measure the row height, (re)compute the padding of the skipped rows with the measured value.
                if (grid.dataset.virt) {
                    const c = gamesPanelGridCols;
                    if (cells.length > c) {
                        const pitch = cells[c].offsetTop - cells[0].offsetTop;
                        if (pitch > 0) gamesVirtPitchGrid = pitch;
                    }
                    applyVirtPadding(grid, c, gamesVirtPitchGrid);
                }
            }
        }
        const virtList = /** @type {HTMLElement|null} */ (document.querySelector('#gamesPanelContent .games-all-list[data-virt]'));
        if (virtList) {
            const items = /** @type {NodeListOf<HTMLElement>} */ (virtList.querySelectorAll('.settings-item'));
            if (items.length > 1) {
                const pitch = items[1].offsetTop - items[0].offsetTop;
                if (pitch > 0) gamesVirtPitchList = pitch;
            }
            applyVirtPadding(virtList, 1, gamesVirtPitchList);
        }
        wireCoverFallback(
            document, '#gamesPanelContent .games-recent-row .recent-game > img',
            (img) => img.closest('.recent-game')?.dataset.name || '', true,
        );
        const el = document.querySelector('#gamesPanelContent .focused');
        if (el) el.scrollIntoView({ block: 'nearest' });
    });
}


if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        firstLetterOf, nextLetterIndex, gridNavIndex, nextInCycle, recentItemSourceId, sourceIncluded,
        gridCellLabel, gridCellKey, isGridRow, effectiveViewMode, romAccessWarningHtml,
    });
}
