'use strict';

// lib/log-lines.js — log-line levels + export.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, writeFile } = require('./helpers/fs.js');
const { classifyLogLine, exportLog, stampOf } = require('../lib/log-lines.js');

const TS = '[2026-09-25T10:00:00.000Z]';

test('classifyLogLine — the explicit ERROR/WARN marker wins', () => {
    assert.equal(classifyLogLine(`${TS} ERROR [renderer] x`).level, 'error');
    assert.equal(classifyLogLine(`${TS} WARN minden rendben`).level, 'warn');
    assert.equal(classifyLogLine(`${TS} WARN valami hiba`).level, 'warn', 'the marker is stronger than the keyword');
});

test('classifyLogLine — old lines without a marker by keyword', () => {
    assert.equal(classifyLogLine(`${TS} Játék lista hiba: ENOENT`).level, 'error');
    assert.equal(classifyLogLine(`${TS} A mentés sikertelen`).level, 'error');
    assert.equal(classifyLogLine(`${TS} spawn failed: x`).level, 'error');
    assert.equal(classifyLogLine(`${TS} [renderer] carousel: boom`).level, 'error');
    assert.equal(classifyLogLine(`${TS} TV-bekapcsolás kihagyva (missing CEC)`).level, 'warn');
    assert.equal(classifyLogLine(`${TS} [selftest] hiányzó parancs: kscreen-doctor`).level, 'warn');
    assert.equal(classifyLogLine(`${TS} auto-start is off — AA:BB skipped`).level, 'warn');
    assert.equal(classifyLogLine(`${TS} ERROR: gdbus is missing — the listener exits`).level, 'error');
    assert.equal(classifyLogLine(`${TS} cmd failed / did not run: x`).level, 'error');
    assert.equal(classifyLogLine(`${TS} [startup] appReady 180ms`).level, 'info');
    assert.equal(classifyLogLine(`${TS} Indítás: steam`).level, 'info');
    assert.equal(classifyLogLine(`${TS} [startup] appReady 180ms`).text, `${TS} [startup] appReady 180ms`);
    assert.equal(classifyLogLine(undefined).level, 'info');
});

test('stampOf — local time, for the file name', () => {
    assert.equal(stampOf(new Date(2026, 8, 25, 14, 3, 12)), '2026-09-25_140312');
});

test('exportLog — header + .1 + current + extra logs, the missing one is dropped', async () => {
    const dir = tmpDir();
    const logFile = writeFile(dir, 'launchers-launcher.log', 'uj sor\n');
    writeFile(dir, 'launchers-launcher.log.1', 'regi sor\n');
    const watcher = writeFile(dir, 'watcher.log', 'watcher sor\n');
    const dest = tmpDir();
    const res = await exportLog({
        logFile, extraLogs: [watcher, path.join(dir, 'missing.log')], header: ['Launchers Launcher 1.2.3'],
        destDir: dest, now: new Date(2026, 8, 25, 14, 3, 12),
    });
    assert.equal(res.ok, true);
    assert.equal(res.file, path.join(dest, 'launchers-launcher-log-2026-09-25_140312.txt'));
    const text = fs.readFileSync(res.file, 'utf8');
    assert.ok(text.startsWith('Launchers Launcher 1.2.3\n'));
    const order = ['=== launchers-launcher.log.1 ===', 'regi sor', '=== launchers-launcher.log ===', 'uj sor', '=== watcher.log ===', 'watcher sor'];
    let last = -1;
    for (const part of order) {
        const at = text.indexOf(part);
        assert.ok(at > last, `order: ${part}`);
        last = at;
    }
    assert.ok(!text.includes('missing.log'));
    assert.equal(res.bytes, Buffer.byteLength(text));
});

test('exportLog — unwritable target: ok:false, does not throw', async () => {
    const res = await exportLog({ logFile: '/missing/log', destDir: path.join(tmpDir(), 'missing', 'ilyen') });
    assert.equal(res.ok, false);
});

const { readLogTail } = require('../lib/log-lines.js');

test('readLogTail — no file → []; small file → the last N non-empty lines, with level', async () => {
    const dir = tmpDir('gl-logtail-');
    assert.deepEqual(await readLogTail(path.join(dir, 'missing.log')), []);
    const file = writeFile(dir, 'a.log', '[t] one\n\n[t] ERROR two\n[t] three\n');
    assert.deepEqual((await readLogTail(file, { maxLines: 2 })).map((l) => [l.text, l.level]),
        [['[t] ERROR two', 'error'], ['[t] three', 'info']]);
});

test('readLogTail — reads only the end of the file; the truncated first line is dropped', async () => {
    const dir = tmpDir('gl-logtail-');
    const lines = Array.from({ length: 200 }, (_, i) => `[t] sor-${String(i).padStart(3, '0')}`);
    const file = writeFile(dir, 'b.log', `${lines.join('\n')}\n`);
    const out = await readLogTail(file, { maxLines: 500, maxBytes: 100 });
    assert.ok(out.length > 0 && out.length < 10);
    for (const l of out) assert.match(l.text, /^\[t\] sor-\d{3}$/, 'no truncated line');
    assert.equal(out[out.length - 1].text, '[t] sor-199');
});
