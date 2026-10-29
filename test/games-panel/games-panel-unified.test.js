'use strict';

// renderer/games-panel/games-panel-unified.js — pure helpers of the unified "ALL" view list and the
// virtualization.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EMULATOR_SOURCES, gameListRowFromApi } = require('../../renderer/games-panel/games-panel-sources.js');
const {
    toUnifiedRow, nextSortMode, effectiveSortMode, partitionBySortMode, sortGameRows, retroSystemShort, retroGroupsToUnifiedRows, mergeSortedByName, virtualWindow, virtualPadding,
} = require('../../renderer/games-panel/games-panel-unified.js');

// The unified, shared list of the "ALL" view.

test('toUnifiedRow — brings a Steam/Heroic/Lutris "game" row and an emulator row to a uniform {name,sourceLabel,favKey,launch} shape', () => {
    const steamRow = gameListRowFromApi({ name: 'Portal 2', source: 'steam', appid: '620', cover: '/c.jpg' });
    const u1 = toUnifiedRow(steamRow);
    assert.equal(u1.type, 'unified');
    assert.equal(u1.name, 'Portal 2');
    assert.equal(u1.sourceLabel, 'STEAM');
    assert.equal(u1.favKey, 'steam-game-620');
    assert.deepEqual(u1.launch, { kind: 'steam', params: { appid: '620' } });

    const ryujinxRow = { type: 'ryujinx-game', id: 'abc', name: 'Metroid Dread', path: '/x.xci', titleId: 'T1', cover: null };
    const u2 = toUnifiedRow(ryujinxRow);
    assert.equal(u2.sourceLabel, 'RYUJINX');
    assert.equal(u2.favKey, 'ryujinx-game-abc');
    assert.deepEqual(u2.launch, { kind: 'ryujinx', params: { path: '/x.xci', titleId: 'T1' } });

    // RPCS3 uses the `titleId` field as the favorite key, not `id`.
    const rpcs3Row = { type: 'rpcs3-game', name: 'Demon\'s Souls', titleId: 'BLES00932', cover: null };
    const u3 = toUnifiedRow(rpcs3Row);
    assert.equal(u3.favKey, 'rpcs3-game-BLES00932');
});

test('toUnifiedRow — normalizes missing identifier fields to `null` (as for the favorite entries so far)', () => {
    const row = { type: 'pcsx2-game', id: 'x1', name: 'Game', path: '/g.iso', serial: undefined, cover: null };
    assert.deepEqual(toUnifiedRow(row).launch, { kind: 'pcsx2', params: { path: '/g.iso', serial: null } });
});

test('ALL-list merge: every source can be turned into one common, alphabetically sortable list with toUnifiedRow', () => {
    const rows = [
        gameListRowFromApi({ name: 'Zelda-like', source: 'steam', appid: '1', cover: null }),
        { type: 'ryujinx-game', id: 'a', name: 'Alpha Game', path: '/a', titleId: null, cover: null },
        { type: 'cemu-game', id: 'b', name: 'Middle Game', path: '/b', titleId: null, cover: null },
    ];
    const sorted = rows.map(toUnifiedRow).sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    assert.deepEqual(sorted.map((r) => r.name), ['Alpha Game', 'Middle Game', 'Zelda-like']);
    assert.deepEqual(sorted.map((r) => r.sourceLabel), ['RYUJINX', 'CEMU', 'STEAM']);
});

// --- "ALL" + RetroArch: the full ROM set in the shared list ---

test('retroSystemShort — the last segment after " - ", otherwise the full name', () => {
    assert.equal(retroSystemShort('Nintendo - Super Nintendo Entertainment System'), 'Super Nintendo Entertainment System');
    assert.equal(retroSystemShort('Sega - Mega Drive - Genesis'), 'Genesis');
    assert.equal(retroSystemShort('DOS'), 'DOS');
    assert.equal(retroSystemShort(null), '');
});

test('retroGroupsToUnifiedRows — sorted unified rows from the grouped IPC response, with the key/launch shape of the drill-down', () => {
    const rows = retroGroupsToUnifiedRows([
        { system: 'Nintendo - NES', games: [{ label: 'Zelda', path: '/z.nes', cover: '/c/z.png' }, { label: 'Mario 10', path: '/m10.nes', cover: null }] },
        { system: 'DOS', games: [{ label: 'Mario 2', path: '/m2.exe' }] },
    ]);
    assert.deepEqual(rows.map((r) => r.name), ['Mario 2', 'Mario 10', 'Zelda']); // numeric, sorted
    const z = rows[2];
    assert.equal(z.type, 'unified');
    assert.equal(z.favKey, 'retroarch:Nintendo - NES:Zelda');
    assert.deepEqual(z.launch, { kind: 'retroarch', params: { system: 'Nintendo - NES', path: '/z.nes' } });
    assert.equal(z.cover, '/c/z.png');
    assert.equal(z.sourceLabel, 'RETRO');
    assert.equal(z.sourceDetail, 'NES');
    assert.equal(z.retroSystem, 'Nintendo - NES');
    assert.equal(rows[0].cover, null);
    assert.deepEqual(retroGroupsToUnifiedRows(null), []);
});

test('mergeSortedByName — linear merge of two sorted arrays, on a tie the first array goes first', () => {
    const a = [{ name: 'A' }, { name: 'C' }, { name: 'E1' }];
    const b = [{ name: 'B' }, { name: 'C', from: 'b' }, { name: 'F' }];
    assert.deepEqual(mergeSortedByName(a, b).map((r) => r.name + (r.from || '')), ['A', 'B', 'C', 'Cb', 'E1', 'F']);
    assert.deepEqual(mergeSortedByName([], b), b);
    assert.deepEqual(mergeSortedByName(a, []), a);
});

test('virtualWindow — a window around the focus, aligned to whole rows for a grid, clamped to the edges', () => {
    assert.deepEqual(virtualWindow(16000, 8000, 120, 1), { start: 7880, end: 8121 });
    const w = virtualWindow(16000, 8000, 120, 5);
    assert.equal(w.start % 5, 0);
    assert.equal((w.end - w.start) % 5, 0);
    assert.ok(w.start <= 8000 - 120 && w.end > 8000 + 120);
    assert.deepEqual(virtualWindow(16000, 0, 120, 5), { start: 0, end: 125 });
    const last = virtualWindow(16013, 16012, 120, 5);
    assert.equal(last.end, 16013); // the last, partial row is in too
    assert.equal(last.start % 5, 0);
    assert.deepEqual(virtualWindow(10, 3, 120, 4), { start: 0, end: 10 });
});

test('virtualPadding — the top/bottom padding replacing the space of the skipped rows (grid: whole rows)', () => {
    assert.deepEqual(virtualPadding(0, 125, 16000, 5, 220), { top: 0, bottom: Math.ceil((16000 - 125) / 5) * 220 });
    assert.deepEqual(virtualPadding(7880, 8125, 16000, 5, 220), { top: 1576 * 220, bottom: Math.ceil((16000 - 8125) / 5) * 220 });
    assert.deepEqual(virtualPadding(100, 200, 1000, 1, 43), { top: 4300, bottom: 34400 });
    assert.deepEqual(virtualPadding(50, 100, 1000, 5, 0), { top: 0, bottom: 0 }); // unknown row height
});

// --- Sorting ---

test('nextSortMode / effectiveSortMode — cycles; unknown or missing value = name', () => {
    assert.equal(nextSortMode('name'), 'recent');
    assert.equal(nextSortMode('recent'), 'playtime');
    assert.equal(nextSortMode('playtime'), 'added');
    assert.equal(nextSortMode('added'), 'name');
    assert.equal(effectiveSortMode({ all: 'playtime' }, 'all'), 'playtime');
    assert.equal(effectiveSortMode({ all: 'oops' }, 'all'), 'name');
    assert.equal(effectiveSortMode({}, 'steam'), 'name');
});

test('partitionBySortMode — the measurable rows first in descending order, original order on a tie; the rest stay', () => {
    const rows = ['a', 'b', 'c', 'd'].map((favKey) => ({ favKey }));
    const stats = { b: { at: 100, totalMs: 5 }, c: { at: 300, totalMs: 5 }, d: { at: 100, totalMs: 0 } };
    const r = partitionBySortMode(rows, 'recent', stats, (x) => x.favKey);
    assert.deepEqual(r.played.map((x) => x.favKey), ['c', 'b', 'd']);
    assert.deepEqual(r.rest.map((x) => x.favKey), ['a']);
    const p = partitionBySortMode(rows, 'playtime', stats, (x) => x.favKey);
    assert.deepEqual(p.played.map((x) => x.favKey), ['b', 'c']); // tie: original order
    assert.deepEqual(p.rest.map((x) => x.favKey), ['a', 'd']);
    assert.equal(partitionBySortMode(rows, 'name', stats, (x) => x.favKey).rest, rows);
});

test('sortGameRows — sorts Steam and emulator rows by the favorite key too; without data the input itself', () => {
    const steam = gameListRowFromApi({ name: 'A', source: 'steam', appid: '1' });
    const ryu = { type: 'ryujinx-game', id: 'x', name: 'B' };
    const rows = [steam, ryu];
    const out = sortGameRows(rows, 'playtime', { 'ryujinx-game-x': { at: 0, totalMs: 10 } });
    assert.deepEqual(out, [ryu, steam]);
    assert.equal(sortGameRows(rows, 'playtime', {}), rows);
});

test('partitionBySortMode — the "added" mode uses the "first seen" time; 0 (baseline) does not count', () => {
    const rows = ['a', 'b', 'c'].map((favKey) => ({ favKey }));
    const stats = { a: { added: 0 }, b: { added: 500 }, c: { added: 900 } };
    const r = partitionBySortMode(rows, 'added', stats, (x) => x.favKey);
    assert.deepEqual(r.played.map((x) => x.favKey), ['c', 'b']);
    assert.deepEqual(r.rest.map((x) => x.favKey), ['a']);
});
