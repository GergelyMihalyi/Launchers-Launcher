'use strict';

// renderer/settings/settings-search.js — the pure core of the Settings search.
const test = require('node:test');
const assert = require('node:assert/strict');
const { settingsSearchNormalize, settingsSearchMatches } = require('../../renderer/settings/settings-search.js');

const ITEMS = [
    { id: 'games-cache', label: 'Clear cache', desc: 'View and clear the size of the cover and scan caches.', group: 'Games' },
    { id: 'wifi', label: 'Wi-Fi', desc: 'List Wi-Fi networks and connect with a password.', group: 'Power and network' },
    { id: 'night-mode', label: 'Night mode', desc: 'A warm colour filter on the launcher UI for evening use.', group: 'Display & audio' },
    { id: 'theme', label: 'Theme', desc: 'The look of the launcher (colours, style).', group: 'Appearance' },
];
const fields = (m) => m;

test('settingsSearchNormalize — lowercase, accent-free, punctuation to space', () => {
    assert.equal(settingsSearchNormalize('Crème BRÛLÉE!'), 'creme brulee');
    assert.equal(settingsSearchNormalize('Wi-Fi'), 'wi fi');
    assert.equal(settingsSearchNormalize(null), '');
});

test('settingsSearchMatches — an empty search gives an empty list; accent-insensitive, every word must match', () => {
    assert.deepEqual(settingsSearchMatches(ITEMS, '  ', fields), []);
    assert.deepEqual(settingsSearchMatches(ITEMS, 'night', fields).map((m) => m.id), ['night-mode']);
    assert.deepEqual(settingsSearchMatches(ITEMS, 'password network', fields).map((m) => m.id), ['wifi']);
    assert.deepEqual(settingsSearchMatches(ITEMS, 'password night', fields), []);
});

test('settingsSearchMatches — a title match goes first, a description/category match after', () => {
    // "cache" is in the games-cache title; "launcher" only in the descriptions (night-mode, theme)
    assert.deepEqual(settingsSearchMatches(ITEMS, 'launcher', fields).map((m) => m.id), ['night-mode', 'theme']);
    assert.deepEqual(settingsSearchMatches(ITEMS, 'theme', fields).map((m) => m.id), ['theme']);
    // searches category names too
    assert.deepEqual(settingsSearchMatches(ITEMS, 'power', fields).map((m) => m.id), ['wifi']);
});
