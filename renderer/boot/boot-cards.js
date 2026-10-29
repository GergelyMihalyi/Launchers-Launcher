// Puts the launcher icons into the skeleton's circle placeholders (preload `initialLauncherIcons`, get-boot-state) — runs BEFORE the first
// paint (a parser-blocking <script src> after #cards), following the carousel's initial layout: center = first launcher, right = second,
// left = last (N=2: center + right only, N=1: center only). Broken icon → removed. renderCards() overwrites #cards, which removes the icons
// too. An external file because of the CSP (see boot-theme.js); not part of the renderer bundle.
(function () {
    try {
        const L = /** @type {any} */ (window.launcher) || {};
        const icons = (L.initialLauncherIcons || []).filter((/** @type {unknown} */ s) => typeof s === 'string' && s);
        const n = icons.length;
        if (!n) return;
        const slots = document.querySelectorAll('#cards .card-skeleton .skeleton-icon');
        // slots: [left, center, right]
        const pick = [n >= 3 ? icons[n - 1] : null, icons[0], n >= 2 ? icons[1] : null];
        for (let i = 0; i < slots.length; i++) {
            if (!pick[i]) continue;
            const img = document.createElement('img');
            img.className = 'loader-icon';
            img.alt = '';
            img.style.setProperty('--i', String(i));
            img.onerror = function () { img.remove(); };
            img.src = pick[i];
            slots[i].appendChild(img);
        }
    } catch (e) { /* the skeleton is fine without an icon too */ }
})();
