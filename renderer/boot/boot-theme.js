// Flicker-free start: sets the ACTIVE theme's `data-theme` + `<link>` + the background BEFORE the first paint, from the preload's synchronous
// `initialTheme`/`initialBackground` (`get-boot-state`); idempotent with the later applyTheme/applyBackground calls. An EXTERNAL, synchronous
// `<script src>` in the <head> (so the CSP `script-src` needs no `'unsafe-inline'`); NOT part of the renderer bundle.
// Background: docs/dev/renderer/overview.md#boot-scripts-and-first-paint
(function () {
    try {
        const L = /** @type {any} */ (window.launcher) || {};
        const theme = L.initialTheme || 'neon';
        if (theme !== 'neon') {
            document.documentElement.setAttribute('data-theme', theme);
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'themes/' + theme + '.css';
            document.head.appendChild(link);
        }
        const entry = (L.initialBackground || {})[theme];
        let img = null;
        if (entry && entry.type === 'builtin' && entry.id) {
            img = 'url("assets/backgrounds/' + entry.id + '.svg")';
        } else if (entry && entry.type === 'custom' && entry.path) {
            img = 'url("file://' + entry.path.split('/').map(encodeURIComponent).join('/') + '")';
        }
        if (img) {
            // The #bgCustom element is in the <body> (not there yet) — painted ahead with a CSS rule; applyBackground() in
            // renderer/settings/settings-background.js empties this <style> as soon as it puts the real style on the element.
            /** @type {HTMLElement} */ (document.getElementById('__bootBg')).textContent =
                '#bgCustom{display:block;background-image:' + img + '}'
                + '#bgCustom::after{content:"";position:absolute;inset:0;'
                + 'background:linear-gradient(180deg,rgba(6,10,18,0.45) 0%,rgba(6,10,18,0.62) 100%)}';
        }
    } catch (e) { /* preload missing → the async path (renderer/main.js) takes over */ }
})();
