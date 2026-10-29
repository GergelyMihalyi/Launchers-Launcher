'use strict';

// lib/host-deps/host-packages.js — installing missing system commands:
// distro detection, command → package, building the install command (pkcon / pkexec). The
// `PACKAGE_MAP` ↔ install.sh `pkg_for()` match is checked by test/contracts/host-packages-mirror.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PACKAGE_MAP, detectDistro, packagesFor, installCommand, installMissingCommands,
} = require('../../lib/host-deps/host-packages.js');
const { REQUIRED_COMMANDS } = require('../../lib/host-deps/selftest.js');
const { tmpDir, writeFile } = require('../helpers/fs.js');

test('detectDistro — by ID / ID_LIKE (mirror of distro_id() in install.sh)', () => {
    assert.equal(detectDistro('ID=debian\nVERSION_ID="13"\n'), 'debian');
    assert.equal(detectDistro('ID=ubuntu\nID_LIKE=debian\n'), 'debian');
    assert.equal(detectDistro('ID=linuxmint\nID_LIKE="ubuntu debian"\n'), 'debian');
    assert.equal(detectDistro('ID="fedora"\n'), 'fedora');
    assert.equal(detectDistro('ID=nobara\nID_LIKE="rhel centos fedora"\n'), 'fedora');
    assert.equal(detectDistro('ID=arch\n'), 'arch');
    assert.equal(detectDistro('ID=cachyos\nID_LIKE=arch\n'), 'arch');
    assert.equal(detectDistro('ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n'), null);
    assert.equal(detectDistro(''), null);
});

test('PACKAGE_MAP — on every distro every REQUIRED_COMMANDS command has a package', () => {
    for (const [distro, map] of Object.entries(PACKAGE_MAP)) {
        for (const cmd of REQUIRED_COMMANDS) assert.ok(map[cmd], `${distro}: no package for ${cmd}`);
    }
});

test('packagesFor — unique, order-preserving package list + the commands without a package', () => {
    assert.deepEqual(packagesFor('debian', ['pactl', 'kscreen-doctor', 'pactl', 'unknown']), {
        packages: ['pulseaudio-utils', 'libkscreen-bin'],
        unmapped: ['unknown'],
    });
    assert.deepEqual(packagesFor(null, ['pactl']), { packages: [], unmapped: ['pactl'] });
});

test('installCommand — pkcon first, pkexec + package manager as the fallback', () => {
    assert.deepEqual(installCommand('debian', ['a', 'b'], { hasPkcon: true, hasPkexec: true }),
        { cmd: 'pkcon', args: ['-y', 'install', 'a', 'b'], installer: 'pkcon' });
    assert.deepEqual(installCommand('debian', ['a'], { hasPkcon: false, hasPkexec: true }),
        { cmd: 'pkexec', args: ['apt-get', 'install', '-y', 'a'], installer: 'apt-get' });
    assert.deepEqual(installCommand('fedora', ['a'], { hasPkcon: false, hasPkexec: true }).args,
        ['dnf', 'install', '-y', 'a']);
    assert.deepEqual(installCommand('arch', ['a'], { hasPkcon: false, hasPkexec: true }).args,
        ['pacman', '-S', '--needed', '--noconfirm', 'a']);
    assert.equal(installCommand('debian', ['a'], { hasPkcon: false, hasPkexec: false }), null);
    assert.equal(installCommand('debian', [], { hasPkcon: true, hasPkexec: true }), null);
});

test('installMissingCommands — does not install on an unknown distro, never throws', async (t) => {
    const dir = tmpDir('host-pkgs-');
    writeFile(dir, 'os-release', 'ID=opensuse-tumbleweed\n');
    const res = await installMissingCommands({ osReleasePath: `${dir}/os-release` });
    // The test machine may have every command — then "nothing-missing" is the correct answer.
    if (res.error === 'nothing-missing') {
        assert.equal(res.ok, true);
        t.diagnostic('on the test machine every REQUIRED_COMMANDS command is present');
        return;
    }
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unknown-distro');
    assert.ok(res.missingAfter.length > 0);
    assert.ok(Array.isArray(res.selftest));
});
