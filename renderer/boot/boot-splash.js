// Startup splash dismissal (index.html #bootSplash, styles/08-boot-splash.css): the logo's lift-off animation covers the screen until BOTH
// (1) the real launcher cards are drawn — renderCards() overwrites the #cards children, so the `.card-skeleton` placeholders disappear —
// and (2) the animation has played through (the `sp-total` animation on the root ends; it is `cancel`led when `data-motion="off"` /
// the accessibility setting turns the animations off — then the static logo goes away as soon as the cards are ready).
// An EXTERNAL, synchronous `<script src>` after #cards (the CSP has no `'unsafe-inline'`); NOT part of the renderer bundle. No coupling to
// the renderer code: the readiness is observed in the DOM.
(function () {
    const FADE_MS = 450;          // = the `.is-leaving` transition in styles/08-boot-splash.css
    const HARD_TIMEOUT_MS = 20000; // failsafe: a stuck start must not leave the splash up forever (the fatal overlay is above it anyway)
    try {
        const root = document.getElementById('bootSplash');
        const cards = document.getElementById('cards');
        if (!root || !cards) return;

        let animDone = false;
        let cardsReady = false;
        let leaving = false;

        function dismiss() {
            if (leaving) return;
            leaving = true;
            root.classList.add('is-leaving');
            // not `transitionend`: with data-motion="off" the transition is `none` and the event never comes
            setTimeout(function () { root.remove(); }, FADE_MS + 50);
        }
        function check() {
            if (animDone && cardsReady) dismiss();
        }

        root.addEventListener('animationend', function (e) {
            if (e.target === root && e.animationName === 'sp-total') { animDone = true; check(); }
        });
        root.addEventListener('animationcancel', function (e) {
            if (e.target === root && e.animationName === 'sp-total') { animDone = true; check(); }
        });

        // animations already off at the first style resolve (no `animationcancel` will ever come) → nothing to wait for
        if (getComputedStyle(root).animationName === 'none') animDone = true;

        function cardsDrawn() { return !cards.querySelector('.card-skeleton'); }
        const observer = new MutationObserver(function () {
            if (cardsDrawn()) { cardsReady = true; observer.disconnect(); check(); }
        });
        observer.observe(cards, { childList: true });

        setTimeout(dismiss, HARD_TIMEOUT_MS);
    } catch (e) { /* the splash is cosmetic — without it the skeleton is shown, as before */ }
})();
