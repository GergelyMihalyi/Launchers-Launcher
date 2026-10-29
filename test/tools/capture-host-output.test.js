'use strict';

// tools/capture-host-output.js + the real samples in `test/fixtures/host-output/`.
// Today's parser runs on every distro/DE output recorded so far: a parser change that would break an
// older (or other-DE) format fails here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');
const { PROBES, FIXTURE_DIR, redact, redactMacs, redactNmcliSsids } = require('../../tools/capture-host-output.js');

const root = path.join(__dirname, '..', '..');

for (const probe of PROBES) {
    const dir = path.join(FIXTURE_DIR, probe.id);
    const samples = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.txt')) : [];
    for (const file of samples) {
        test(`${probe.id} / ${file} — the parser gives the recorded item count`, () => {
            const raw = fs.readFileSync(path.join(dir, file), 'utf8');
            const meta = JSON.parse(fs.readFileSync(path.join(dir, file.replace(/\.txt$/, '.json')), 'utf8'));
            const items = probe.parse(raw);
            assert.ok(items.length > 0, '0 items from a non-empty sample — the parser broke on a known format');
            assert.equal(items.length, meta.count);
        });
    }
}

test('there is at least one recorded sample (otherwise the check above is empty)', () => {
    const any = PROBES.some((p) => fs.existsSync(path.join(FIXTURE_DIR, p.id)));
    assert.ok(any);
});

test('every probe id also gets a format alert in the lib (checkParsed)', () => {
    const libSrc = listJsFiles(path.join(root, 'lib')).map((rel) => fs.readFileSync(path.join(root, 'lib', rel), 'utf8')).join('\n');
    const missing = PROBES.map((p) => p.id).filter((id) => !libSrc.includes(`checkParsed('${id}'`));
    assert.deepEqual(missing, [], 'checkParsed(...) is missing at the call site in the lib — or the probe id is misspelled');
});

test('redactMacs — deterministic pseudonym, upper/lower case is kept', () => {
    assert.equal(redactMacs('A AA:BB:CC:DD:EE:FF b aa:bb:cc:dd:ee:ff c 11:22:33:44:55:66'),
        'A 02:00:00:00:00:01 b 02:00:00:00:00:01 c 02:00:00:00:00:02');
});

test('redactNmcliSsids — the SSID (with \\:-escape too) gets a pseudonym, the other fields stay', () => {
    assert.equal(redactNmcliSsids('yes:Otthon\\:5G:80:WPA2\nno::30:\nno:Otthon\\:5G:10:WPA2'),
        'yes:Net-1:80:WPA2\nno::30:\nno:Net-1:10:WPA2');
});

test('redact — the BT device name and monitor serial number do not remain in the sample', () => {
    const bt = PROBES.find((p) => p.id === 'bluetoothctl-paired');
    assert.equal(redact(bt, 'Device AA:BB:CC:DD:EE:FF Zoë Müller headphones\n'), 'Device 02:00:00:00:00:01 Device-1\n');
    const mutter = PROBES.find((p) => p.id === 'mutter-state');
    assert.equal(redact(mutter, '[["DP-1","DEL","U2720Q","ABC123"]]'), '[["DP-1","DEL","U2720Q","REDACTED"]]');
});
