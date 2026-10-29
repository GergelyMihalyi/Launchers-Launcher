'use strict';

// tools/new-emulator.js — the skeleton generator. It builds the plan on a temporary copy of the REAL
// target files (so the anchors are tested on today's structure — if someone rewrites a target
// file, this test speaks up, instead of it surfacing when the next emulator is added).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tmpDir } = require('../helpers/fs.js');
const gen = require('../../tools/new-emulator.js');

const root = path.join(__dirname, '..', '..');
const TARGETS = [
    'launcher-registry.js', 'lib/launchers/emulator-sources.js', 'lib/scan/scan-sources.js', 'lib/ipc/games-ipc.js',
    'renderer/i18n/i18n-hu.js', 'renderer/i18n/i18n-en.js',
];
const OPTS = { id: 'citron', name: 'Citron', flatpak: 'org.citron_emu.Citron', exts: ['.nsp', '.xci'] };

function copyRoot() {
    const dir = tmpDir();
    for (const f of TARGETS) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.copyFileSync(path.join(root, f), path.join(dir, f));
    }
    fs.mkdirSync(path.join(dir, 'test', 'launchers'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs', 'dev', 'launchers'), { recursive: true });
    return dir;
}

test('parseArgs / validateArgs — extension without a dot too; bad id/name/appid/ext listed', () => {
    const o = gen.parseArgs(['citron', '--name', 'Citron', '--flatpak', 'org.citron_emu.Citron', '--ext', 'nsp, .XCI', '--dry-run']);
    assert.deepEqual(o, { ...OPTS, dryRun: true });
    assert.deepEqual(gen.validateArgs(o), []);
    assert.equal(gen.validateArgs({ id: 'Bad', name: '', flatpak: 'x', exts: [] }).length, 4);
});

test('planNewEmulator — every anchor is present in today\'s target files; the applied plan is syntactically valid', () => {
    const dir = copyRoot();
    const plan = gen.planNewEmulator(OPTS, dir);
    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
    assert.deepEqual(plan.creates.map((c) => c.file), ['lib/launchers/citron-library.js', 'test/launchers/citron-library.test.js', 'docs/dev/launchers/citron.md']);
    assert.deepEqual(plan.edits.map((e) => e.file).sort(), [...TARGETS].sort());
    gen.applyPlan(plan, dir);
    for (const f of [...TARGETS.filter((t) => t.endsWith('.js')), 'lib/launchers/citron-library.js', 'test/launchers/citron-library.test.js']) {
        assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }), f);
    }
    const reg = fs.readFileSync(path.join(dir, 'launcher-registry.js'), 'utf8');
    assert.match(reg, /id: 'citron', name: 'Citron', chip: 'CITRON'/);
    assert.match(fs.readFileSync(path.join(dir, 'lib/ipc/games-ipc.js'), 'utf8'), /'citron', 'custom', 'melonds',/);
    assert.match(fs.readFileSync(path.join(dir, 'renderer/i18n/i18n-en.js'), 'utf8'), /'err\.citronMissingPath': 'Missing Citron ROM path',/);
});

test('planNewEmulator — already existing id / missing anchor: does not write, gives an error', () => {
    const dir = copyRoot();
    assert.match(gen.planNewEmulator({ ...OPTS, id: 'pcsx2' }, dir).errors.join(), /such an id already exists/);
    const f = path.join(dir, 'lib/ipc/games-ipc.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("'custom', 'melonds',", "'melonds', 'custom',"));
    const res = gen.planNewEmulator(OPTS, dir);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(), /anchor not found \(lib\/ipc\/games-ipc\.js\)/);
    assert.equal(fs.existsSync(path.join(dir, 'lib/launchers/citron-library.js')), false);
});
