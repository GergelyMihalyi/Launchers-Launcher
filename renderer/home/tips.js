// First-use tips: a non-modal tip bubble about a hidden gesture (hold ✕, PS combos, R3 …), the FIRST time the related surface opens. The
// seen tips go into the `seenTips` config key (the whole list is replaced); Settings → Appearance → "Tips" → "Show tips again" clears it.
// One bubble at a time, for ~8 s; it does not touch the input meanwhile (focus/navigation unaffected).
// Load order: AFTER overlays.js (the callers of `showTipOnce` — the games-panel/settings `onOpen` — call it at runtime).

// id → i18n key + the key's parameters (button glyphs per the current controller layout).
const TIPS = [
    { id: 'home', textKey: 'tip.home', params: () => ({ confirm: btnGlyph('confirm'), back: btnGlyph('back'), start: btnGlyph('start') }) },
    { id: 'gamesPanel', textKey: 'tip.gamesPanel', params: () => ({ confirm: btnGlyph('confirm'), pin: btnGlyph('menu'), view: btnGlyph('view') }) },
    { id: 'settings', textKey: 'tip.settings', params: () => ({ back: btnGlyph('back'), confirm: btnGlyph('confirm') }) },
];

const TIP_VISIBLE_MS = 8000;
let seenTips = new Set();
let seenTipsLoaded = false;
let tipTimer = null;

/** The tip ids not seen yet from the given list (pure, testable). */
function unseenTips(allIds, seen) {
    return allIds.filter((id) => !seen.has(id));
}

function loadSeenTips() {
    return window.launcher.getSeenTips().then((list) => {
        seenTips = new Set(Array.isArray(list) ? list : []);
        seenTipsLoaded = true;
    }).catch(ignoreError);
}

function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = null;
    const el = $('tipBubble');
    if (el) el.hidden = true;
}

/** Shows the tip if the user has not seen it yet; adds it to the seen ones (persisted). */
function showTipOnce(id) {
    if (!seenTipsLoaded || seenTips.has(id)) return;
    const tip = TIPS.find((t) => t.id === id);
    const el = $('tipBubble');
    if (!tip || !el) return;
    seenTips = new Set([...seenTips, id]);
    window.launcher.setSeenTips([...seenTips]);
    $('tipBubbleText').textContent = tr(tip.textKey, tip.params());
    el.hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, TIP_VISIBLE_MS);
}

/** "Show tips again": clears the seen list. */
function resetSeenTips() {
    seenTips = new Set();
    window.launcher.setSeenTips([]);
    hideTip();
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { TIPS, unseenTips });
}
