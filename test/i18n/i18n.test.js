'use strict';

// renderer/i18n/i18n.js — the `tr(key)` string table + fallback + interpolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tr, setActiveLanguage, I18N, currentTag } = require('../../renderer/i18n/i18n.js');

test('I18N — the hu and en key sets are the same (en does not extend beyond hu)', () => {
    const hu = Object.keys(I18N.hu).sort();
    const en = Object.keys(I18N.en).sort();
    // every en key has a hu one (because of the fallback); hu may be larger (not yet translated)
    for (const k of en) assert.ok(I18N.hu[k], `missing hu key: ${k}`);
    assert.ok(hu.length >= en.length);
});

test('tr — hu by default', () => {
    setActiveLanguage('hu');
    assert.equal(tr('bar.launch'), 'Indítás');
});

test('tr — English when en is the active language', () => {
    setActiveLanguage('en');
    assert.equal(tr('bar.launch'), 'Launch');
    assert.equal(tr('bar.power'), 'System');
    setActiveLanguage('hu');
});

test('tr — unknown language -> hu', () => {
    assert.equal(setActiveLanguage('de'), 'hu');
    assert.equal(setActiveLanguage(null), 'hu');
    assert.equal(setActiveLanguage(undefined), 'hu');
});

test('tr — missing key in the given language -> hu fallback, then the key itself', () => {
    setActiveLanguage('en');
    // add a hu-only key
    I18N.hu['__test.only'] = 'csak magyarul';
    assert.equal(tr('__test.only'), 'csak magyarul');
    delete I18N.hu['__test.only'];
    assert.equal(tr('no.such.key'), 'no.such.key');
    setActiveLanguage('hu');
});

test('tr — {param} interpolation', () => {
    I18N.hu['__test.count'] = '{n} elem, {unit}';
    assert.equal(tr('__test.count', { n: 3, unit: 'db' }), '3 elem, db');
    assert.equal(tr('__test.count', { n: 0, unit: 'x' }), '0 elem, x'); // 0 is printed too
    delete I18N.hu['__test.count'];
});

test('currentTag — without argument: "(AKTUÁLIS)" (tr(\'lang.current\'), in parentheses)', () => {
    setActiveLanguage('hu');
    assert.equal(currentTag(), `<span class="audio-current-tag">(${tr('lang.current')})</span>`);
});

test('currentTag — with text, without parens: raw text without parentheses', () => {
    assert.equal(currentTag('AKTÍV'), '<span class="audio-current-tag">AKTÍV</span>');
});

test('currentTag — { paren: true }: the raw text is parenthesized too', () => {
    assert.equal(currentTag('5 · 2h 15m', { paren: true }), '<span class="audio-current-tag">(5 · 2h 15m)</span>');
});

test('currentTag — HTML-escapes the text', () => {
    assert.equal(currentTag('<x>&"\''), '<span class="audio-current-tag">&lt;x&gt;&amp;&quot;&#39;</span>');
});
