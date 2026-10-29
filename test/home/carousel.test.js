'use strict';

// The pure math part of the carousel: `ringOffset` (signed ring offset, shortest way) and
// `carouselPosName` (offset -> position key). renderer/home/carousel.js is a classic <script> in
// the browser, but there is a module.exports guard at the bottom of the file (like controller-id.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { ringOffset, carouselPosName, favoriteLauncherId, mostRecentLauncherIndex, cardAccent } = require('../../renderer/home/carousel.js');

test('ringOffset — the offset of the focused card is 0', () => {
    assert.equal(ringOffset(2, 2, 5), 0);
});

test('ringOffset — neighbors ±1', () => {
    assert.equal(ringOffset(3, 2, 5), 1);
    assert.equal(ringOffset(1, 2, 5), -1);
});

test('ringOffset — wraps around the short way (signed)', () => {
    // 5 items, focus on 0: item 4 is "to the left" (-1), not +4
    assert.equal(ringOffset(4, 0, 5), -1);
    // focus on 4: item 0 is "to the right" (+1), not -4
    assert.equal(ringOffset(0, 4, 5), 1);
});

test('ringOffset — even n, exactly the opposite element', () => {
    // n=4, d=2 > n/2=2 is false (strict >), so it stays 2
    assert.equal(ringOffset(2, 0, 4), 2);
    // n=6, d=3 == n/2, stays 3
    assert.equal(ringOffset(3, 0, 6), 3);
});

test('carouselPosName — the middle 3 zones', () => {
    assert.equal(carouselPosName(0), 'center');
    assert.equal(carouselPosName(-1), 'left');
    assert.equal(carouselPosName(1), 'right');
});

test('carouselPosName — outside the zone far-*', () => {
    assert.equal(carouselPosName(-2), 'far-left');
    assert.equal(carouselPosName(3), 'far-right');
});

test('favoriteLauncherId — the most launched (count >= 2) card is the favorite', () => {
    const entries = [
        { id: 'steam', usage: { count: 5, lastLaunchedAt: '2026-01-01' } },
        { id: 'heroic', usage: { count: 2, lastLaunchedAt: '2026-01-02' } },
        { id: 'retroarch', usage: null },
    ];
    assert.equal(favoriteLauncherId(entries), 'steam');
});

test('favoriteLauncherId — a single launch (count 1) is not enough for the favorite badge', () => {
    const entries = [
        { id: 'steam', usage: { count: 1, lastLaunchedAt: '2026-01-01' } },
        { id: 'heroic', usage: null },
    ];
    assert.equal(favoriteLauncherId(entries), null);
});

test('favoriteLauncherId — on a tie there is no unambiguous favorite', () => {
    const entries = [
        { id: 'steam', usage: { count: 3, lastLaunchedAt: '2026-01-01' } },
        { id: 'heroic', usage: { count: 3, lastLaunchedAt: '2026-01-02' } },
    ];
    assert.equal(favoriteLauncherId(entries), null);
});

test('favoriteLauncherId — with a list without usage there is no favorite', () => {
    const entries = [
        { id: 'steam', usage: null },
        { id: 'heroic', usage: null },
    ];
    assert.equal(favoriteLauncherId(entries), null);
});

test('mostRecentLauncherIndex — no usage anywhere → 0', () => {
    const entries = [
        { id: 'steam', usage: null },
        { id: 'heroic' },
        { id: 'retroarch', usage: { count: 3 } },
    ];
    assert.equal(mostRecentLauncherIndex(entries), 0);
});

test('mostRecentLauncherIndex — the index of the element with the most recent lastLaunchedAt', () => {
    const entries = [
        { id: 'steam', usage: { lastLaunchedAt: '2026-09-01T10:00:00.000Z' } },
        { id: 'heroic', usage: { lastLaunchedAt: '2026-09-07T18:30:00.000Z' } },
        { id: 'retroarch', usage: { lastLaunchedAt: '2026-09-05T12:00:00.000Z' } },
    ];
    assert.equal(mostRecentLauncherIndex(entries), 1);
});

test('mostRecentLauncherIndex — on a tie the one earlier in the list wins', () => {
    const entries = [
        { id: 'steam', usage: { lastLaunchedAt: '2026-09-07T18:30:00.000Z' } },
        { id: 'heroic', usage: { lastLaunchedAt: '2026-09-07T18:30:00.000Z' } },
    ];
    assert.equal(mostRecentLauncherIndex(entries), 0);
});

test('cardAccent — a valid #rrggbb is returned, everything else null', () => {
    assert.equal(cardAccent({ accent: '#1a9fff' }), '#1a9fff');
    assert.equal(cardAccent({ accent: '#ABC123' }), '#ABC123');
    assert.equal(cardAccent({ accent: '#fff' }), null);
    assert.equal(cardAccent({ accent: 'blue' }), null);
    assert.equal(cardAccent({ accent: 'red; } .x{color:red' }), null); // against style-attr injection
    assert.equal(cardAccent({}), null);
    assert.equal(cardAccent(null), null);
});

test('mostRecentLauncherIndex — a bad/missing timestamp does not throw it off', () => {
    const entries = [
        { id: 'steam', usage: { lastLaunchedAt: 'not-a-date' } },
        { id: 'heroic', usage: { lastLaunchedAt: '2026-09-07T18:30:00.000Z' } },
        { id: 'retroarch', usage: {} },
    ];
    assert.equal(mostRecentLauncherIndex(entries), 1);
});
