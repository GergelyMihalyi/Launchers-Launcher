'use strict';

// renderer/setup-wizard.js — the `wizStepInfo` (pure step meta) + `wizListNote` (tr key)
// helpers. `wizStepInfo` does NOT call `tr()` (the renderer's `wizStepLabel` resolves the
// label) — so the module can be required on its own without i18n.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    wizStepInfo, wizListNote, wizCheckSummary, WIZ_SEQ, WIZ_REAL, WIZ_CMD_PURPOSE,
} = require('../renderer/setup-wizard.js');
const { REQUIRED_COMMANDS } = require('../lib/host-deps/selftest.js');

test('WIZ_SEQ — welcome + 6 real steps (language, launchers first) + button layout + done', () => {
    assert.deepEqual(WIZ_SEQ, ['welcome', 'language', 'launchers', 'monitor', 'sink', 'controller', 'theme', 'controls', 'done']);
    assert.deepEqual(WIZ_REAL, ['language', 'launchers', 'monitor', 'sink', 'controller', 'theme']);
});

test('wizStepInfo — the frame steps have no counter', () => {
    assert.equal(wizStepInfo(0).id, 'welcome');
    assert.equal(wizStepInfo(0).counter, '');
    assert.equal(wizStepInfo(7).id, 'controls');
    assert.equal(wizStepInfo(7).counter, '');
    assert.equal(wizStepInfo(8).id, 'done');
    assert.equal(wizStepInfo(8).counter, '');
});

test('wizStepInfo — the real steps get a "k / 6" counter', () => {
    assert.equal(wizStepInfo(1).id, 'language');
    assert.equal(wizStepInfo(1).counter, '1 / 6');
    assert.equal(wizStepInfo(2).id, 'launchers');
    assert.equal(wizStepInfo(2).counter, '2 / 6');
    assert.equal(wizStepInfo(3).id, 'monitor');
    assert.equal(wizStepInfo(3).counter, '3 / 6');
    assert.equal(wizStepInfo(6).id, 'theme');
    assert.equal(wizStepInfo(6).counter, '6 / 6');
});

test('wizStepInfo — index clamp outside the range', () => {
    assert.equal(wizStepInfo(-3).id, 'welcome');
    assert.equal(wizStepInfo(99).id, 'done');
});

test('wizListNote — an empty string for the launchers step (no empty/fail note)', () => {
    assert.equal(wizListNote('launchers', { builtins: [] }), '');
});

test('wizListNote — there is an item -> empty (no explanatory line)', () => {
    assert.equal(wizListNote('monitor', { monitors: [{ name: 'DP-1' }], monitorsOk: true }), '');
    assert.equal(wizListNote('sink', { sinks: [{ name: 's1' }] }), '');
});

test('wizListNote — empty list + successful/failed query -> the matching tr key', () => {
    assert.equal(wizListNote('monitor', { monitors: [], monitorsOk: true }), 'wizard.noteMonitorEmpty');
    assert.equal(wizListNote('monitor', { monitors: [], monitorsOk: false }), 'wizard.noteMonitorFail');
    assert.equal(wizListNote('sink', { sinks: [], sinksOk: false }), 'wizard.noteSinkFail');
    assert.equal(wizListNote('controller', { controllers: [], controllersOk: true }), 'wizard.noteControllerEmpty');
});

test('wizListNote — an empty string for the welcome / done / theme / language step', () => {
    assert.equal(wizListNote('welcome', {}), '');
    assert.equal(wizListNote('done', {}), '');
    assert.equal(wizListNote('theme', { themes: [] }), '');
    assert.equal(wizListNote('language', {}), '');
    assert.equal(wizListNote('monitor', undefined), 'wizard.noteMonitorEmpty');
});

test('wizCheckSummary — the selected but not installed launchers + the missing commands (D5)', () => {
    const choices = {
        catalog: [
            { id: 'steam', name: 'Steam', installed: true },
            { id: 'retroarch', name: 'RetroArch', installed: false },
            { id: 'heroic', name: 'Heroic', installed: false },
            { id: 'lutris', name: 'Lutris', installed: null },
        ],
        selftest: [{ cmd: 'pactl', ok: true }, { cmd: 'kscreen-doctor', ok: false }],
    };
    const res = wizCheckSummary(choices, { addLaunchers: ['steam', 'retroarch', 'lutris'] });
    assert.deepEqual(res.notInstalled, ['RetroArch'], 'the unselected Heroic and the unknown Lutris do not signal');
    assert.deepEqual(res.missingCommands, ['kscreen-doctor']);
    assert.equal(res.checked, true);
    assert.deepEqual(wizCheckSummary(undefined, undefined), { notInstalled: [], missingCommands: [], checked: false });
});

test('WIZ_CMD_PURPOSE — there is an explanation for every required system command (lib/host-deps/selftest.js)', () => {
    for (const cmd of REQUIRED_COMMANDS) assert.ok(WIZ_CMD_PURPOSE[cmd], `missing: ${cmd}`);
});
