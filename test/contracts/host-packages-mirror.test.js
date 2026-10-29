'use strict';

// The install.sh `pkg_for()` case table ↔ `PACKAGE_MAP` in lib/host-deps/host-packages.js:
// an install started from the launcher must ask for the same package as the installer.
// The bash side is larger, with the install-time items (node/npm/curl/xz).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PACKAGE_MAP } = require('../../lib/host-deps/host-packages.js');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'install.sh'), 'utf8');

// `debian:pactl)   echo "pulseaudio-utils" ;;` (a `a:x|a:y)` alak is)
function bashTable() {
    const table = new Map();
    const re = /^\s*([a-z]+:[a-z0-9-]+(?:\|[a-z]+:[a-z0-9-]+)*)\)\s+echo "([^"]*)" ;;/gm;
    for (const m of src.matchAll(re)) {
        for (const key of m[1].split('|')) table.set(key, m[2]);
    }
    return table;
}

test('install.sh pkg_for() — parseable, all three distros included', () => {
    const t = bashTable();
    for (const d of ['fedora', 'arch', 'debian']) assert.ok(t.has(`${d}:pactl`), `${d}:pactl is missing`);
});

test('every PACKAGE_MAP row matches install.sh pkg_for()', () => {
    const t = bashTable();
    for (const [distro, map] of Object.entries(PACKAGE_MAP)) {
        for (const [cmd, pkgs] of Object.entries(map)) {
            assert.equal(t.get(`${distro}:${cmd}`), pkgs, `${distro}:${cmd}`);
        }
    }
});

test('every install.sh row (after install time) is also in PACKAGE_MAP', () => {
    const INSTALL_TIME_ONLY = new Set(['node', 'npm', 'curl', 'xz']);
    for (const key of bashTable().keys()) {
        const [distro, cmd] = key.split(':');
        if (INSTALL_TIME_ONLY.has(cmd)) continue;
        assert.ok(PACKAGE_MAP[distro] && PACKAGE_MAP[distro][cmd], `missing from PACKAGE_MAP: ${key}`);
    }
});
