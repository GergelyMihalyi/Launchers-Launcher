'use strict';

// Data file integrity — `node --test`, zero dependencies: the consistency of the launcher
// catalog and the local icons.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

// launcher model v2: there is no fixed built-in launcher — every launcher is in the catalog (the 3
// common ones have `common: true`), the active ones live in the `customLaunchers` config key.
const catalog = readJson('data/launcher-catalog.json');

function assertValidLauncher(l, where) {
    assert.equal(typeof l.id, 'string', `${where}: id string`);
    assert.ok(l.id.length, `${where}: id not empty`);
    assert.equal(typeof l.name, 'string', `${where}: name string`);
    assert.ok(l.name.length, `${where}: name not empty`);
    assert.equal(typeof l.cmd, 'string', `${where}: cmd string`);
    assert.ok(l.cmd.length, `${where}: cmd not empty`);
    assert.ok(Array.isArray(l.args), `${where}: args array`);
    assert.ok(l.args.every((a) => typeof a === 'string'), `${where}: args all strings`);
    if ('accent' in l) {
        assert.match(l.accent, /^#[0-9a-fA-F]{6}$/, `${where}: accent #rrggbb hex`);
    }
    // Optional `nativeCmd`: makes an entry with a flatpak `cmd`
    // dual-path (the same app can also be installed natively) — only meaningful
    // on a flatpak entry, and must be a non-empty string.
    // A string OR a candidate list (the binary name differs per distro).
    if ('nativeCmd' in l) {
        assert.equal(l.cmd, 'flatpak', `${where}: nativeCmd only makes sense with a flatpak cmd`);
        const list = Array.isArray(l.nativeCmd) ? l.nativeCmd : [l.nativeCmd];
        assert.ok(list.length, `${where}: nativeCmd not empty`);
        for (const c of list) {
            assert.ok(typeof c === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(c), `${where}: nativeCmd a plain command name: ${c}`);
        }
    }
    // Optional `nativeArgs`: the native variant's arguments
    // (Steam: Big Picture flags) — only next to `nativeCmd`, a string array.
    if ('nativeArgs' in l) {
        assert.ok('nativeCmd' in l, `${where}: nativeArgs only alongside nativeCmd`);
        assert.ok(Array.isArray(l.nativeArgs) && l.nativeArgs.every((a) => typeof a === 'string'), `${where}: nativeArgs string array`);
    }
}

test('launcher-catalog.json — valid schema for every entry', () => {
    assert.ok(Array.isArray(catalog) && catalog.length > 0);
    for (const l of catalog) assertValidLauncher(l, `launcher-catalog.json/${l.id}`);
});

test('no id collision in the catalog', () => {
    const ids = catalog.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id: ${ids}`);
});

test('every icon points to a local, existing file (assets/icons/)', () => {
    for (const l of catalog) {
        assert.ok(l.icon, `${l.id}: has an icon field`);
        assert.ok(
            !/^https?:/i.test(l.icon),
            `${l.id}: the icon must not be a remote URL (offline tolerance): ${l.icon}`,
        );
        assert.ok(
            fs.existsSync(path.join(root, l.icon)),
            `${l.id}: missing icon file: ${l.icon}`,
        );
    }
});

test('every catalog entry has an accent color', () => {
    for (const l of catalog) assert.ok(l.accent, `${l.id}: has an accent field`);
});

test('the 3 common launchers (steam/heroic/retroarch) are in the catalog, common + flathubId', () => {
    for (const id of ['steam', 'heroic', 'retroarch']) {
        const e = catalog.find((c) => c.id === id);
        assert.ok(e, `${id} in the catalog`);
        assert.equal(e.common, true, `${id}: common: true`);
        assert.equal(typeof e.flathubId, 'string', `${id}: flathubId string`);
    }
});

test('steam — flatpak default + nativeCmd/nativeArgs, both variants launch in Big Picture', () => {
    const e = catalog.find((c) => c.id === 'steam');
    assert.equal(e.cmd, 'flatpak');
    assert.deepEqual(e.args.slice(0, 2), ['run', e.flathubId]);
    assert.equal(e.nativeCmd, 'steam');
    assert.deepEqual(e.nativeArgs, e.args.slice(2));
    assert.ok(e.nativeArgs.includes('-gamepadui'));
});

// User requirement: for EVERY launcher — current and added later — both the native and the
// flatpak variant must be selectable. So a new catalog entry gets a `nativeCmd`;
// if it really has no native release, an explicit `"flatpakOnly": "<reason>"` exempts it.
test('every catalog entry is dual-path (nativeCmd), or has a justified flatpakOnly', () => {
    for (const e of catalog) {
        if ('flatpakOnly' in e) {
            assert.ok(typeof e.flatpakOnly === 'string' && e.flatpakOnly.trim(), `${e.id}: flatpakOnly needs a reason`);
            assert.ok(!('nativeCmd' in e), `${e.id}: no nativeCmd alongside flatpakOnly`);
            continue;
        }
        assert.equal(e.cmd, 'flatpak', `${e.id}: the catalog default is flatpak`);
        assert.ok('nativeCmd' in e, `${e.id}: nativeCmd is missing (or a justified "flatpakOnly")`);
    }
});

test('lutris — flatpak default + nativeCmd (for native detection)', () => {
    const e = catalog.find((c) => c.id === 'lutris');
    assert.ok(e, 'lutris in the catalog');
    assert.equal(e.nativeCmd, 'lutris');
});

test('rpcs3 — flatpak default + nativeCmd (because of the "unofficial" dialog of the flathub build)', () => {
    const e = catalog.find((c) => c.id === 'rpcs3');
    assert.ok(e, 'rpcs3 in the catalog');
    assert.equal(e.nativeCmd, 'rpcs3');
});

test('flatpak catalog entries are of the form "run <appid>"', () => {
    for (const l of catalog.filter((e) => e.cmd === 'flatpak')) {
        const i = l.args.indexOf('run');
        assert.ok(i !== -1 && l.args[i + 1], `${l.id}: "run <appid>" is missing from args`);
    }
});

// --- Background manifest (data/backgrounds.json) ---
const backgrounds = readJson('data/backgrounds.json');

test('backgrounds.json — valid schema (id / label / 2-hex swatch), unique id', () => {
    assert.ok(Array.isArray(backgrounds) && backgrounds.length > 0);
    const ids = new Set();
    for (const b of backgrounds) {
        assert.equal(typeof b.id, 'string', `${b.id}: id string`);
        assert.ok(b.id.length, 'id not empty');
        assert.equal(typeof b.label, 'string', `${b.id}: label string`);
        assert.ok(Array.isArray(b.swatch) && b.swatch.length === 2, `${b.id}: 2-element swatch`);
        for (const c of b.swatch) assert.match(c, /^#[0-9a-fA-F]{6}$/, `${b.id}: swatch hex`);
        assert.ok(!ids.has(b.id), `duplicate background id: ${b.id}`);
        ids.add(b.id);
    }
});

test('an existing assets/backgrounds/<id>.svg for every background id', () => {
    for (const b of backgrounds) {
        const p = path.join(root, 'assets', 'backgrounds', `${b.id}.svg`);
        assert.ok(fs.existsSync(p), `missing SVG: ${b.id}.svg`);
        const svg = fs.readFileSync(p, 'utf8');
        assert.match(svg, /<svg[\s>]/, `${b.id}: not an SVG`);
        assert.match(svg, /<\/svg>\s*$/, `${b.id}: no closing </svg>`);
    }
});
