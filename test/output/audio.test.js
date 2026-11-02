'use strict';

// `applyStartupSink` / `waitForStartupSink` against a fake `pactl` on PATH (the sink "appears" later, like the TV's
// HDMI sink after the CEC power-on). PACTL_OPTS copies `process.env` at require time → PATH is set BEFORE the require.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('../helpers/fs.js');

const dir = tmpDir('fake-pactl-');
const stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir);
fs.writeFileSync(path.join(dir, 'pactl'), `#!/bin/bash
S="${stateDir}"
case "$1 $2" in
    "list sinks") for n in $(cat "$S/sinks"); do printf 'Sink #1\\n\\tName: %s\\n\\tDescription: %s\\n' "$n" "$n"; done ;;
    "get-default-sink ") cat "$S/default" ;;
    "set-default-sink "*) printf '%s' "$2" > "$S/default" ;;
    "list short") ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${dir}:${process.env.PATH}`;
const audio = require('../../lib/output/audio.js');

const TV = 'alsa_output.hdmi-tv';
const setSinks = (names) => fs.writeFileSync(path.join(stateDir, 'sinks'), names.join('\n'));
const setDefault = (name) => fs.writeFileSync(path.join(stateDir, 'default'), name);
const getDefault = () => fs.readFileSync(path.join(stateDir, 'default'), 'utf8');
const fakeLog = () => { const lines = []; const f = (m) => lines.push(m); f.lines = lines; return f; };

test('applyStartupSink: present → applied, absent → false and the default is unchanged', async () => {
    setSinks(['speakers', TV]); setDefault('speakers');
    assert.equal(await audio.applyStartupSink(TV), true);
    assert.equal(getDefault(), TV);

    setSinks(['speakers']); setDefault('speakers');
    const log = fakeLog();
    assert.equal(await audio.applyStartupSink(TV, log), false);
    assert.equal(getDefault(), 'speakers');
    assert.match(log.lines[0], /unavailable/);
});

test('waitForStartupSink: switches once the sink appears', async () => {
    setSinks(['speakers']); setDefault('speakers');
    const log = fakeLog();
    let rounds = 0;
    const sleep = async () => { rounds += 1; if (rounds === 3) setSinks(['speakers', TV]); };
    assert.equal(await audio.waitForStartupSink(TV, log, { intervalMs: 1, tries: 10, sleep }), true);
    assert.equal(rounds, 3, 'stops polling as soon as it appears');
    assert.equal(getDefault(), TV);
    assert.match(log.lines.at(-1), /appeared after 3 check/);
});

test('waitForStartupSink: gives up after `tries` and leaves the output alone', async () => {
    setSinks(['speakers']); setDefault('speakers');
    const log = fakeLog();
    let rounds = 0;
    const sleep = async () => { rounds += 1; };
    assert.equal(await audio.waitForStartupSink(TV, log, { intervalMs: 1, tries: 4, sleep }), false);
    assert.equal(rounds, 4);
    assert.equal(getDefault(), 'speakers');
    assert.match(log.lines.at(-1), /did not appear/);
});

test('waitForStartupSink: a default-sink change by someone else cancels the wait', async () => {
    setSinks(['speakers', 'headset']); setDefault('speakers');
    const log = fakeLog();
    let rounds = 0;
    const sleep = async () => { rounds += 1; if (rounds === 2) setDefault('headset'); };
    assert.equal(await audio.waitForStartupSink(TV, log, { intervalMs: 1, tries: 10, sleep }), false);
    assert.equal(rounds, 2);
    assert.equal(getDefault(), 'headset', 'the user\'s choice is not overridden');
    assert.match(log.lines.at(-1), /cancelled/);
});

test('waitForStartupSink: no name → no-op', async () => {
    assert.equal(await audio.waitForStartupSink('', fakeLog(), { tries: 3, sleep: async () => {} }), false);
});
