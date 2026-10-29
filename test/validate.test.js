'use strict';

// lib/validate.js — the shared validators of payloads coming from the renderer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { str, oneOf, plainObject, primitiveMap, macAddress, flatpakAppId, arrayOf } = require('../lib/validate.js');

test('str — only a non-empty string of limited length', () => {
    assert.equal(str('abc'), 'abc');
    for (const bad of ['', 5, null, undefined, {}, ['a'], 'x'.repeat(301)]) assert.equal(str(bad), null);
    assert.equal(str('x'.repeat(301), 400), 'x'.repeat(301));
});

test('oneOf / plainObject', () => {
    assert.equal(oneOf('native', ['native', 'flatpak']), 'native');
    assert.equal(oneOf('bash', ['native', 'flatpak']), null);
    assert.equal(plainObject({ a: 1 }), true);
    for (const bad of [null, [], 'x', new Date(), Object.create(null)]) assert.equal(plainObject(bad), false);
});

test('primitiveMap — only primitive values, with key and length limits', () => {
    assert.deepEqual(primitiveMap({ a: 'x', b: 1, c: null, d: true, e: { n: 1 }, f: [1], g: NaN, h: 'y'.repeat(5000) }),
        { a: 'x', b: 1, c: null, d: true });
    assert.deepEqual(primitiveMap('not an object'), {});
    assert.equal(Object.keys(primitiveMap(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])))).length, 16);
});

test('macAddress — only the regular AA:BB:CC:DD:EE:FF shape', () => {
    assert.equal(macAddress('AA:bb:0C:dd:EE:ff'), 'AA:bb:0C:dd:EE:ff');
    for (const bad of ['', 'AA', '--help', 'AA:BB:CC:DD:EE', 'AA:BB:CC:DD:EE:FF:00', 'GG:BB:CC:DD:EE:FF', 5, null, {}]) assert.equal(macAddress(bad), null);
});

test('flatpakAppId — dot-separated identifier, not an option', () => {
    assert.equal(flatpakAppId('org.libretro.RetroArch'), 'org.libretro.RetroArch');
    assert.equal(flatpakAppId('com.valvesoftware.Steam'), 'com.valvesoftware.Steam');
    for (const bad of ['', 'steam', '--help', '-x.y', 'a b.c', 'a.b;c', 'org..x', 5, null, 'a.'.repeat(200)]) assert.equal(flatpakAppId(bad), null);
});

test('arrayOf — the valid items stay, a non-array is empty', () => {
    assert.deepEqual(arrayOf(['org.a.B', 'x', 5], flatpakAppId), ['org.a.B']);
    assert.deepEqual(arrayOf('not an array', flatpakAppId), []);
    assert.equal(arrayOf(Array.from({ length: 300 }, () => 'org.a.B'), flatpakAppId).length, 256);
    assert.equal(arrayOf(Array.from({ length: 10 }, () => 'org.a.B'), flatpakAppId, 3).length, 3);
});
