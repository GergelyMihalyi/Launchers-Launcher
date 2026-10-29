#!/usr/bin/env node
'use strict';

// Captures the REAL output of external commands as test fixtures.
//
// Why: the launcher's parsers (`pactl`, `kscreen-doctor`, Mutter `busctl`, `nmcli`, `bluetoothctl`,
// `flatpak`) can silently break on a distro/DE upgrade (the output format changes, the parser
// returns an empty list). The captured samples go under `test/fixtures/host-output/<probe>/<label>.txt`,
// and `test/tools/capture-host-output.test.js` runs the parser on EACH of them — so a parser
// change is checked against every distro output seen so far.
//
// Usage (on the machine, from the graphical session — Mutter/kscreen need the session bus):
//   node tools/capture-host-output.js            → capture (label: <os-id>-<version>-<DE>, e.g. debian-13-gnome)
//   node tools/capture-host-output.js --dry-run  → only print what the parser found
//   node tools/capture-host-output.js --label x  → custom label
// After a distro/DE upgrade: run it, check the warnings, commit the new samples.
//
// PRIVACY: the samples go into the repo, so capturing anonymizes — MAC addresses, Wi-Fi SSIDs,
// BT device names and monitor/sound card serials are replaced by aliases. Review the diff before committing.
// The commands and the environment (LC_ALL) MATCH the calls in lib — if they change there, update them here too.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'host-output');

const { parseSinks, parseMonitors, parsePairedMacs } = require('../lib/parse.js');
const { parseMutterState } = require('../lib/output/displays-gnome.js');
const { parseWifiList } = require('../lib/network/wifi.js');
const { parseFlatpakInstalledApps, parseFlatpakPermissions } = require('../lib/flatpak.js');

const MUTTER = 'org.gnome.Mutter.DisplayConfig';

/**
 * @typedef {Object} Probe
 * @property {string} id also the `checkParsed` id in `lib/host-deps/format-drift.js`
 * @property {string} cmd
 * @property {string[]} args
 * @property {Record<string, string>} [env]
 * @property {'kde' | 'gnome'} [desktop] capture only on this DE
 * @property {(stdout: string) => any[]} parse
 * @property {(stdout: string) => string} [redact] runs AFTER the shared MAC anonymization
 */

/** @type {Probe[]} */
const PROBES = [
    {
        id: 'pactl-sinks', cmd: 'pactl', args: ['list', 'sinks'], env: { LC_ALL: 'C' },
        parse: (s) => parseSinks(s, ''),
        redact: (s) => s.replace(/^(\s*[\w.-]*serial[\w.-]* = )".*"$/gim, '$1"REDACTED"'),
    },
    {
        id: 'kscreen-doctor', cmd: 'kscreen-doctor', args: ['-j'], desktop: 'kde',
        parse: (s) => parseMonitors(JSON.parse(s)),
        redact: (s) => s.replace(/("serial"\s*:\s*)"[^"]*"/g, '$1"REDACTED"'),
    },
    {
        id: 'mutter-state', cmd: 'busctl', desktop: 'gnome', env: { LC_ALL: 'C' },
        args: ['--user', '--json=short', 'call', MUTTER, '/org/gnome/Mutter/DisplayConfig', MUTTER, 'GetCurrentState'],
        parse: (s) => parseMutterState(JSON.parse(s)).monitors,
        // the monitor spec `(connector, vendor, product, serial)` — the 4th item is the serial
        redact: (s) => s.replace(/\["([^"]+)","([^"]*)","([^"]*)","[^"]*"\]/g, '["$1","$2","$3","REDACTED"]'),
    },
    {
        // `--rescan no`: capturing should not wait for a fresh scan (the format is the same)
        id: 'nmcli-wifi', cmd: 'nmcli', env: { LC_ALL: 'C.UTF-8' },
        args: ['-t', '-f', 'ACTIVE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no'],
        parse: parseWifiList,
        redact: redactNmcliSsids,
    },
    {
        id: 'bluetoothctl-paired', cmd: 'bluetoothctl', args: ['devices', 'Paired'],
        parse: parsePairedMacs,
        redact: (s) => {
            let n = 0;
            return s.replace(/^(Device \S+ ).*$/gm, (_, head) => `${head}Device-${++n}`);
        },
    },
    {
        id: 'flatpak-list', cmd: 'flatpak', args: ['list', '--app', '--columns=application,name'],
        parse: parseFlatpakInstalledApps,
    },
    {
        // the actual permissions of an installed app (preferably an emulator) — lib/launchers/rom-access.js
        id: 'flatpak-permissions', cmd: 'flatpak', args: ['info', '--show-permissions'],
        resolveArgs: () => {
            const app = pickFlatpakApp();
            return app ? ['info', '--show-permissions', app] : null;
        },
        parse: (s) => parseFlatpakPermissions(s).sections,
        redact: (s) => s.replace(/\/(home|run\/media|media)\/[^/;\s]+/g, '/$1/USER'),
    },
];

// Target of the `flatpak-permissions` probe: the first installed emulator from the catalog, otherwise the first app.
function pickFlatpakApp() {
    let apps = [];
    try {
        apps = execFileSync('flatpak', ['list', '--app', '--columns=application'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n').map((l) => l.trim()).filter((l) => l.includes('.'));
    } catch (err) {
        return null;
    }
    const catalog = require('../data/launcher-catalog.json');
    const known = new Set(catalog.map((e) => e.flathubId).filter(Boolean));
    return apps.find((a) => known.has(a)) || apps[0] || null;
}

/** MAC addresses → deterministic alias (`02:00:00:00:00:01` …), keeping the letter case. */
function redactMacs(text) {
    const map = new Map();
    return text.replace(/\b([0-9A-Fa-f]{2})(([:-])[0-9A-Fa-f]{2}){5}\b/g, (mac) => {
        const key = mac.toUpperCase();
        if (!map.has(key)) map.set(key, map.size + 1);
        const n = map.get(key).toString(16).padStart(2, '0');
        const out = `02:00:00:00:00:${n}`;
        return mac === mac.toLowerCase() ? out.toLowerCase() : out.toUpperCase();
    });
}

/** `nmcli -t` lines: the 2nd field (SSID, with `\:` escapes) → `Net-N` (same SSID → same alias). */
function redactNmcliSsids(text) {
    const map = new Map();
    return text.split('\n').map((line) => {
        const m = line.match(/^([^:]*):((?:\\.|[^:\\])*):(.*)$/);
        if (!m || !m[2]) return line;
        if (!map.has(m[2])) map.set(m[2], `Net-${map.size + 1}`);
        return `${m[1]}:${map.get(m[2])}:${m[3]}`;
    }).join('\n');
}

/** @param {Probe} probe @param {string} raw */
function redact(probe, raw) {
    const macFree = redactMacs(raw);
    return probe.redact ? probe.redact(macFree) : macFree;
}

function osLabel() {
    let id = 'linux';
    let ver = '';
    try {
        const osr = fs.readFileSync('/etc/os-release', 'utf8');
        id = (osr.match(/^ID=("?)([^"\n]*)\1$/m) || [])[2] || id;
        ver = (osr.match(/^VERSION_ID=("?)([^"\n]*)\1$/m) || [])[2] || '';
    } catch { /* no os-release */ }
    const { desktopEnv } = require('../lib/desktop-env.js');
    return [id, ver, desktopEnv()].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9.-]/g, '');
}

function parseArgs(argv) {
    const o = { dryRun: false, label: '' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dry-run') o.dryRun = true;
        else if (argv[i] === '--label') o.label = argv[++i] || '';
    }
    return o;
}

function main() {
    const o = parseArgs(process.argv.slice(2));
    const label = o.label || osLabel();
    const { desktopEnv } = require('../lib/desktop-env.js');
    const de = desktopEnv();
    let suspicious = 0;
    for (const probe of PROBES) {
        if (probe.desktop && probe.desktop !== de) {
            process.stdout.write(`- ${probe.id}: skipped (only ${probe.desktop})\n`);
            continue;
        }
        const args = probe.resolveArgs ? probe.resolveArgs() : probe.args;
        if (!args) {
            process.stdout.write(`- ${probe.id}: skipped (nothing to query)\n`);
            continue;
        }
        let raw;
        try {
            raw = execFileSync(probe.cmd, args, {
                env: { ...process.env, ...(probe.env || {}) }, encoding: 'utf8', timeout: 15000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch (err) {
            process.stdout.write(`- ${probe.id}: the command did not run (${err.code || err.status || err.message})\n`);
            continue;
        }
        let count;
        try { count = probe.parse(raw).length; } catch (err) { count = -1; process.stdout.write(`  parser error: ${err.message}\n`); }
        const bad = raw.trim() && count <= 0;
        if (bad) suspicious++;
        process.stdout.write(`${bad ? '! ' : '✓ '}${probe.id}: ${raw.length} bytes → ${count} items${bad ? '  ← THE FORMAT MAY HAVE CHANGED' : ''}\n`);
        if (o.dryRun || !raw.trim()) continue;
        const dir = path.join(FIXTURE_DIR, probe.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${label}.txt`), redact(probe, raw));
        fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify({ count, capturedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
    }
    if (!o.dryRun) process.stdout.write(`\nRecorded: test/fixtures/host-output/*/${label}.txt — review the diff (anonymisation), then npm test.\n`);
    if (suspicious) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { PROBES, FIXTURE_DIR, redact, redactMacs, redactNmcliSsids, osLabel };
