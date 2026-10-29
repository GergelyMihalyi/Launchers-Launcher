'use strict';

// renderer/games-panel/games-panel-render.js — pure helpers of the grid/list navigation, the ALL-list
// merge and the virtualized rendering.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EMULATOR_SOURCES, gameListRowFromApi } = require('../../renderer/games-panel/games-panel-sources.js');
const {
    firstLetterOf, nextLetterIndex, gridNavIndex, nextInCycle, recentItemSourceId, sourceIncluded,
    gridCellLabel, gridCellKey, isGridRow, effectiveViewMode, romAccessWarningHtml,
} = require('../../renderer/games-panel/games-panel-render.js');

test('firstLetterOf — trim + uppercase, empty/null -> ""', () => {
    assert.equal(firstLetterOf('  zelda'), 'Z');
    assert.equal(firstLetterOf('Adventure'), 'A');
    assert.equal(firstLetterOf(''), '');
    assert.equal(firstLetterOf(null), '');
});

const LABELS = [
    'Adventure Island',      // 0  A
    'Astro Boy',             // 1  A
    'Battletoads',           // 2  B
    'Bomberman',             // 3  B
    'Bubble Bobble',         // 4  B
    'Castlevania',           // 5  C
    'Zelda II',              // 6  Z
];

test('nextLetterIndex — forward to the start of the next first-letter group', () => {
    assert.equal(nextLetterIndex(LABELS, 0, 1), 2); // A -> B (first B)
    assert.equal(nextLetterIndex(LABELS, 2, 1), 5); // B -> C
    assert.equal(nextLetterIndex(LABELS, 5, 1), 6); // C -> Z
    assert.equal(nextLetterIndex(LABELS, 6, 1), 6); // Z -> nowhere further, stays on the last
});

test('nextLetterIndex — backward: first to the start of the current group, then to the start of the previous group', () => {
    assert.equal(nextLetterIndex(LABELS, 4, -1), 2); // from the middle of group B -> start of B
    assert.equal(nextLetterIndex(LABELS, 2, -1), 0); // from the start of B -> start of A
    assert.equal(nextLetterIndex(LABELS, 1, -1), 0); // from the middle of group A -> start of A
    assert.equal(nextLetterIndex(LABELS, 0, -1), 0); // from the start of A -> no previous, stays
});

test('nextLetterIndex — empty list / edge case', () => {
    assert.equal(nextLetterIndex([], 0, 1), 0);
    assert.equal(nextLetterIndex(['X'], 0, 1), 0);
    assert.equal(nextLetterIndex(['X'], 5, -1), 0); // out-of-range index klampolva
});

test('gridNavIndex — within the grid: ◀▶ = ±1 (does not cross a row boundary), ▲▼ = ±cols', () => {
    // 7 game cells, 3 columns, no retro row (total = 7)
    const cols = 3, nGames = 7, total = 7;
    assert.equal(gridNavIndex(0, 'right', cols, nGames, total), 1);
    assert.equal(gridNavIndex(2, 'right', cols, nGames, total), 2); // end of row -> stays
    assert.equal(gridNavIndex(3, 'left', cols, nGames, total), 3);  // start of row -> stays
    assert.equal(gridNavIndex(1, 'down', cols, nGames, total), 4);  // +cols
    assert.equal(gridNavIndex(4, 'up', cols, nGames, total), 1);    // -cols
    assert.equal(gridNavIndex(0, 'up', cols, nGames, total), 0);    // first row -> stays
    assert.equal(gridNavIndex(6, 'right', cols, nGames, total), 6); // last cell -> stays
});

test('gridNavIndex — from the bottom edge of the grid down to the first retro row, from there up back into the grid', () => {
    // 5 game cells (2 columns) + 2 retro rows -> total = 7, retro rows: 5, 6
    const cols = 2, nGames = 5, total = 7;
    assert.equal(gridNavIndex(4, 'down', cols, nGames, total), 5); // last grid row -> first retro row
    assert.equal(gridNavIndex(3, 'down', cols, nGames, total), 5); // +cols overshoots -> first retro row
    assert.equal(gridNavIndex(5, 'up', cols, nGames, total), 4);   // first retro row -> last grid cell
    assert.equal(gridNavIndex(5, 'down', cols, nGames, total), 6); // retro list: ±1
    assert.equal(gridNavIndex(6, 'down', cols, nGames, total), 6); // end of list -> stays
    assert.equal(gridNavIndex(6, 'left', cols, nGames, total), 6); // no ◀▶ in a retro row
});

test('gridNavIndex — headRows (the "recently played" summary bar)', () => {
    // 1 head row + 4 game cells (2 columns) + 2 retro rows -> total = 7 (index 0 = head)
    const cols = 2, nGames = 4, total = 7, headRows = 1;
    assert.equal(gridNavIndex(0, 'down', cols, nGames, total, headRows), 1); // head -> first cell of the grid
    assert.equal(gridNavIndex(0, 'left', cols, nGames, total, headRows), 0); // the head row's ◀▶ belongs to the caller, a no-op here
    assert.equal(gridNavIndex(1, 'up', cols, nGames, total, headRows), 0);   // top of the grid -> head
    assert.equal(gridNavIndex(1, 'right', cols, nGames, total, headRows), 2);
    assert.equal(gridNavIndex(4, 'down', cols, nGames, total, headRows), 5); // last grid row -> first retro row
    assert.equal(gridNavIndex(5, 'up', cols, nGames, total, headRows), 4);   // first retro row -> last grid cell
    assert.equal(gridNavIndex(6, 'down', cols, nGames, total, headRows), 6); // end of list -> stays

    // Header + retro list, EMPTY grid (nGames = 0) -> the list comes right under the head
    const total2 = 3, nGames2 = 0;
    assert.equal(gridNavIndex(0, 'down', cols, nGames2, total2, headRows), 1); // head -> first retro row
    assert.equal(gridNavIndex(1, 'up', cols, nGames2, total2, headRows), 0);   // first retro row -> head
});

test('nextInCycle — wrap-around stepping, unknown current -> start of the list', () => {
    const list = ['all', 'steam', 'gog', 'retro'];
    assert.equal(nextInCycle(list, 'all', 1), 'steam');
    assert.equal(nextInCycle(list, 'retro', 1), 'all');   // wraps around
    assert.equal(nextInCycle(list, 'all', -1), 'retro');   // wraps back around
    assert.equal(nextInCycle(list, 'no-such', 1), 'steam'); // i=0 -> +1
    assert.equal(nextInCycle([], 'all', 1), 'all');        // empty list -> unchanged
});

// The grid/list toggle of the "Games" panel (gamesViewMode config key, Settings →
// Launchers → "Game view").

test('effectiveViewMode — for a missing/invalid entry list for "all", grid for every other source (the default before the switch)', () => {
    assert.equal(effectiveViewMode({}, 'all'), 'list');
    assert.equal(effectiveViewMode({}, 'ryujinx'), 'grid');
    assert.equal(effectiveViewMode({}, 'retro'), 'grid');
    assert.equal(effectiveViewMode(undefined, 'all'), 'list');
    assert.equal(effectiveViewMode({ all: 'oops' }, 'all'), 'list'); // invalid value -> default
});

test('effectiveViewMode — the explicit value of the stored map overrides the default, in both directions', () => {
    assert.equal(effectiveViewMode({ all: 'grid' }, 'all'), 'grid');
    assert.equal(effectiveViewMode({ ryujinx: 'list' }, 'ryujinx'), 'list');
    assert.equal(effectiveViewMode({ ryujinx: 'list' }, 'pcsx2'), 'grid'); // other source untouched
});

// The source filter popup of the "Games" panel (□ Square).

test('recentItemSourceId — heroic from params.runner (kind is always just "heroic"), retroarch -> "retro", everything else 1:1 with the kind', () => {
    assert.equal(recentItemSourceId({ kind: 'heroic', params: { runner: 'gog' } }), 'gog');
    assert.equal(recentItemSourceId({ kind: 'heroic', params: { runner: 'legendary' } }), 'legendary');
    assert.equal(recentItemSourceId({ kind: 'heroic', params: {} }), null);
    assert.equal(recentItemSourceId({ kind: 'retroarch', params: { system: 'NES' } }), 'retro');
    assert.equal(recentItemSourceId({ kind: 'steam' }), 'steam');
    assert.equal(recentItemSourceId({ kind: 'lutris' }), 'lutris');
    assert.equal(recentItemSourceId({ kind: 'ryujinx' }), 'ryujinx');
    assert.equal(recentItemSourceId(null), null);
    assert.equal(recentItemSourceId({}), null);
});

test('sourceIncluded — "all" filters by the hidden set, a specific chip returns only its own source (regardless of the hidden set)', () => {
    const hidden = new Set(['steam', 'retro']);
    assert.equal(sourceIncluded('all', hidden, 'steam'), false);
    assert.equal(sourceIncluded('all', hidden, 'gog'), true);
    assert.equal(sourceIncluded('all', new Set(), 'steam'), true);
    // On a specific chip (L2/R2 cycle) the exclusion does NOT count — per the scope decision
    assert.equal(sourceIncluded('steam', hidden, 'steam'), true);
    assert.equal(sourceIncluded('gog', hidden, 'steam'), false);
});

// The Ryujinx + PCSX2 + PPSSPP + RPCS3 + melonDS + Cemu + Dolphin + DuckStation cover grid:
// all 8 EMULATOR_SOURCES emulators are grid cells by default
// (`isGridRow()`, the default behavior without the `gamesViewMode` toggle),
// the badge/favorite-key detection of `gamesGridHtml()` (`gridCellLabel`/`gridCellKey`)
// and the cell computation of the grid navigation (`isGridRow`).

test('gridCellLabel — for game/favorite/emulator(grid) rows gives the source badge', () => {
    assert.equal(gridCellLabel({ type: 'game', source: 'steam' }), 'STEAM');
    assert.equal(gridCellLabel({ type: 'game', source: 'unknown' }), 'UNKNOWN');
    assert.equal(gridCellLabel({ type: 'favorite', sourceLabel: 'GOG' }), 'GOG');
    assert.equal(gridCellLabel({ type: 'ryujinx-game', id: 'a' }), 'RYUJINX');
    assert.equal(gridCellLabel({ type: 'pcsx2-game', id: 'a' }), 'PCSX2');
    assert.equal(gridCellLabel({ type: 'ppsspp-game', id: 'a' }), 'PPSSPP');
    assert.equal(gridCellLabel({ type: 'rpcs3-game', titleId: 'a' }), 'RPCS3');
    assert.equal(gridCellLabel({ type: 'melonds-game', id: 'a' }), 'MELONDS');
    assert.equal(gridCellLabel({ type: 'cemu-game', id: 'a' }), 'CEMU');
    assert.equal(gridCellLabel({ type: 'dolphin-game', id: 'a' }), 'DOLPHIN');
    assert.equal(gridCellLabel({ type: 'duckstation-game', id: 'a' }), 'DUCKSTATION');
    assert.equal(gridCellLabel({ type: 'retro-system', system: 'NES' }), ''); // not a grid row
    assert.equal(gridCellLabel({ type: 'unified', sourceLabel: 'RPCS3' }), 'RPCS3'); // ALL view in grid mode
});

test('gridCellKey — returns the same key format as toggleFavoriteFocused()', () => {
    assert.equal(gridCellKey({ type: 'game', source: 'steam', appid: '620' }), 'steam-game-620');
    assert.equal(gridCellKey({ type: 'favorite', key: 'lutris-game-7' }), 'lutris-game-7');
    assert.equal(gridCellKey({ type: 'ryujinx-game', id: 'abc' }), 'ryujinx-game-abc');
    assert.equal(gridCellKey({ type: 'pcsx2-game', id: 'x1' }), 'pcsx2-game-x1');
    assert.equal(gridCellKey({ type: 'ppsspp-game', id: 'xyz' }), 'ppsspp-game-xyz');
    assert.equal(gridCellKey({ type: 'rpcs3-game', titleId: 'BLUS12345' }), 'rpcs3-game-BLUS12345');
    assert.equal(gridCellKey({ type: 'melonds-game', id: 'nds1' }), 'melonds-game-nds1');
    assert.equal(gridCellKey({ type: 'cemu-game', id: 'c1' }), 'cemu-game-c1');
    assert.equal(gridCellKey({ type: 'dolphin-game', id: 'do1' }), 'dolphin-game-do1');
    assert.equal(gridCellKey({ type: 'duckstation-game', id: 'd1' }), 'duckstation-game-d1');
    assert.equal(gridCellKey({ type: 'retro-system', system: 'NES' }), null);
    assert.equal(gridCellKey({ type: 'unified', favKey: 'rpcs3-game-BLUS12345' }), 'rpcs3-game-BLUS12345');
});

test('isGridRow — game/favorite/emulator rows are grid cells by default (no .grid field), everything else (unified/retro-system/recent) is a list row', () => {
    assert.equal(isGridRow({ type: 'game' }), true);
    assert.equal(isGridRow({ type: 'favorite' }), true);
    assert.equal(isGridRow({ type: 'ryujinx-game' }), true);
    assert.equal(isGridRow({ type: 'pcsx2-game' }), true);
    assert.equal(isGridRow({ type: 'ppsspp-game' }), true);
    assert.equal(isGridRow({ type: 'rpcs3-game' }), true);
    assert.equal(isGridRow({ type: 'melonds-game' }), true);
    assert.equal(isGridRow({ type: 'cemu-game' }), true);
    assert.equal(isGridRow({ type: 'dolphin-game' }), true);
    assert.equal(isGridRow({ type: 'duckstation-game' }), true);
    assert.equal(isGridRow({ type: 'unified' }), false);
    assert.equal(isGridRow({ type: 'retro-system' }), false);
    assert.equal(isGridRow({ type: 'recent' }), false);
});

// The gamesViewMode toggle: `filteredGamesRows()` puts an explicit `row.grid` boolean on the
// rows — `isGridRow()` reads it, the override in both directions (grid -> list AND unified list -> grid).
test('isGridRow — a row.grid set at render time explicitly overrides the default', () => {
    assert.equal(isGridRow({ type: 'game', grid: false }), false);
    assert.equal(isGridRow({ type: 'favorite', grid: false }), false);
    assert.equal(isGridRow({ type: 'ryujinx-game', grid: false }), false);
    assert.equal(isGridRow({ type: 'unified', grid: true }), true);
});

// Warning about flatpak emulator ROM folders the sandbox cannot see.
test('romAccessWarningHtml — everything in ALL, only its own on a chip, escaped; empty → ""', () => {
    const saved = { tr: globalThis.tr, esc: globalThis.esc };
    globalThis.tr = (key, p = {}) => `${key}${p.name ? `|${p.name}|${p.dir}` : ''}`;
    globalThis.esc = (s) => String(s).replace(/</g, '&lt;');
    try {
        const hidden = [
            { source: 'pcsx2', name: 'PCSX2', dir: '/mnt/<ps2>' },
            { source: 'dolphin', name: 'Dolphin', dir: '/mnt/wii' },
        ];
        const all = romAccessWarningHtml(hidden, 'all');
        assert.match(all, /games\.romAccessHidden\|PCSX2\|\/mnt\/&lt;ps2>/);
        assert.match(all, /Dolphin/);
        assert.match(all, /games\.romAccessHint/);
        const one = romAccessWarningHtml(hidden, 'dolphin');
        assert.doesNotMatch(one, /PCSX2/);
        assert.match(one, /Dolphin/);
        assert.equal(romAccessWarningHtml(hidden, 'steam'), '');
        assert.equal(romAccessWarningHtml([], 'all'), '');
        assert.equal(romAccessWarningHtml(null, 'all'), '');
    } finally {
        globalThis.tr = saved.tr;
        globalThis.esc = saved.esc;
    }
});
