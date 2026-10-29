'use strict';

// lib/launch/launch-options.js — parsing the per-game launch options + building them into the command.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLaunchOptions, applyLaunchOptions, splitWords } = require('../../lib/launch/launch-options.js');

test('splitWords — quotes, escape only inside "..."; an unterminated quote is null', () => {
    assert.deepEqual(splitWords('a "b c" \'d e\' f"g h"'), ['a', 'b c', 'd e', 'fg h']);
    assert.deepEqual(splitWords('"a\\"b" "c\\\\d"'), ['a"b', 'c\\d']);
    assert.deepEqual(splitWords('  '), []);
    assert.equal(splitWords('a "b'), null);
    assert.deepEqual(splitWords('$HOME `x` *'), ['$HOME', '`x`', '*']); // no evaluation
});

test('parseLaunchOptions — env first, the other arguments; the env section ends at the first non-env word', () => {
    const r = parseLaunchOptions('MANGOHUD=1 FOO="a b" --fullscreen BAR=2');
    assert.equal(r.ok, true);
    assert.deepEqual(r.env, { MANGOHUD: '1', FOO: 'a b' });
    assert.deepEqual(r.args, ['--fullscreen', 'BAR=2']);
    assert.deepEqual(parseLaunchOptions('   '), { ok: true, env: {}, args: [], text: '' });
});

test('parseLaunchOptions — forbidden / bad input rejected', () => {
    for (const bad of ['LD_PRELOAD=/x', 'BASH_ENV=/x', 'PATH=/x', 'NODE_OPTIONS=--x', 'HOME=/x', 'XDG_DATA_HOME=/x', 'ELECTRON_RUN_AS_NODE=1', 'a=1']) {
        assert.equal(parseLaunchOptions(bad).ok, false, bad);
    }
    assert.equal(parseLaunchOptions('--a "b').error, 'unclosed-quote');
    assert.equal(parseLaunchOptions('x'.repeat(301)).error, 'too-long');
    assert.equal(parseLaunchOptions('--a\u0000b').error, 'control-chars');
    assert.equal(parseLaunchOptions(Array.from({ length: 25 }, (_, i) => `--a${i}`).join(' ')).error, 'too-many-args');
    assert.equal(parseLaunchOptions(Array.from({ length: 9 }, (_, i) => `E${i}X=1`).join(' ')).error, 'too-many-env');
    assert.equal(parseLaunchOptions(5).ok, false);
});

test('applyLaunchOptions — native: the extra arguments before the ROM (before the "--"), the env into the spawn env', () => {
    const r = applyLaunchOptions('pcsx2-qt', ['-batch', '--', '/r.iso'], '/r.iso', { env: { A: '1' }, args: ['-x'] });
    assert.deepEqual(r, { cmd: 'pcsx2-qt', args: ['-batch', '-x', '--', '/r.iso'], env: { A: '1' } });
    assert.deepEqual(applyLaunchOptions('emu', ['/r.iso'], '/r.iso', { args: ['-x'] }).args, ['-x', '/r.iso']);
    assert.deepEqual(applyLaunchOptions('emu', ['-a'], null, { args: ['-x'] }).args, ['-a', '-x']); // no ROM path: at the end
});

test('applyLaunchOptions — flatpak: the env --env= switch BEFORE the app-id, the extra argument AFTER the app-id', () => {
    const r = applyLaunchOptions('flatpak', ['run', 'net.pcsx2.PCSX2', '-batch', '/r.iso'], '/r.iso', { env: { A: '1' }, args: ['-x'] });
    assert.deepEqual(r, { cmd: 'flatpak', args: ['run', '--env=A=1', 'net.pcsx2.PCSX2', '-batch', '-x', '/r.iso'], env: {} });
    // even if the ROM path were (wrongly) before the app id, the extra still does not become a flatpak switch
    const odd = applyLaunchOptions('flatpak', ['run', 'app.id', '/r.iso'], '/r.iso', { args: ['-x'] });
    assert.ok(odd.args.indexOf('-x') >= 2);
});
