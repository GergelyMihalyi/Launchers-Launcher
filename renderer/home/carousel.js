// Launcher picker carousel: the cards are absolutely positioned; a ring offset measured from the focused card (short way, with wrap-around)
// decides their place and visibility. There are always 3 cards in the middle zone. Load order: after util.js (esc / FALLBACK_ICON).
//
// `ringOffset` / `carouselPosName` are pure math — module.exports guard at the bottom of the file (test/home/carousel.test.js).
// `launchers` / `cards` / `focusedIndex` are the shared base state of the renderer, declared here (main.js / gamepad.js / ipc.js refer
// to them too).

// `launchers` (the launcher list from the main process over IPC) + `recentBarFocus` (quick-launch bar focus) are written from SEVERAL
// files → renderer/state.js. The launchers live in the `customLaunchers` config key.
let cards = [];
let focusedIndex = 0;
let cardEntries = []; // [...launchers, GAMES_CARD] — the current input of renderCards() (read by the quick-launch bar)

let cardPrevOffset = new Map(); // id -> last offset (for wrap-teleport detection)

// The carousel always gets a fixed "Games" pseudo-launcher card at the end of the list — NOT spawnable (no `cmd`/`args`), and DELIBERATELY
// not in the `launchers` global (only `renderCards()` adds it), because that is the shared base of the Launchers / Launcher order subviews.
// gamepad.js `launchApp()` calls `openGamesPanel()` for GAMES_CARD_ID instead of `window.launcher.launch()`.
const GAMES_CARD_ID = '__games__';
const GAMES_CARD = {
    id: GAMES_CARD_ID,
    name: 'Games',
    hint: 'Steam / Heroic / RetroArch',
    icon: 'assets/icons/games.svg',
};

// The x offset of the positions is computed at runtime from the card's ACTUAL width (from CSS, vh-based, see styles/*.css) - no second
// size constant duplicated in JS. CSS stays the single source of the card size.
function computeCarouselPos(baseWidth) {
    return {
        center: { x: 0, s: 1, o: 1, z: 4 },
        left: { x: -baseWidth * 0.71, s: 0.66, o: 0.4, z: 3 },
        right: { x: baseWidth * 0.71, s: 0.66, o: 0.4, z: 3 },
        'far-left': { x: -baseWidth * 1.25, s: 0.5, o: 0, z: 1 },
        'far-right': { x: baseWidth * 1.25, s: 0.5, o: 0, z: 1 },
    };
}

// The card's intrinsic (unscaled) width: getComputedStyle returns the CSS `width` property, transform: scale(...) does not change it (only
// the visual size through getBoundingClientRect) - so every card (the focused one and the shrunk outer ones) gives the same base width.
function measureCardWidth() {
    if (!cards.length) return 480;
    return parseFloat(getComputedStyle(cards[0]).width) || 480;
}

// Per-launcher accent color: the `accent` (#rrggbb) field of customLaunchers gives the border / glow / name color of the focused card
// through the `--card-accent` CSS variable (styles/*.css: var(--card-accent, var(--accent))). It MUST be validated, since it is
// interpolated straight into the style attribute. The flat themes (win31 / oled) reset it to the theme accent with an `!important` rule.
const ACCENT_RE = /^#[0-9a-f]{6}$/i;
function cardAccent(l) {
    return l && ACCENT_RE.test(l.accent || '') ? l.accent : null;
}

function ringOffset(i, focused, n) {
    let d = ((i - focused) % n + n) % n; // 0..n-1
    if (d > n / 2) d -= n;               // the short way, signed
    return d;
}

function carouselPosName(off) {
    if (off === 0) return 'center';
    if (off === -1) return 'left';
    if (off === 1) return 'right';
    return off < 0 ? 'far-left' : 'far-right';
}

// The parallax amount: .card-bg moves opposite to the card's x offset by this FRACTION → the blur layer "lags behind" (sense of depth).
const CARD_BG_PARALLAX = 0.1;

function setCardPos(card, off, pos) {
    const p = pos[carouselPosName(off)];
    card.style.transform = `translate(-50%, -50%) translateX(${p.x}px) scale(${p.s})`;
    card.style.opacity = p.o;
    card.style.zIndex = p.z;
    card.style.pointerEvents = off === 0 ? 'auto' : 'none';
    card.classList.toggle('focused', off === 0);
    const bg = card.querySelector('.card-bg');
    if (bg) bg.style.transform = `translateX(${-p.x * CARD_BG_PARALLAX}px)`;
}

// Callable from outside too (window resize, e.g. a TV-mode resolution change) - every call measures the card width fresh, so the spacing
// always fits the current screen size.
function layoutCarousel() {
    const n = cards.length;
    if (!n) return;
    const pos = computeCarouselPos(measureCardWidth());
    cards.forEach((card, i) => {
        const off = ringOffset(i, focusedIndex, n);
        const key = card.dataset.app;
        const prev = cardPrevOffset.get(key);
        cardPrevOffset.set(key, off);
        // If the card "flips over" the short way (e.g. from the left edge to the right edge), first jump it without animation to an off-screen
        // point on the target side, then slide it there from the next frame - so it spins around instead of swooshing through the middle.
        if (prev !== undefined && Math.abs(off - prev) > 1) {
            const sign = off < 0 ? -1 : 1;
            const teleportX = sign * Math.abs(pos['far-left'].x) * 1.12;
            card.classList.add('no-anim');
            card.style.transform = `translate(-50%, -50%) translateX(${teleportX}px) scale(0.5)`;
            card.style.opacity = 0;
            void card.offsetWidth; // reflow: let the teleport happen now
            requestAnimationFrame(() => {
                card.classList.remove('no-anim');
                void card.offsetWidth; // let re-enabling the transition take effect
                // fresh offset + fresh positions (must not slip during fast consecutive navigation / a resize in between)
                if (cards[i]) setCardPos(cards[i], ringOffset(i, focusedIndex, cards.length), computeCarouselPos(measureCardWidth()));
            });
        } else {
            setCardPos(card, off, pos);
        }
    });
}

// "Favorite" badge: based on the `usage` field (added to every launcher by main's `launchersWithUsage()`), the MOST launched launcher
// gets a "★ FAVORITE" badge - only if it was launched at least 2x (a single launch does not count as a "favorite") AND it is unambiguous
// (no tie on the highest count, otherwise it could not be decided which card gets it). A passive badge - it does not reorder the cards.
function favoriteLauncherId(entries) {
    let best = null;
    let tie = false;
    for (const l of entries) {
        const count = l.usage?.count || 0;
        if (count < 2) continue;
        if (!best || count > best.usage.count) {
            best = l;
            tie = false;
        } else if (count === best.usage.count) {
            tie = true;
        }
    }
    return best && !tie ? best.id : null;
}

// "Continue": the carousel's INITIAL focus is on the card of the most recently launched launcher (the biggest `usage.lastLaunchedAt`), so
// the user quickly gets back to what they are playing. It does NOT reorder the cards (the fixed card position matters on the kiosk) and
// only acts on the first render (called by main.js initLaunchers()). No `lastLaunchedAt` anywhere → 0. On a tie the one earlier in the
// list wins.
function mostRecentLauncherIndex(entries) {
    let bestIdx = 0;
    let bestAt = 0;
    entries.forEach((l, i) => {
        const at = Date.parse(l.usage?.lastLaunchedAt) || 0; // ISO string → ms; missing/bad → NaN → 0
        if (at > bestAt) {
            bestAt = at;
            bestIdx = i;
        }
    });
    return bestIdx;
}

// The press-hint verb: the "Games" pseudo card OPENS, an already running launcher SWITCHES (no new instance, we only jump to its window),
// everything else LAUNCHES.
function pressHintVerb(l) {
    if (l.id === GAMES_CARD_ID) return tr('verb.open');
    return l.running ? tr('verb.switch') : tr('verb.launch');
}

// The name of the "Games" pseudo card goes through `tr()` (GAMES_CARD.name is the no-JS fallback).
function cardName(l) {
    return l.id === GAMES_CARD_ID ? tr('games.card') : l.name;
}

// The card's screen-reader label: name + description + the badge texts.
function cardAriaLabel(l, isFavorite) {
    return [cardName(l), l.hint, l.running ? tr('card.running') : '', isFavorite ? tr('card.favorite') : '']
        .filter(Boolean).join(', ');
}

// The "pixel-art" effect of launcher icons in the pixel-rpg theme. The pure CSS trick (small size + scale + `image-rendering: pixelated`)
// was unreliable (Chromium redraws the vector source at the final resolution) — so the icon is drawn onto a small <canvas>
// (PIXEL_ICON_GRID²) and the data URL made FROM IT goes onto the <img>, scaled up with `pixelated` (themes/pixel-rpg.css `.app-icon`). Only
// runs with the active `pixel-rpg` theme; otherwise `img.src` is the original (`data-icon-src`). Cached per icon (`pixelIconCache`).
const PIXEL_ICON_GRID = 12;
const pixelIconCache = new Map(); // original icon path -> pixelated data URL

function pixelateIconUrl(src, cb) {
    if (typeof Image === 'undefined') { cb(null); return; }
    const cached = pixelIconCache.get(src);
    if (cached) { cb(cached); return; }
    try {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = PIXEL_ICON_GRID;
                canvas.height = PIXEL_ICON_GRID;
                const ctx = canvas.getContext('2d');
                const nw = img.naturalWidth || PIXEL_ICON_GRID;
                const nh = img.naturalHeight || PIXEL_ICON_GRID;
                const scale = Math.min(PIXEL_ICON_GRID / nw, PIXEL_ICON_GRID / nh) || 1;
                const w = nw * scale;
                const h = nh * scale;
                ctx.clearRect(0, 0, PIXEL_ICON_GRID, PIXEL_ICON_GRID);
                ctx.drawImage(img, (PIXEL_ICON_GRID - w) / 2, (PIXEL_ICON_GRID - h) / 2, w, h);
                const dataUrl = canvas.toDataURL('image/png');
                pixelIconCache.set(src, dataUrl);
                cb(dataUrl);
            } catch (e) { cb(null); }
        };
        img.onerror = () => cb(null);
        img.src = src;
    } catch (e) { cb(null); }
}

// Applies (or reverts) the pixelation on a launcher card's <img class="app-icon"> by the CURRENT theme. `renderCards()` calls it on the
// fresh DOM; `applyTheme()` of `settings-theme.js` on the EXISTING cards through `refreshIconPixelation()` (live theme switch in Settings -
// no full renderCards() just for this).
function pixelateCardIcon(img) {
    const src = img.dataset ? img.dataset.iconSrc : null;
    if (!src) return;
    const pixelTheme = document.documentElement.dataset.theme === 'pixel-rpg';
    if (!pixelTheme) {
        if (img.src !== src) img.src = src;
        return;
    }
    pixelateIconUrl(src, (dataUrl) => {
        if (dataUrl && document.documentElement.dataset.theme === 'pixel-rpg') img.src = dataUrl;
    });
}

function refreshIconPixelation() {
    document.querySelectorAll('.app-icon').forEach(pixelateCardIcon);
}

// (Re)renders the cards from the `launchers` array + the fixed GAMES_CARD at the end. `launchers-changed` (an order change in Settings)
// calls it too - the focus returns to the previously focused launcher by id (fallback: `default`, then 0).
function renderCards() {
    const entries = [...launchers, GAMES_CARD];
    cardEntries = entries;
    const favoriteId = favoriteLauncherId(entries);
    const prevId = cards.length ? cards[focusedIndex]?.dataset.app : null;
    $('cards').innerHTML = entries.map((l) => `
        <div class="card" data-app="${esc(l.id)}" role="button" aria-label="${esc(cardAriaLabel(l, l.id === favoriteId))}"${cardAccent(l) ? ` style="--card-accent:${cardAccent(l)}"` : ''}>
            <img src="${esc(l.icon)}" alt="" aria-hidden="true" class="card-bg">
            ${l.running ? `<div class="card-running">${esc(tr('card.running'))}</div>` : ''}
            ${l.id === favoriteId ? `<div class="card-badge">${esc(tr('card.favorite'))}</div>` : ''}
            <div class="card-icon">
                <img src="${esc(l.icon)}" data-icon-src="${esc(l.icon)}" alt="${esc(cardName(l))}" class="app-icon">
            </div>
            <div class="card-name">${esc(cardName(l))}</div>
            <div class="card-hint">${esc(l.hint)}</div>
            <div class="press-hint">[ ${btnGlyph('confirm')} ] ${pressHintVerb(l)}</div>
        </div>
    `).join('');

    cards = Array.from(document.querySelectorAll('.card'));
    cards.forEach((card) => {
        const img = /** @type {HTMLImageElement|null} */ (card.querySelector('img.app-icon'));
        if (img) {
            img.addEventListener('error', () => { img.src = FALLBACK_ICON; }, { once: true });
            pixelateCardIcon(img);
        }
        // Blurred background icon: missing image -> just hide it (a broken/fallback icon blurred would add nothing).
        const bg = /** @type {HTMLImageElement|null} */ (card.querySelector('img.card-bg'));
        if (bg) bg.addEventListener('error', () => { bg.style.display = 'none'; }, { once: true });
    });
    let idx = prevId ? entries.findIndex((l) => l.id === prevId) : -1;
    if (idx < 0) idx = entries.findIndex((l) => l.default);
    focusedIndex = Math.max(0, idx);
    // The bar focus is only kept if the same launcher stayed focused AND there are still enough items (the recentGames list may have been
    // refreshed) - otherwise back to the card.
    if (recentBarFocus >= 0 && !(prevId && entries[focusedIndex]?.id === prevId
        && recentBarFocus < focusedRecentGames().length)) {
        recentBarFocus = -1;
    }
    cardPrevOffset.clear();
    layoutCarousel();
    renderRecentBar();
    renderContinueBar();
    updateCarouselPeek();
}

// running-changed (main-side 4 s poller, ONLY on an actual change — or the bringToFront / retroarch-thumbnail-fetch / heroic
// recordRecentGame push): refreshes the "● RUNNING" badges and the (derived) quick-launch bar from the fresh `launchers` payload, WITHOUT a
// full `renderCards()` (innerHTML swap + `layoutCarousel` + reloading the lazy covers). The launcher COUNT does not change on
// running-changed, so the card DOM + `focusedIndex` stay valid; if it does differ (add/remove meanwhile), the caller falls back to
// `renderCards()`.
function refreshRunningState() {
    cardEntries = [...launchers, GAMES_CARD]; // focusedRecentGames() reads from this
    for (const card of cards) {
        const l = launchers.find((x) => x.id === card.dataset.app);
        const badge = card.querySelector('.card-running');
        if (l && l.running && !badge) {
            const el = document.createElement('div');
            el.className = 'card-running';
            el.textContent = tr('card.running');
            card.appendChild(el);
        } else if ((!l || !l.running) && badge) {
            badge.remove();
        }
    }
    renderRecentBar();
}

// Edge "peek" arrows: only visible if there are more cards than fit the 3-card window at once (center + left + right) - so there really is
// "more" to the side. (GAMES_CARD counts too; 3 launchers + the Games card = 4 entries -> arrow.)
function updateCarouselPeek() {
    const show = cardEntries.length > 3;
    const l = $('carouselPeekLeft');
    const r = $('carouselPeekRight');
    if (l) l.hidden = !show;
    if (r) r.hidden = !show;
}

function updateFocus(newIndex) {
    if (!cards.length) return;
    focusedIndex = (newIndex + cards.length) % cards.length;
    recentBarFocus = -1; // on a card change we leave the quick-launch bar
    continueFocus = -1;  // ...and the global Continue bar (defensive — we only get here standing on a card)
    layoutCarousel();
    renderRecentBar();
    renderContinueBar();
}

// --- Quick-launch bar (under the focused launcher card) ---

// The recent games (max 3) of the focused card to show. GAMES_CARD has no `recentGames` field -> empty array.
function focusedRecentGames() {
    if (!recentGamesUiState.launcherRecent) return [];
    const e = cardEntries[focusedIndex];
    return (e && Array.isArray(e.recentGames)) ? e.recentGames.slice(0, 3) : [];
}

// (Re)renders #recentBar (index.html, under .cards) from the focused card's recentGames. Callers: renderCards() / updateFocus() / the
// main-nav branch of gamepad.js when `recentBarFocus` changes. The bar's height is fixed in CSS (no layout jump between two launchers),
// only the content appears/disappears.
function renderRecentBar() {
    const bar = $('recentBar');
    if (!bar) return;
    const games = focusedRecentGames();
    if (!games.length) {
        bar.innerHTML = '';
        bar.classList.remove('has-games', 'bar-focused');
        return;
    }
    bar.classList.add('has-games');
    bar.classList.toggle('bar-focused', recentBarFocus >= 0);
    bar.innerHTML = games.map((g, i) => `
        <button class="recent-game${i === recentBarFocus ? ' focused' : ''}" data-recent="${i}" title="${esc(g.name)}" aria-label="${esc(g.name)}">
            ${g.cover
                ? `<img src="${fileUrl(g.cover)}" alt="${esc(g.name)}" decoding="async">`
                : `<span class="recent-game-noart">${esc(g.name)}</span>`}
        </button>
    `).join('');
    wireCoverFallback(bar, '.recent-game > img');
}

// --- Global "▶ Continue" bar (under the header, ABOVE the carousel) ---
// The last 3 games of ALL sources (get-continue-games IPC → usage.globalRecentGames). A separate focus zone: `continueFocus` (-1 = not
// here; 0..2 = in it). ▲ brings you here from the card, ▼ back; ◀▶ between the mini icons; ✕ launches (launchRecentGame).

// Maximum item count of the Continue bar (main's `get-continue-games` returns as many).
const CONTINUE_BAR_MAX = 8;

function continueBarGames() {
    const games = (recentGamesUiState.continueBar && Array.isArray(continueGames)) ? continueGames.slice(0, CONTINUE_BAR_MAX) : [];
    // A still running game launched from the launcher: the first item is "BACK", even with the Continue bar turned off (otherwise there would
    // be no way back to the running game from the home screen).
    if (activeSessionInfo) return [{ resume: true, name: activeSessionInfo.name, cover: activeSessionInfo.cover }, ...games];
    return games;
}

// Called by the renderer/main.js init + renderer/ipc.js onRunningChanged/onAppClosed (no separate push channel) — a fresh query from the
// main process, then a rerender.
function refreshContinueBar() {
    if (!window.launcher || !window.launcher.getContinueGames) return;
    window.launcher.getContinueGames()
        .then((list) => { continueGames = Array.isArray(list) ? list : []; renderContinueBar(); })
        .catch(ignoreError);
}

function renderContinueBar() {
    const bar = $('continueBar');
    if (!bar) return;
    const games = continueBarGames();
    const container = bar.closest('.container');
    if (container) container.classList.toggle('has-continue', games.length > 0);
    if (!games.length) {
        bar.innerHTML = '';
        bar.hidden = true;
        bar.classList.remove('bar-focused');
        continueFocus = -1;
        return;
    }
    bar.hidden = false;
    bar.classList.toggle('bar-focused', continueFocus >= 0);
    const label = `<span class="continue-bar-label">${esc(tr('continue.label'))}</span>`;
    bar.innerHTML = label + games.map((g, i) => `
        <button class="continue-game${i === continueFocus ? ' focused' : ''}${g.resume ? ' continue-resume' : ''}" data-continue="${i}" title="${esc(g.resume ? tr('continue.resume', { name: g.name }) : g.name)}" aria-label="${esc(g.resume ? tr('continue.resume', { name: g.name }) : g.name)}">
            ${g.resume ? `<span class="continue-resume-tag">${esc(tr('continue.resumeTag'))}</span>` : ''}
            ${g.cover
                ? `<img src="${fileUrl(g.cover)}" alt="${esc(g.name)}" decoding="async">`
                : `<span class="recent-game-noart">${esc(g.name)}</span>`}
        </button>
    `).join('');
    wireCoverFallback(bar, '.continue-game > img');
    updateContinueBackdrop(continueFocus >= 0 ? games[continueFocus] : null);
}

// The blurred cover of the focused Continue item in the background ("console dashboard" feel). The image comes from the existing cover
// cache; no cover / no focus → the layer fades out. `data-motion="off"` (feedback.motion) turns off the crossfade in CSS.
function updateContinueBackdrop(game) {
    const el = $('continueBackdrop');
    if (!el) return;
    if (game && game.cover) {
        el.style.backgroundImage = `url("${fileUrl(game.cover)}")`;
        el.classList.add('active');
    } else {
        el.classList.remove('active');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { ringOffset, carouselPosName, GAMES_CARD_ID, favoriteLauncherId, mostRecentLauncherIndex, cardAccent });
}
