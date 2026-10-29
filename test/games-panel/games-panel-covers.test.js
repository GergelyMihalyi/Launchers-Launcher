'use strict';

// renderer/games-panel/games-panel-covers.js — the batch selectors of the lazy cover download
// windowed around the focus.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    retroCoverBatchLabels, visibleMissingCoverIds,
} = require('../../renderer/games-panel/games-panel-covers.js');

// Lazy cover download of the RetroArch system ROM grid.
function makeGames(labels, covers = {}) {
    return labels.map((label) => ({ label, path: `/roms/${label}`, cover: covers[label] || null }));
}

test('retroCoverBatchLabels — in the window around the focus, gives only the labels WITHOUT a cover', () => {
    // focus=2, window=1 -> range [B,C,D]; B already has a cover -> skipped.
    const games = makeGames(['A', 'B', 'C', 'D', 'E'], { B: '/cover/b.png' });
    assert.deepEqual(retroCoverBatchLabels(games, 2, 1), ['C', 'D']);
});

test('retroCoverBatchLabels — the window clamps to the array bounds at the start/end of the list', () => {
    const games = makeGames(['A', 'B', 'C']);
    assert.deepEqual(retroCoverBatchLabels(games, 0, 1), ['A', 'B']);
    assert.deepEqual(retroCoverBatchLabels(games, 2, 1), ['B', 'C']);
    assert.deepEqual(retroCoverBatchLabels(games, 1, 10), ['A', 'B', 'C']); // large window -> full list
});

test('retroCoverBatchLabels — skips an entry that already has a cover, an empty array for an empty/missing list', () => {
    const games = makeGames(['A', 'B', 'C'], { A: '/a.png', B: '/b.png', C: '/c.png' });
    assert.deepEqual(retroCoverBatchLabels(games, 1, 5), []);
    assert.deepEqual(retroCoverBatchLabels([], 0, 5), []);
    assert.deepEqual(retroCoverBatchLabels(undefined, 0, 5), []);
});

test('retroCoverBatchLabels — dedups the same label (could in theory occur within one system)', () => {
    const games = makeGames(['Dup', 'Dup', 'Other']);
    assert.deepEqual(retroCoverBatchLabels(games, 1, 5), ['Dup', 'Other']);
});

// --- visibleMissingCoverIds — the generalization of retroCoverBatchLabels() to `id` (for the lazy
// cover download of the Ryujinx/PCSX2/Dolphin/DuckStation root grid) ---

function makeRows(ids, covers = {}) {
    return ids.map((id) => ({ id, path: `/roms/${id}`, cover: covers[id] || null }));
}

test('visibleMissingCoverIds — in the window around the focus, gives only the ids WITHOUT a cover', () => {
    const rows = makeRows(['a', 'b', 'c', 'd', 'e'], { b: '/cover/b.png' });
    assert.deepEqual(visibleMissingCoverIds(rows, 2, 1), ['c', 'd']);
});

test('visibleMissingCoverIds — the window clamps to the array bounds at the start/end of the list', () => {
    const rows = makeRows(['a', 'b', 'c']);
    assert.deepEqual(visibleMissingCoverIds(rows, 0, 1), ['a', 'b']);
    assert.deepEqual(visibleMissingCoverIds(rows, 2, 1), ['b', 'c']);
    assert.deepEqual(visibleMissingCoverIds(rows, 1, 10), ['a', 'b', 'c']); // large window -> full list
});

test('visibleMissingCoverIds — skips an entry that already has a cover, an empty array for an empty/missing list', () => {
    const rows = makeRows(['a', 'b', 'c'], { a: '/a.png', b: '/b.png', c: '/c.png' });
    assert.deepEqual(visibleMissingCoverIds(rows, 1, 5), []);
    assert.deepEqual(visibleMissingCoverIds([], 0, 5), []);
    assert.deepEqual(visibleMissingCoverIds(undefined, 0, 5), []);
});

test('visibleMissingCoverIds — dedups the same id', () => {
    const rows = makeRows(['dup', 'dup', 'other']);
    assert.deepEqual(visibleMissingCoverIds(rows, 1, 5), ['dup', 'other']);
});
