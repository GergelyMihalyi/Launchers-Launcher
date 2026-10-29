'use strict';

// lib/launcher-list.js — launcher list assembly + the customLaunchers/launcherOrder
// config keys. XDG_CONFIG_HOME pointed at a temp directory BEFORE the `require` (as in
// config.test.js), so the test does not touch the real user config.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useTempConfigHome, tmpDir } = require('./helpers/fs.js');

const { reset } = useTempConfigHome('gl-xdg-');
const config = require('../lib/config.js');
const launchersLib = require('../lib/launcher-list.js');

test('isValidLauncher — requires every field of the schema', () => {
    assert.ok(launchersLib.isValidLauncher({
        id: 'steam', name: 'Steam', cmd: 'steam', args: ['-gamepadui'],
    }));
    assert.ok(!launchersLib.isValidLauncher({ id: 'steam', name: 'Steam', cmd: 'steam' })); // no args
    assert.ok(!launchersLib.isValidLauncher({ id: '', name: 'Steam', cmd: 'steam', args: [] })); // empty id
    assert.ok(!launchersLib.isValidLauncher({ id: 'x', name: 'X', cmd: 'x', args: [1] })); // non-string arg
    assert.ok(!launchersLib.isValidLauncher(null));
});

test('isAccentColor — only #rrggbb hex', () => {
    assert.ok(launchersLib.isAccentColor('#1a9fff'));
    assert.ok(launchersLib.isAccentColor('#ABCDEF'));
    assert.ok(!launchersLib.isAccentColor('#fff'));
    assert.ok(!launchersLib.isAccentColor('1a9fff'));
    assert.ok(!launchersLib.isAccentColor('red'));
    assert.ok(!launchersLib.isAccentColor(''));
    assert.ok(!launchersLib.isAccentColor(undefined));
});

test('readCustomLaunchers — takes over the accent if it is a valid hex; otherwise drops it', () => {
    reset();
    config.set('customLaunchers', [
        { id: 'good', name: 'Good', cmd: 'flatpak', args: ['run', 'x'], accent: '#123abc' },
        { id: 'rossz', name: 'Rossz', cmd: 'flatpak', args: ['run', 'y'], accent: 'lila' },
    ]);
    const list = launchersLib.readCustomLaunchers();
    assert.equal(list.find((l) => l.id === 'good').accent, '#123abc');
    assert.ok(!('accent' in list.find((l) => l.id === 'rossz')));
});

test('orderLaunchers — those not in the list go to the end, an unknown id is dropped', () => {
    const raw = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const ordered = launchersLib.orderLaunchers(['c', 'unknown', 'a'], raw);
    assert.deepEqual(ordered.map((l) => l.id), ['c', 'a', 'b']);
});

test('orderLaunchers — with an empty id list the original order stays', () => {
    const raw = [{ id: 'a' }, { id: 'b' }];
    assert.deepEqual(launchersLib.orderLaunchers([], raw).map((l) => l.id), ['a', 'b']);
});

test('applyAccentOverrides — a valid hex overrides, an invalid/missing one is skipped (roadmap 4.6)', () => {
    const list = [{ id: 'steam', accent: '#111111' }, { id: 'heroic' }, { id: 'retro', accent: '#222222' }];
    const out = launchersLib.applyAccentOverrides(list, { steam: '#1a9fff', heroic: 'not-hex', retro: null });
    assert.equal(out[0].accent, '#1a9fff'); // overridden
    assert.equal(out[1].accent, undefined); // bad hex -> none
    assert.equal(out[2].accent, '#222222'); // null -> the JSON default stays
    assert.notEqual(out, list); // fresh array
    assert.notEqual(out[0], list[0]); // fresh objects
});

test('applyAccentOverrides — no/bad map -> unchanged (copy)', () => {
    const list = [{ id: 'a', accent: '#000000' }];
    assert.deepEqual(launchersLib.applyAccentOverrides(list, null), list);
    assert.deepEqual(launchersLib.applyAccentOverrides(list, 'not-an-object'), list);
});

test('seedBuiltinCustomLaunchers — appends the 3 old built-ins (skipping an existing / disabled one)', () => {
    const catalog = [
        { id: 'steam', name: 'Steam', cmd: 'steam', args: ['-x'], accent: '#1a9fff' },
        { id: 'heroic', name: 'Heroic', cmd: 'flatpak', args: ['run', 'com.h'] },
        { id: 'retroarch', name: 'RetroArch', cmd: 'flatpak', args: ['run', 'org.r'] },
    ];
    // empty custom → all 3 get in, as catalog copies (`custom: true`)
    let out = launchersLib.seedBuiltinCustomLaunchers([], catalog);
    assert.deepEqual(out.map((l) => l.id), ['steam', 'heroic', 'retroarch']);
    assert.equal(out[0].custom, true);
    assert.equal(out[0].accent, '#1a9fff');

    // heroic (custom) is already in + steam disabled → only retroarch gets in
    out = launchersLib.seedBuiltinCustomLaunchers([{ id: 'heroic', name: 'own', cmd: 'x', args: [] }], catalog, ['steam']);
    assert.deepEqual(out.map((l) => l.id), ['heroic', 'retroarch']);
});

test('migrateBuiltinLaunchers — fresh install (no setupDone): only writes the marker, NO-OP', () => {
    reset();
    const logs = [];
    const catalog = [{ id: 'steam', name: 'Steam', cmd: 'steam', args: [] }];
    const res = launchersLib.migrateBuiltinLaunchers(catalog, { logInfo: (m) => logs.push(m), logError: (m) => logs.push(m) });
    assert.deepEqual(res, { migrated: false });
    assert.equal(config.get('_launcherModelV2', false), true);
    assert.deepEqual(config.get('customLaunchers', []), []);
    assert.equal(logs.length, 0);
});

test('migrateBuiltinLaunchers — existing install (setupDone: true): copies the 3 built-ins + marker + logs', () => {
    reset();
    config.set('setupDone', true);
    const logs = [];
    const catalog = [
        { id: 'steam', name: 'Steam', cmd: 'steam', args: ['-x'] },
        { id: 'heroic', name: 'Heroic', cmd: 'flatpak', args: ['run', 'com.h'] },
        { id: 'retroarch', name: 'RetroArch', cmd: 'flatpak', args: ['run', 'org.r'] },
    ];
    const res = launchersLib.migrateBuiltinLaunchers(catalog, { logInfo: (m) => logs.push(m) });
    assert.deepEqual(res, { migrated: true, added: 3 });
    assert.deepEqual(config.get('customLaunchers', []).map((l) => l.id), ['steam', 'heroic', 'retroarch']);
    assert.equal(config.get('_launcherModelV2', false), true);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes('3 built-in launchers copied'));
});

test('migrateBuiltinLaunchers — honors the disabledBuiltins key', () => {
    reset();
    config.set('setupDone', true);
    config.set('disabledBuiltins', ['steam', 'retroarch']);
    const catalog = [
        { id: 'steam', name: 'Steam', cmd: 'steam', args: [] },
        { id: 'heroic', name: 'Heroic', cmd: 'flatpak', args: ['run', 'com.h'] },
        { id: 'retroarch', name: 'RetroArch', cmd: 'flatpak', args: ['run', 'org.r'] },
    ];
    launchersLib.migrateBuiltinLaunchers(catalog, { logInfo: () => {} });
    assert.deepEqual(config.get('customLaunchers', []).map((l) => l.id), ['heroic']);
});

test('migrateBuiltinLaunchers — the marker is already there: NO-OP, does not write/log again', () => {
    reset();
    config.set('setupDone', true);
    config.set('_launcherModelV2', true);
    const logs = [];
    const catalog = [{ id: 'steam', name: 'Steam', cmd: 'steam', args: [] }];
    const res = launchersLib.migrateBuiltinLaunchers(catalog, { logInfo: (m) => logs.push(m) });
    assert.deepEqual(res, { migrated: false });
    assert.deepEqual(config.get('customLaunchers', []), []);
    assert.equal(logs.length, 0);
});

test('migrateBuiltinLaunchers — an error thrown inside the try block does not propagate, ends with logError', () => {
    reset();
    config.set('setupDone', true);
    const logs = [];
    // Making `logInfo` (the last step of the success branch, still inside the try block) throw
    // simulates the "something blew up during the operation" case — the catch branch must swallow it.
    const res = launchersLib.migrateBuiltinLaunchers([{ id: 'steam', name: 'Steam', cmd: 'steam', args: [] }], {
        logInfo: () => { throw new Error('log error'); },
        logError: (m) => logs.push(m),
    });
    assert.equal(res.migrated, false);
    assert.ok(logs.some((l) => l.includes('log error')));
});

test('matchCatalogEntry — flatpak appid matching against the catalog (launcher-model-v2)', () => {
    const catalog = [
        { id: 'heroic', name: 'Heroic', cmd: 'flatpak', args: ['run', 'com.heroicgameslauncher.hgl'], accent: '#ff6b3d' },
        { id: 'retroarch', name: 'RetroArch', cmd: 'flatpak', args: ['run', 'org.libretro.RetroArch'] },
    ];
    // added by hand, same appid, different name → returns the catalog entry
    const hit = launchersLib.matchCatalogEntry(
        { id: 'x', name: 'something', cmd: 'flatpak', args: ['run', 'com.heroicgameslauncher.hgl'] }, catalog);
    assert.equal(hit && hit.id, 'heroic');

    assert.equal(launchersLib.matchCatalogEntry(
        { cmd: 'flatpak', args: ['run', 'com.example.Unknown'] }, catalog), null);
    assert.equal(launchersLib.matchCatalogEntry({ cmd: 'firefox', args: [] }, catalog), null); // not flatpak
    assert.equal(launchersLib.matchCatalogEntry(null, catalog), null);
});

test('checkLauncherPayload — flatpak/native/custom classification + normalization', () => {
    const catalog = [{ id: 'lutris', cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'], nativeCmd: 'lutris' }];
    const chk = (p) => launchersLib.checkLauncherPayload({ id: 'x', name: 'X', args: [], ...p }, catalog);

    assert.equal(chk({ cmd: 'flatpak', args: ['run', 'org.foo.Bar', '--fullscreen'] }).kind, 'flatpak');
    assert.equal(chk({ cmd: 'flatpak', args: ['run', '--command=sh', 'org.foo.Bar'] }).ok, false);
    assert.equal(chk({ cmd: 'flatpak', args: ['run', 'not-an-appid'] }).ok, false);
    assert.equal(chk({ cmd: 'flatpak', args: ['kill', 'org.foo.Bar'] }).ok, false);

    assert.equal(chk({ cmd: 'lutris' }).kind, 'native');
    assert.equal(chk({ cmd: 'lutris', args: ['-c', 'x'] }).kind, 'custom'); // already custom with an arg → which check

    assert.equal(chk({ cmd: 'firefox', args: ['--kiosk'] }).kind, 'custom');
    assert.equal(chk({ cmd: '/opt/My Game/start' }).kind, 'custom');
    for (const bad of ['bash', '/usr/bin/zsh', 'python3.12', 'perl5', 'env', 'sudo', 'systemd-run', 'x;y', '$(id)', '../x', '-rf']) {
        assert.equal(chk({ cmd: bad }).ok, false, bad);
    }

    assert.equal(chk({ id: '../evil', cmd: 'firefox' }).ok, false);
    assert.equal(chk({ id: `custom-${'a'.repeat(60)}-2`, cmd: 'firefox' }).ok, true); // long name → long id
    const r = chk({ cmd: 'firefox', icon: 'file:///etc/passwd', accent: 'red', custom: false, extra: 1 });
    assert.deepEqual(r.entry, { id: 'x', name: 'X', hint: '', icon: '', cmd: 'firefox', args: [] });
    assert.equal(chk({ cmd: 'firefox', icon: 'assets/icons/steam.svg' }).entry.icon, 'assets/icons/steam.svg');
    assert.equal(launchersLib.checkLauncherPayload(null, catalog).ok, false);
});

// --- Native / flatpak variant ---
const DUAL_STEAM = {
    id: 'steam', name: 'Steam', cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-gamepadui', '-tenfoot'],
    nativeCmd: 'steam', nativeArgs: ['-gamepadui', '-tenfoot'],
};

test('checkLauncherPayload — the native variant is accepted with the catalog `nativeArgs`, not with other args', () => {
    const chk = (args) => launchersLib.checkLauncherPayload({ id: 'steam', name: 'Steam', cmd: 'steam', args }, [DUAL_STEAM]);
    assert.equal(chk([]).kind, 'native');
    assert.equal(chk(['-gamepadui', '-tenfoot']).kind, 'native');
    assert.equal(chk(['-gamepadui']).kind, 'custom');                  // partial → custom (which check)
    assert.equal(chk(['-tenfoot', '-gamepadui']).kind, 'custom');      // order matters too
});

test('variantSpec / launcherVariantOf / isDualCatalogEntry', () => {
    assert.equal(launchersLib.isDualCatalogEntry(DUAL_STEAM), true);
    assert.equal(launchersLib.isDualCatalogEntry({ cmd: 'flatpak', args: ['run', 'a.b.c'] }), false);
    assert.equal(launchersLib.isDualCatalogEntry({ cmd: 'steam', nativeCmd: 'steam' }), false);
    assert.deepEqual(launchersLib.variantSpec(DUAL_STEAM, 'native'), { cmd: 'steam', args: ['-gamepadui', '-tenfoot'] });
    assert.deepEqual(launchersLib.variantSpec(DUAL_STEAM, 'flatpak'), { cmd: 'flatpak', args: DUAL_STEAM.args });
    // without nativeArgs (Lutris) → empty args
    assert.deepEqual(launchersLib.variantSpec({ ...DUAL_STEAM, nativeArgs: undefined }, 'native').args, []);

    const of = (l) => launchersLib.launcherVariantOf(l, DUAL_STEAM);
    assert.equal(of({ cmd: 'steam', args: [] }), 'native');
    assert.equal(of({ cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam'] }), 'flatpak');
    assert.equal(of({ cmd: 'flatpak', args: ['run', 'org.other.App'] }), null); // rewritten by hand
    assert.equal(of({ cmd: '/opt/steam/run.sh', args: [] }), null);
    assert.equal(of(undefined), null);
    assert.equal(launchersLib.launcherVariantOf({ cmd: 'steam', args: [] }, { id: 'x', cmd: 'steam', args: [] }), null);
});

test('pickLauncherVariant — one variant → that; both → the requested one, flatpak by default', () => {
    const pick = launchersLib.pickLauncherVariant;
    assert.equal(pick('native'), 'native');
    assert.equal(pick('native', 'flatpak'), 'native');
    assert.equal(pick('flatpak', 'native'), 'flatpak');
    assert.equal(pick(true, 'native'), 'flatpak');
    assert.equal(pick('both'), 'flatpak');
    assert.equal(pick('both', 'native'), 'native');
    assert.equal(pick(false), 'flatpak');
    assert.equal(pick(null, 'native'), 'flatpak');
});

test('planVariantRepairs — only if the added variant is missing, but the other one is present', () => {
    const nativeSteam = { id: 'steam', cmd: 'steam', args: ['-gamepadui', '-tenfoot'] };
    const flatpakSteam = { id: 'steam', cmd: 'flatpak', args: DUAL_STEAM.args };
    const plan = (l, inst) => launchersLib.planVariantRepairs([l], [DUAL_STEAM], { steam: inst });
    assert.deepEqual(plan(nativeSteam, 'flatpak'), [{ id: 'steam', from: 'native', to: 'flatpak' }]);
    assert.deepEqual(plan(flatpakSteam, 'native'), [{ id: 'steam', from: 'flatpak', to: 'native' }]);
    assert.deepEqual(plan(nativeSteam, 'native'), []);
    assert.deepEqual(plan(nativeSteam, 'both'), []);   // the user's decision stays
    assert.deepEqual(plan(nativeSteam, false), []);    // neither → we do not touch it
    assert.deepEqual(plan(nativeSteam, undefined), []); // detection failed
    assert.deepEqual(plan({ id: 'steam', cmd: '/opt/x', args: [] }, 'flatpak'), []); // rewritten by hand
    assert.deepEqual(launchersLib.planVariantRepairs([{ id: 'heroic', cmd: 'flatpak', args: ['run', 'a.b.c'] }],
        [DUAL_STEAM], { heroic: 'flatpak' }), []);
});

test('seedBuiltinCustomLaunchers — dual-path Steam: takes over the v1 native shape', () => {
    const out = launchersLib.seedBuiltinCustomLaunchers([], [DUAL_STEAM]);
    assert.equal(out[0].cmd, 'steam');
    assert.deepEqual(out[0].args, ['-gamepadui', '-tenfoot']);
});

test('readCustomLaunchers/writeCustomLaunchers — round trip on the config key', () => {
    reset();
    launchersLib.writeCustomLaunchers([
        { id: 'ryujinx', name: 'Ryujinx', hint: '', icon: '', cmd: 'flatpak', args: ['run', 'io.github.ryubing.Ryujinx'], custom: true },
    ]);
    const list = launchersLib.readCustomLaunchers();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ryujinx');
    assert.equal(list[0].custom, true);
});

test('readCustomLaunchers — filters out invalid entries', () => {
    reset();
    config.set('customLaunchers', [
        { id: 'ok', name: 'OK', cmd: 'flatpak', args: ['run', 'x'] },
        { id: 'bad', name: 'Bad' }, // no cmd/args
    ]);
    const list = launchersLib.readCustomLaunchers();
    assert.deepEqual(list.map((l) => l.id), ['ok']);
});

test('readLauncherOrder/writeLauncherOrder — round trip on the config key', () => {
    reset();
    launchersLib.writeLauncherOrder(['steam', 'heroic']);
    assert.deepEqual(launchersLib.readLauncherOrder(), ['steam', 'heroic']);
});

test('isLauncherInstalled — non-flatpak: which <cmd>, an existing command gives true', async () => {
    assert.equal(await launchersLib.isLauncherInstalled({ cmd: 'ls', args: [] }), true);
});

test('isLauncherInstalled — a nonexistent command gives false (does not throw)', async () => {
    assert.equal(await launchersLib.isLauncherInstalled({ cmd: 'gl-nemletezo-parancs-xyz', args: [] }), false);
});

// nativeCmd — dual-path entry: flatpak `cmd` + native `nativeCmd`. The flatpak appid is surely
// not installed on the test machine/CI, but the native `ls`/`which` is always available — so the
// "native-only" branch is testable deterministically without mocking. The "both" branch is
// covered by the pure `combineInstallState`.
test('isLauncherInstalled — nativeCmd: native found, flatpak (fictitious appid) not -> "native"', async () => {
    const result = await launchersLib.isLauncherInstalled({
        cmd: 'flatpak', args: ['run', 'gl.test.nemletezo.appid'], nativeCmd: 'ls',
    });
    assert.equal(result, 'native');
});

test('isLauncherInstalled — nativeCmd: neither native nor flatpak -> false', async () => {
    const result = await launchersLib.isLauncherInstalled({
        cmd: 'flatpak', args: ['run', 'gl.test.nemletezo.appid'], nativeCmd: 'gl-nemletezo-parancs-xyz',
    });
    assert.equal(result, false);
});

test('combineInstallState — both -> "both", only one -> that one, neither -> false', () => {
    assert.equal(launchersLib.combineInstallState(true, true), 'both');
    assert.equal(launchersLib.combineInstallState(true, false), 'native');
    assert.equal(launchersLib.combineInstallState(false, true), 'flatpak');
    assert.equal(launchersLib.combineInstallState(false, false), false);
});

test('nativeCmd candidate list — nativeCmdsOf / launcherVariantOf / checkLauncherPayload / variantSpec', () => {
    const e = { id: 'pcsx2', cmd: 'flatpak', args: ['run', 'net.pcsx2.PCSX2'], nativeCmd: ['pcsx2-qt', 'pcsx2'] };
    assert.deepEqual(launchersLib.nativeCmdsOf(e), ['pcsx2-qt', 'pcsx2']);
    assert.deepEqual(launchersLib.nativeCmdsOf({ nativeCmd: 'x' }), ['x']);
    assert.deepEqual(launchersLib.nativeCmdsOf({}), []);
    assert.equal(launchersLib.isDualCatalogEntry(e), true);
    assert.equal(launchersLib.launcherVariantOf({ cmd: 'pcsx2', args: [] }, e), 'native');
    assert.equal(launchersLib.checkLauncherPayload({ id: 'pcsx2', name: 'P', cmd: 'pcsx2', args: [] }, [e]).kind, 'native');
    assert.deepEqual(launchersLib.variantSpec(e, 'native'), { cmd: 'pcsx2-qt', args: [] });   // first candidate
    assert.deepEqual(launchersLib.variantSpec(e, 'native', 'pcsx2'), { cmd: 'pcsx2', args: [] }); // the one found
});

test('appVariantsFromLaunchers — the flatpak-appid → variant map of the added dual-path launchers', () => {
    const catalog = [
        DUAL_STEAM,
        { id: 'pcsx2', cmd: 'flatpak', args: ['run', 'net.pcsx2.PCSX2'], nativeCmd: ['pcsx2-qt', 'pcsx2'] },
        { id: 'heroic', cmd: 'flatpak', args: ['run', 'com.heroicgameslauncher.hgl'] }, // not dual-path
    ];
    const list = [
        { id: 'steam', cmd: 'flatpak', args: DUAL_STEAM.args },
        { id: 'pcsx2', cmd: 'pcsx2', args: [] },
        { id: 'heroic', cmd: 'flatpak', args: ['run', 'com.heroicgameslauncher.hgl'] },
        { id: 'custom-x', cmd: 'firefox', args: [] },
    ];
    assert.deepEqual(launchersLib.appVariantsFromLaunchers(list, catalog), {
        'com.valvesoftware.Steam': 'flatpak', 'net.pcsx2.PCSX2': 'native',
    });
});

test('detectLauncherInstall — candidate list: gives the first one on PATH (live `which`)', async () => {
    const res = await launchersLib.detectLauncherInstall({
        cmd: 'flatpak', args: ['run', 'gl.test.nemletezo.appid'], nativeCmd: ['gl-nemletezo-parancs-xyz', 'ls'],
    });
    assert.deepEqual(res, { installed: 'native', nativeCmd: 'ls' });
});

// --- Manually specified native launcher ---

function writeExe(dir, rel, mode = 0o755) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '#!/bin/true\n');
    fs.chmodSync(full, mode);
    return full;
}

test('launcherPaths — write/read, absolute path only; the manual path is the VERY FIRST native candidate', () => {
    reset();
    const e = { id: 'ryujinx', cmd: 'flatpak', args: ['run', 'io.github.ryubing.Ryujinx'], nativeCmd: ['Ryujinx', 'ryujinx'] };
    assert.deepEqual(launchersLib.nativeCmdsOf(e), ['Ryujinx', 'ryujinx']);
    launchersLib.writeLauncherPath('ryujinx', '/opt/ryujinx/Ryujinx');
    config.set('launcherPaths', { ...config.get('launcherPaths', {}), bogus: 'relativ/ut' });
    assert.deepEqual(launchersLib.readLauncherPaths(), { ryujinx: '/opt/ryujinx/Ryujinx' });
    assert.deepEqual(launchersLib.nativeCmdsOf(e), ['/opt/ryujinx/Ryujinx', 'Ryujinx', 'ryujinx']);
    assert.equal(launchersLib.launcherVariantOf({ cmd: '/opt/ryujinx/Ryujinx', args: [] }, e), 'native');
    assert.equal(launchersLib.checkLauncherPayload({ id: 'ryujinx', name: 'R', cmd: '/opt/ryujinx/Ryujinx', args: [] }, [e]).kind, 'native');
    launchersLib.writeLauncherPath('ryujinx', null);
    assert.deepEqual(launchersLib.readLauncherPaths(), {});
    reset();
});

test('checkLauncherExecutable — existing, executable, plain file; not an interpreter', () => {
    const dir = tmpDir('gl-lp-');
    assert.equal(launchersLib.checkLauncherExecutable(writeExe(dir, 'Ryujinx')).ok, true);
    assert.equal(launchersLib.checkLauncherExecutable(writeExe(dir, 'notexec', 0o644)).reason, 'not executable');
    assert.equal(launchersLib.checkLauncherExecutable(dir).reason, 'not a file');
    assert.equal(launchersLib.checkLauncherExecutable(path.join(dir, 'missing')).reason, 'does not exist');
    assert.equal(launchersLib.checkLauncherExecutable('relativ').ok, false);
    assert.equal(launchersLib.checkLauncherExecutable(writeExe(dir, 'bash')).ok, false);
    assert.equal(launchersLib.checkLauncherExecutable(writeExe(dir, 'python3')).ok, false);
});

test('findLauncherExecutables — match by name (case), AppImage with the id, 1 level deep, newer version first', () => {
    const dir = tmpDir('gl-lp-');
    const e = { id: 'ryujinx', name: 'Ryujinx', nativeCmd: ['Ryujinx', 'ryujinx'] };
    writeExe(dir, 'publish/ryujinx');
    writeExe(dir, 'Ryujinx-1.2.9-x86_64.AppImage');
    writeExe(dir, 'Ryujinx-1.2.10-x86_64.AppImage');
    writeExe(dir, 'Masik-1.0.AppImage');
    writeExe(dir, 'readme.txt', 0o644);
    writeExe(dir, 'a/b/Ryujinx'); // 2 levels deep → skipped
    const res = launchersLib.findLauncherExecutables(dir, e);
    assert.equal(res.guess, false);
    assert.deepEqual(res.items.map((i) => i.name), [
        path.join('publish', 'ryujinx'), 'Ryujinx-1.2.10-x86_64.AppImage', 'Ryujinx-1.2.9-x86_64.AppImage',
    ]);
    assert.equal(res.items[0].path, path.join(dir, 'publish', 'ryujinx'));
});

test('findLauncherExecutables — nothing by name: the executable files of the folder (guess); empty/nonexistent folder → empty', () => {
    const dir = tmpDir('gl-lp-');
    writeExe(dir, 'start-emu');
    writeExe(dir, 'sub/other');
    const res = launchersLib.findLauncherExecutables(dir, { id: 'cemu', name: 'Cemu', nativeCmd: ['cemu', 'Cemu'] });
    assert.equal(res.guess, true);
    assert.deepEqual(res.items.map((i) => i.name), ['start-emu']);
    assert.deepEqual(launchersLib.findLauncherExecutables(path.join(dir, 'missing'), { id: 'x', name: 'X', nativeCmd: 'x' }).items, []);
});
