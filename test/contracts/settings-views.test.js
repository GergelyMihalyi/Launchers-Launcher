'use strict';

// Consistency of the Settings sub-view registry (at source level, like
// ipc-channels.test.js). The `SETTINGS_MENU` array in `renderer/settings/settings.js` is the only
// source of menu entries; every sub-view registers itself at the bottom of its own
// `renderer/settings/settings-<id>.js` with `SETTINGS_VIEWS['<id>'] = { open, handle }`. This test
// fails if a menu id has no registration (or vice versa) — exactly the kind of mistake
// that is easy to make when adding a new sub-view.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');

const root = path.join(__dirname, '..', '..');

// Comment-free source (line and block comments removed), so example quotes in
// comments do not count as matches.
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const settingsSrc = stripComments(fs.readFileSync(path.join(root, 'renderer', 'settings', 'settings.js'), 'utf8'));

const rendererDir = path.join(root, 'renderer');

const allRenderer = listJsFiles(rendererDir)
    .map((rel) => path.join(rendererDir, rel))
    .map((abs) => stripComments(fs.readFileSync(abs, 'utf8')))
    .join('\n');

// SETTINGS_MENU = [ { id: '...', label: '...', group: '...' }, ... ] — only the id block.
const menuBlock = settingsSrc.match(/const SETTINGS_MENU = \[([\s\S]*?)\];/);
assert.ok(menuBlock, 'SETTINGS_MENU array not found in settings.js');
const menuIds = [...menuBlock[1].matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
const menuGroups = [...menuBlock[1].matchAll(/group:\s*'([^']+)'/g)].map((m) => m[1]);

// SETTINGS_GROUPS = [ { id: '...', label: '...' }, ... ]
const groupBlock = settingsSrc.match(/const SETTINGS_GROUPS = \[([\s\S]*?)\];/);
assert.ok(groupBlock, 'SETTINGS_GROUPS array not found in settings.js');
const groupIds = [...groupBlock[1].matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);

const registeredIds = [...allRenderer.matchAll(/SETTINGS_VIEWS\['([^']+)'\]\s*=/g)].map((m) => m[1]);

test('every SETTINGS_MENU id has a sub-view registration', () => {
    assert.ok(menuIds.length >= 8, `only ${menuIds.length} menu entries`);
    for (const id of menuIds) {
        assert.ok(registeredIds.includes(id), `no SETTINGS_VIEWS['${id}'] registration`);
    }
});

test('every sub-view registration has a SETTINGS_MENU entry', () => {
    for (const id of registeredIds) {
        assert.ok(menuIds.includes(id), `SETTINGS_VIEWS['${id}'] is registered, but it is not in the menu`);
    }
});

test('every SETTINGS_MENU entry has a group, and it is an existing SETTINGS_GROUPS id', () => {
    assert.equal(menuGroups.length, menuIds.length, 'not every SETTINGS_MENU row has a group');
    for (const g of menuGroups) {
        assert.ok(groupIds.includes(g), `the '${g}' group is not in SETTINGS_GROUPS`);
    }
});

test('every SETTINGS_GROUPS category has at least one member', () => {
    for (const g of groupIds) {
        assert.ok(menuGroups.includes(g), `the '${g}' category has no menu item at all`);
    }
});

test('settings.js contains no if-ladder switching on the id (replaced by a registry)', () => {
    assert.ok(!/item\.id === '/.test(settingsSrc), 'an `item.id === ...` branch is left in enterSettingsItem');
    assert.ok(!/settingsView === 'audio-sink'/.test(settingsSrc), 'a `settingsView === ...` branch is left in handleSettingsInput');
});
