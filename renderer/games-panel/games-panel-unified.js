// The Games panel's "ALL" view: ONE name-sorted, memoized list of every source (Steam/GOG/Epic/Amazon/Lutris + every EMULATOR_SOURCES
// emulator + the loaded RetroArch ROM set) + the windowed (virtualized) display (~16,000 rows). `renderGamesPanel()` calls
// `buildUnifiedRows()`/`unifiedSectionHtml()`, `afterGamesPanelRender()` calls `applyVirtPadding()`.
// The pure helpers behind a module.exports guard (test/games-panel/games-panel-unified.test.js).

// Node/test: `GAME_SOURCE_BY_ID`/`EMULATOR_SOURCE_BY_TYPE`/`gameRowKey` from games-panel-sources.js (a global <script> loaded EARLIER in the
// browser) — `toUnifiedRow` calls them.
if (typeof GAME_SOURCE_BY_ID === 'undefined' && typeof module !== 'undefined') {
    // eslint-disable-next-line no-undef
    Object.assign(globalThis, module.require('./games-panel-sources.js'));
}

// Memo of the merged, sorted ALL list (key: the references of the source arrays + the excluded source ids + the grid/list mode).
let gamesUnifiedCache = null;
// The actual height of a grid row / a list row in px (measured after rendering, for the padding of the skipped rows outside the window).
// 0 = not known yet.

let gamesVirtPitchGrid = 0;

let gamesVirtPitchList = 0;

// --- "ALL" + RetroArch: the full ROM set (~15,700 items) in the shared list ---
// The panel's "rerender everything on every nav step" model could not handle a list this big, so (1) the merged, sorted list is MEMOIZED
// (only rebuilt on a data/mode/filter change), (2) above `VIRT_THRESHOLD` only the WINDOW around the focus goes into the DOM, the place of
// the skipped rows is kept by a padding computed from `gamesVirtPitch*`.

// One shared, filter-free collator — the exact equivalent of `localeCompare(…, 'hu', {numeric, sensitivity:'base'})`, but it does not
// instantiate on every comparison (with 16,000 items that difference is seconds).

const NAME_COLLATOR = new Intl.Collator('hu', { numeric: true, sensitivity: 'base' });

const VIRT_THRESHOLD = 300;    // below this many rows the full list goes into the DOM

const VIRT_HALF_WINDOW = 120;  // this many items around the focus in BOTH directions

// "Nintendo - Super Nintendo Entertainment System" -> "Super Nintendo Entertainment System".

function retroSystemShort(system) {
    const s = String(system || '');
    const i = s.lastIndexOf(' - ');
    return i >= 0 ? s.slice(i + 3) : s;
}

// From the grouped response of `list-retroarch-all-games` (`[{system, games:[{label,path,cover}]}]`) a single, name-sorted `'unified'` row
// array (the shape of `toUnifiedRow()` + `retroSystem`/`sourceDetail`) — the launch/favorite key matches the `retroarch:<system>:<label>`
// format of the RetroArch drill-down, so pinning and launching work the same way.

function retroGroupsToUnifiedRows(groups) {
    const out = [];
    for (const grp of groups || []) {
        const detail = retroSystemShort(grp.system);
        for (const g of grp.games || []) {
            const label = String(g.label == null ? '' : g.label);
            out.push({
                type: 'unified', name: label, sourceLabel: 'RETRO', sourceDetail: detail, cover: g.cover || null,
                favKey: `retroarch:${grp.system}:${label}`,
                launch: { kind: 'retroarch', params: { system: grp.system, path: g.path } },
                retroSystem: grp.system, grid: false,
            });
        }
    }
    return out.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
}

// --- Sorting by mode (toggled with R3, per source in the `gamesSortMode` key) ---
// `name` (default) = the current alphabetical order. `recent` = last played, `playtime` = playtime, `added` = recently added (the launcher's
// "first seen" record): the measurable (> 0) games first, descending (ties in the original, alphabetical order), the rest after in the
// original order. The data comes from `get-games-sort-stats` (`{ <favorite-key>: { at, totalMs } }`); the RetroArch ROM set has no per-ROM
// data, it stays sorted by name.
const GAMES_SORT_ORDER = ['name', 'recent', 'playtime', 'added'];

function nextSortMode(mode) {
    const i = GAMES_SORT_ORDER.indexOf(mode);
    return GAMES_SORT_ORDER[(i + 1) % GAMES_SORT_ORDER.length];
}

function effectiveSortMode(map, id) {
    const v = map && map[id];
    return GAMES_SORT_ORDER.includes(v) ? v : 'name';
}

// Splits the rows into two groups: `played` (measurable by the mode, sorted) and `rest` (original order). In `name` mode every row stays in
// `rest`. `keyOf(row)` = the row's favorite key.
function partitionBySortMode(rows, mode, stats, keyOf) {
    if (mode !== 'recent' && mode !== 'playtime' && mode !== 'added') return { played: [], rest: rows };
    const val = (r) => {
        const s = stats && stats[keyOf(r)];
        return s ? Number(mode === 'recent' ? s.at : (mode === 'added' ? s.added : s.totalMs)) || 0 : 0;
    };
    const scored = [];
    const rest = [];
    rows.forEach((r, i) => {
        const v = val(r);
        if (v > 0) scored.push({ r, v, i }); else rest.push(r);
    });
    scored.sort((a, b) => b.v - a.v || a.i - b.i);
    return { played: scored.map((x) => x.r), rest };
}

// The favorite key of a row for the sort stats: the same shape as `favKey` of `toUnifiedRow()`.
function sortKeyOfRow(row) {
    if (row.type === 'unified') return row.favKey;
    if (row.type === 'game') return gameRowKey(row);
    const src = EMULATOR_SOURCE_BY_TYPE[row.type];
    return src ? `${src.keyPrefix}-${row[src.idField]}` : null;
}

// The rows of one source by the chosen mode (the `name` mode returns the input unchanged).
function sortGameRows(rows, mode, stats) {
    const { played, rest } = partitionBySortMode(rows, mode, stats, sortKeyOfRow);
    return played.length ? played.concat(rest) : rows;
}

// Linear merge of two arrays already sorted by name (on a tie `a` first).

function mergeSortedByName(a, b) {
    const out = new Array(a.length + b.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < a.length && j < b.length) out[k++] = NAME_COLLATOR.compare(b[j].name, a[i].name) < 0 ? b[j++] : a[i++];
    while (i < a.length) out[k++] = a[i++];
    while (j < b.length) out[k++] = b[j++];
    return out;
}

// The [start, end) range of the windowed display from `n` items, `half` items in both directions around `center`. For a grid (`cols > 1`)
// aligned to FULL rows (start to the row start, end to the row end), so the place of the skipped rows can be filled by a whole number of row
// heights.

function virtualWindow(n, center, half, cols) {
    cols = Math.max(1, cols);
    let start = Math.max(0, center - half);
    start -= start % cols;
    let end = Math.min(n, center + half + 1);
    end = Math.min(n, start + Math.ceil((end - start) / cols) * cols);
    return { start, end };
}

// Top/bottom padding (px) filling the place of the skipped rows — `pitch` = the height of one row including the gap (measured after
// rendering), 0 = not known yet (corrected after the measurement).

function virtualPadding(start, end, total, cols, pitch) {
    cols = Math.max(1, cols);
    return {
        top: Math.floor(start / cols) * pitch,
        bottom: Math.ceil((total - end) / cols) * pitch,
    };
}

// Brings a Steam/GOG/Epic/Amazon/Lutris `type:'game'` row OR an EMULATOR_SOURCES emulator row (ryujinx-game/pcsx2-game/…) into a uniform
// shape for the shared list of the "ALL" view — `favKey`/`launch` carry the existing GAME_SOURCES/EMULATOR_SOURCES `launch()` calls, so
// `selectRootRow()`/`toggleFavoriteFocused()` can handle it generically, regardless of the source.

function toUnifiedRow(row) {
    if (row.type === 'game') {
        const src = GAME_SOURCE_BY_ID[row.source];
        return {
            type: 'unified', name: row.name, sourceLabel: src?.label || String(row.source).toUpperCase(),
            cover: row.cover || null, favKey: gameRowKey(row), launch: src.launch(row),
        };
    }
    const src = EMULATOR_SOURCE_BY_TYPE[row.type];
    return {
        type: 'unified', name: row.name, sourceLabel: row.badge || src.label, cover: row.cover || null,
        favKey: `${src.keyPrefix}-${row[src.idField]}`, launch: src.launch(row),
    };
}

// The merged, name-sorted row list of "ALL" (Steam/GOG/Epic/Amazon/Lutris + every EMULATOR_SOURCES emulator + the loaded RetroArch ROM set).
// MEMOIZED: `filteredGamesRows()` runs on every nav step, a ~16,000 item sort/merge must not. The key is the references of the source arrays
// (every change of `gamesPanelRows` is a NEW array) + the excluded source ids + the grid/list mode. Sorting the small (non-RetroArch) part and
// merging it linearly with the already sorted RetroArch array is cheap.

function buildUnifiedRows(grid) {
    const hidden = [...gamesHiddenSources].sort().join(',');
    const c = gamesUnifiedCache;
    const sortMode = effectiveSortMode(gamesSortModeMap, 'all');
    if (c && c.rows === gamesPanelRows && c.retro === gamesPanelRetroUnified && c.hidden === hidden && c.grid === grid
        && c.sortMode === sortMode && c.sortStats === gamesSortStats
        && c.hiddenGames === gamesHiddenGames && c.showHidden === gamesShowHidden) {
        return c.unified;
    }
    const gameRows = gamesPanelRows.filter((r) => r.type === 'game' && includeSource(r.source));
    const emulatorRows = EMULATOR_SOURCES
        .filter((s) => includeSource(s.id))
        .flatMap((s) => gamesPanelRows.filter((r) => r.type === s.type));
    const small = [...gameRows, ...emulatorRows]
        .map((r) => ({ ...toUnifiedRow(r), grid }))
        .sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
    const retro = (includeSource('retro') && gamesPanelRetroUnified) ? gamesPanelRetroUnified : [];
    for (const r of retro) r.grid = grid; // persistent objects — the mode switch is written here
    // `recent`/`playtime`: the measurable games first (sorted), the rest (+ the RetroArch ROM set) by name.
    const { played, rest } = partitionBySortMode(small, sortMode, gamesSortStats, (r) => r.favKey);
    const tail = retro.length ? mergeSortedByName(rest, retro) : rest;
    const ordered = played.length ? played.concat(tail) : tail;
    const unified = (gamesHiddenGames.size && !gamesShowHidden) ? ordered.filter((r) => !isGameFiltered(r.favKey)) : ordered;
    gamesUnifiedCache = {
        rows: gamesPanelRows, retro: gamesPanelRetroUnified, hidden, grid, sortMode, sortStats: gamesSortStats,
        hiddenGames: gamesHiddenGames, showHidden: gamesShowHidden, unified,
    };
    return unified;
}

// `virt` (optional, windowed display — see `unifiedSectionHtml`) is `{start,end,total,top,bottom}`: the `data-virt` attribute is for
// `afterGamesPanelRender()` (row height measurement + padding correction), the inline padding fills the place of the skipped rows.

function virtAttrs(virt) {
    return virt
        ? ` data-virt="${virt.start},${virt.end},${virt.total}" style="padding-top:${virt.top}px;padding-bottom:${virt.bottom}px"`
        : '';
}

// The uniform, cover-less LIST branch of the ALL view (`gamesViewMode['all']` = 'list'; for 'grid' `renderGamesPanel()` calls
// `gamesGridHtml()`): every source in alphabetical order (Steam/GOG/Epic/Amazon/Lutris + EMULATOR_SOURCES + the loaded RetroArch ROM set);
// until the RetroArch set is loaded, the per-system summary (`retroSystemsHtml()`) stays below. The `emulatorGamesHtml()` pattern, with a
// per-row source badge (`row.sourceLabel`). `virt` = windowed display (`unifiedSectionHtml`); `games-all-list` is the selector of
// `applyVirtPadding()`.

function unifiedGamesListHtml(rows, offset, virt = null) {
    const pinned = favoriteKeySet();
    const items = rows.map((row, j) => {
        const focused = offset + j === gamesPanelFocusIndex ? ' focused' : '';
        const star = row.favKey && pinned.has(row.favKey) ? '★ ' : '';
        const tag = row.sourceDetail ? `${row.sourceLabel} · ${row.sourceDetail}` : row.sourceLabel;
        return `<div class="settings-item${focused}">${hiddenMark(row.favKey)}${star}${esc(newMark(row.favKey))}${esc(row.name)} ${currentTag(tag)}</div>`;
    });
    return `<div class="settings-subhead">${esc(tr('games.allSubhead'))}</div>`
        + `<div class="settings-list games-retro-list games-all-list"${virtAttrs(virt)}>${items.join('')}</div>`;
}

// The shared list/grid of "ALL". Below `VIRT_THRESHOLD` the full list goes into the DOM; above it only a window of radius
// `VIRT_HALF_WINDOW` around the focus — the place of the skipped rows is kept by `virtualPadding()` (the row height from the previous render's
// measurement, see `afterGamesPanelRender()`). `offset` = the flat index of the first unified row (`gamesPanelVisibleRows`); with the focus
// OUTSIDE the section (recent bar / retro list) the window is set to the start / the end.

function unifiedSectionHtml(unifiedRows, offset) {
    const grid = unifiedRows[0].grid;
    const n = unifiedRows.length;
    if (n <= VIRT_THRESHOLD) {
        return grid ? gamesGridHtml(unifiedRows, offset) : unifiedGamesListHtml(unifiedRows, offset);
    }
    const focusIn = gamesPanelFocusIndex - offset;
    const center = Math.max(0, Math.min(n - 1, focusIn));
    const cols = grid ? Math.max(1, gamesPanelGridCols) : 1;
    const { start, end } = virtualWindow(n, center, VIRT_HALF_WINDOW, cols);
    const pad = virtualPadding(start, end, n, cols, grid ? gamesVirtPitchGrid : gamesVirtPitchList);
    const virt = { start, end, total: n, top: pad.top, bottom: pad.bottom };
    const slice = unifiedRows.slice(start, end);
    return grid ? gamesGridHtml(slice, offset + start, virt) : unifiedGamesListHtml(slice, offset + start, virt);
}

// Sets the padding of the skipped rows of the windowed (`data-virt="start,end,total"`) grid/list with the MEASURED row height
// (`pitch` = row + gap).
function applyVirtPadding(el, cols, pitch) {
    const [start, end, total] = el.dataset.virt.split(',').map(Number);
    const pad = virtualPadding(start, end, total, cols, pitch);
    el.style.paddingTop = `${pad.top}px`;
    el.style.paddingBottom = `${pad.bottom}px`;
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        toUnifiedRow, nextSortMode, effectiveSortMode, partitionBySortMode, sortGameRows, sortKeyOfRow, GAMES_SORT_ORDER, retroSystemShort, retroGroupsToUnifiedRows, mergeSortedByName, virtualWindow, virtualPadding,
    });
}
