'use strict';

// The startup splash (the logo's lift-off animation): index.html #bootSplash + styles/08-boot-splash.css + renderer/boot/boot-splash.js.
// Source-level contract tests — the animation itself is visual (see docs/dev/renderer/home.md "Startup splash").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const html = read('index.html');
const markup = html.replace(/<!--[\s\S]*?-->/g, ''); // without comments (they mention the file names too)
const css = read('styles/08-boot-splash.css');
const js = read('renderer/boot/boot-splash.js');

test('the logo files exist (SVGs + the 512 px PNG for the window icon)', () => {
    for (const f of ['logo.svg', 'logo-wordmark.svg', 'logo-512.png']) {
        assert.ok(fs.existsSync(path.join(root, 'assets', 'logo', f)), `missing: assets/logo/${f}`);
    }
    assert.match(read('assets/logo/logo.svg'), /^<svg /);
});

test('index.html — the splash is the first element of <body>, released by boot-splash.js loaded AFTER #cards, the CSS is linked', () => {
    assert.match(html, /<body>\s*(<!--[\s\S]*?-->\s*)?<div class="boot-splash" id="bootSplash" aria-hidden="true">/);
    assert.ok(markup.indexOf('renderer/boot/boot-cards.js') < markup.indexOf('renderer/boot/boot-splash.js'));
    assert.ok(markup.indexOf('id="cards"') < markup.indexOf('renderer/boot/boot-splash.js'), 'it watches #cards → afterwards');
    assert.match(html, /<link rel="icon" [^>]*href="assets\/logo\/logo\.svg">/);
    assert.match(html, /<title>Launchers Launcher<\/title>/);
});

test('the splash base style is the END IMAGE (data-motion="off" → static logo); the animations only give the `from` state', () => {
    // every keyframes block of the lift-off has no `to` state except the explicit end poses (sp-total/sp-shake/sp-flicker/sp-flame/sp-streak)
    assert.match(css, /\.sp-rocket \{\s*transform: translate\(167px, 164px\) scale\(1\.5\);/);
    assert.match(css, /\.sp-world \{\s*transform: translate\(176\.5px, 782px\);/); // the controller is OUT of the final frame (y > 720)
    for (const name of ['sp-lift', 'sp-world', 'sp-text', 'sp-puff', 'sp-glow', 'sp-in']) {
        const block = css.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`))[0];
        assert.doesNotMatch(block, /\bto\b|100%/, `${name}: the end state is the base style, there is no 'to'`);
    }
});

test('the splash z-index: ABOVE the screensaver (300), BELOW the brightness filters (350) and the error overlay (400)', () => {
    const z = Number(css.match(/\.boot-splash \{[^}]*z-index: (\d+)/)[1]);
    assert.ok(z > 300 && z < 350, String(z));
});

test('the splash CSS timing is consistent with the boot script (sp-total, the fade duration)', () => {
    assert.match(css, /animation: sp-total 3\.4s linear;/);
    assert.match(css, /\.is-leaving \{[^}]*transition: opacity 0\.45s/);
    assert.match(js, /FADE_MS = 450/);
    assert.match(js, /'sp-total'/);
    // the longest part of the timeline (the last lettering: delay + duration) must not exceed the master animation
    const m = css.match(/\.sp-text-2 \{\s*animation-delay: ([\d.]+)s;\s*animation-duration: ([\d.]+)s;/);
    assert.ok(Number(m[1]) + Number(m[2]) <= 3.4 + 1e-9, 'the caption finishes before sp-total');
});

test('boot-splash.js — no inline script (CSP), not part of the bundle, animationcancel is handled too (data-motion="off")', () => {
    assert.doesNotMatch(markup, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline <script>');
    assert.match(js, /animationcancel/);
    assert.match(js, /MutationObserver/);
});
