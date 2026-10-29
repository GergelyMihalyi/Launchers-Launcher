// Games panel — live search: shared filtering of the root view AND the RetroArch system drill-down; the Select/View button opens a docked
// on-screen keyboard (keyboard.js `live` mode), the list behind refreshes after every edit. The pure text normalizer/search helpers
// (`normalizeSearchText`/`searchTokens`/`searchCharCount`/`isSearchActive`/`searchRows`/`SEARCH_MIN_CHARS`) are DOM-free and exported
// (test/games-panel/games-panel.test.js). Load order: AFTER games-panel-sources.js. Background: docs/dev/games-panel.md#search

// Live search. `gamesPanelQuery` = the live search text (per panel session, not persisted; STAYS on a chip switch, cleared when entering/
// leaving the RetroArch system drill-down); filtering is live from `SEARCH_MIN_CHARS` (normalized) characters. `gamesSearchTyping` = the docked
// on-screen keyboard is open (the search bar shows even with empty text, with a cursor). `gamesPanelShownUnified` = the shared (unified) rows
// rendered LAST — the lazy RetroArch cover download (`fetchUnifiedRetroCovers`) counts from it, not from the unfiltered memo.
// `systemViewCache` = a one-item memo of the drill-down's filtered list.
let gamesPanelQuery = '';
let gamesSearchTyping = false;
let gamesPanelShownUnified = [];
let systemViewCache = { src: null, q: '', hiddenGames: null, showHidden: false, out: [] };
// The recent searches (for the current run only) — insertable with ✕ in the keyboard's top row.
const GAMES_RECENT_QUERIES_MAX = 5;
let gamesRecentQueries = [];

// --- Live search: pure helpers (test/games-panel/games-panel.test.js) ---
// The cost is negligible even on the ~15,700 item RetroArch set (measured: ~0.5 ms per filter, the one-off key building ~22 ms), so no
// index/IPC — a plain substring filter on the pre-normalized key.
const SEARCH_MIN_CHARS = 3;   // narrows from this many (normalized, space-free) characters
const SEARCH_MAX_CHARS = 40;

// Lowercase, accents stripped (NFD + combining marks: ő/ű/é/Pokémon match too), every non-letter/digit character becomes a space, spaces
// collapsed. "Zelda: Link's Awakening" -> "zelda link s awakening".
function normalizeSearchText(s) {
    return String(s == null ? '' : s)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

// The tokens of the search text (normalized, split on spaces) — for an order-independent AND match.
function searchTokens(query) {
    const n = normalizeSearchText(query);
    return n ? n.split(' ') : [];
}

// How many (normalized, space-free) characters the user typed — "a b" = 2, not 3.
function searchCharCount(query) {
    return normalizeSearchText(query).replace(/ /g, '').length;
}

// The list of recent searches: newest first, without case- and accent-insensitive duplicates, at most `max` items; an inactive (too short)
// search is not remembered. Returns a new array.
function pushRecentQuery(list, query, max = 5) {
    const q = String(query == null ? '' : query).trim();
    if (!isSearchActive(q)) return list;
    const n = normalizeSearchText(q);
    return [q, ...list.filter((x) => normalizeSearchText(x) !== n)].slice(0, max);
}

function isSearchActive(query) {
    return searchCharCount(query) >= SEARCH_MIN_CHARS;
}

// The search key of an item (row / ROM entry): " <normalized name> |<without spaces>" — thanks to the latter segment "megaman"/"pacman" also
// finds "Mega Man"/"Pac-Man". The key is cached on the object (`_sk`), so `{ ...row }` copies carry it too.
function searchKeyOf(obj, name) {
    if (obj._sk === undefined) {
        const n = normalizeSearchText(name);
        obj._sk = ` ${n} |${n.replace(/ /g, '')}`;
    }
    return obj._sk;
}

// Abbreviation key: the initials of the name's words — once full ("final fantasy x" -> "ffx"), once without filler words ("the", "of",
// "and"…) ("legend of zelda" -> "lz"); separated by a space so the searched abbreviation can match either. Cached on the object (`_si`).
const SEARCH_STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'in', 'de', 'la', 'no']);
function searchInitialsOf(obj, name) {
    if (obj._si === undefined) {
        const words = normalizeSearchText(name).split(' ').filter(Boolean);
        const all = words.map((w) => w[0]).join('');
        const core = words.filter((w) => !SEARCH_STOP_WORDS.has(w)).map((w) => w[0]).join('');
        obj._si = all === core ? all : `${all} ${core}`;
    }
    return obj._si;
}

// The items matching `query`: EVERY token must occur as a substring of the name; a 2-level stable ranking — where every token is at the
// START OF A WORD comes first ("mar" -> "Mario" before "Primary"/"Smart"), both levels keep the original (alphabetical) order. For a
// single-word search (e.g. "ffx", "gta") the initials of the name's words count too among the non-matching ones — those go to the END of the
// list (level 3: abbreviation). With an inactive search (<`SEARCH_MIN_CHARS`) returns `items` itself. `nameOf` = the name extractor (default
// `.name`).
function searchRows(items, query, nameOf) {
    if (!isSearchActive(query)) return items;
    const tokens = searchTokens(query);
    const getName = nameOf || ((r) => r.name);
    const primary = [];
    const secondary = [];
    const acronym = [];
    const tryAcronym = tokens.length === 1;
    for (const it of items) {
        const key = searchKeyOf(it, getName(it));
        let all = true;
        for (const tk of tokens) if (!key.includes(tk)) { all = false; break; }
        if (!all) {
            if (tryAcronym && searchInitialsOf(it, getName(it)).split(' ').some((a) => a.startsWith(tokens[0]))) acronym.push(it);
            continue;
        }
        let wordStart = true;
        for (const tk of tokens) if (!key.includes(' ' + tk)) { wordStart = false; break; }
        (wordStart ? primary : secondary).push(it);
    }
    return secondary.length || acronym.length ? primary.concat(secondary, acronym) : primary;
}

// `fileUrl` (local image -> file:// URL) lives in renderer/util.js (shared with the quick-launch bar).

// --- Live search: state + UI ---

// The RetroArch system drill-down list filtered by the search (with an inactive search the full list itself). A one-item memo (source array
// reference + search text): `fetchVisibleRetroCovers` recreates the array (cover patch), which is refiltered here automatically.
function systemGamesView() {
    const q = gamesPanelQuery;
    const hideOn = gamesHiddenGames.size > 0 && !gamesShowHidden;
    if (!hideOn && !isSearchActive(q)) return gamesPanelSystemGames;
    const c = systemViewCache;
    if (c.src === gamesPanelSystemGames && c.q === q && c.hiddenGames === gamesHiddenGames && c.showHidden === gamesShowHidden) return c.out;
    // Individually hidden ROMs drop out (the key equals the favorite key: `retroarch:<system>:<name>`).
    const base = hideOn
        ? gamesPanelSystemGames.filter((g) => !isGameFiltered(`retroarch:${gamesPanelSystem}:${g.label}`))
        : gamesPanelSystemGames;
    const out = isSearchActive(q) ? searchRows(base, q, (g) => g.label) : base;
    systemViewCache = { src: gamesPanelSystemGames, q, hiddenGames: gamesHiddenGames, showHidden: gamesShowHidden, out };
    return out;
}

// The search bar (under the chip row, sticky): `🔍 text▏ · N matches` / `· N more characters`. Only visible if there is search text or the
// keyboard is open. `count` = the number of matches.
function gamesSearchBarHtml(count) {
    if (!gamesPanelQuery && !gamesSearchTyping) return '';
    const meta = isSearchActive(gamesPanelQuery)
        ? tr('games.searchCount', { n: count })
        : tr('games.searchMore', { n: SEARCH_MIN_CHARS - searchCharCount(gamesPanelQuery) });
    return '<div class="games-search"><span class="games-search-icon">🔍</span>'
        + `<span class="games-search-text">${esc(gamesPanelQuery)}${gamesSearchTyping ? '▏' : ''}</span>`
        + `<span class="games-search-meta">${esc(meta)}</span></div>`;
}

// New search text (live): the focus goes to the first match (indexes shift), the hint refreshes (the back button's label becomes "Clear
// search"), the list rerenders — in the root and in the system drill-down too (`renderGamesPanel` picks the view itself).
function setGamesQuery(text) {
    const next = String(text == null ? '' : text).slice(0, SEARCH_MAX_CHARS);
    if (next === gamesPanelQuery) return;
    gamesPanelQuery = next;
    gamesPanelFocusIndex = 0;
    gamesPanelPendingFocusKey = null;
    renderGamesPanelHint();
    renderGamesPanel();
}

// Reserving the docked keyboard's space: the bottom padding of `#gamesOverlay` is the measured keyboard height (`--kb-h`), so the list stays
// ABOVE the keyboard (and `scrollIntoView` keeps the focus in the visible area).
function setGamesSearchDock(on) {
    const ov = $('gamesOverlay');
    if (!ov) return;
    ov.classList.toggle('kb-docked', !!on);
    if (!on) ov.style.removeProperty('--kb-h');
}

// After the keyboard closes: commit the final search text, focus on the first match.
function finishGamesSearch(text) {
    gamesSearchTyping = false;
    gamesPanelQuery = String(text == null ? '' : text).trim().slice(0, SEARCH_MAX_CHARS);
    gamesPanelFocusIndex = 0;
    gamesPanelPendingFocusKey = null;
    setGamesSearchDock(false);
    renderGamesPanelHint();
    renderGamesPanel();
}

// Select/View: a docked, live on-screen keyboard (renderer/keyboard.js, `live` + `onChange`) — the list above refreshes after every letter.
// DONE = the filter stays (focus on the first match), CANCEL / ○ = the search text from before opening is restored.
function openGamesSearch() {
    if (keyboardPanel.isOpen()) return;
    if (gamesFilter.isOpen()) return;
    if (gamesPanelSystem ? !gamesPanelSystemGames.length : (!gamesPanelLoadOk || !gamesPanelRows.length)) return;
    const before = gamesPanelQuery;
    gamesSearchTyping = true;
    feedback('nav');
    openKeyboard({
        title: tr('kb.searchTitle'), initial: before, maxLength: SEARCH_MAX_CHARS,
        layout: 'compact', dock: 'bottom', live: true, ownerStates: gamesPanel.states,
        onChange: (text) => setGamesQuery(text),
        suggestions: gamesRecentQueries,
        onConfirm: (text) => { gamesRecentQueries = pushRecentQuery(gamesRecentQueries, text, GAMES_RECENT_QUERIES_MAX); finishGamesSearch(text); },
        onCancel: () => finishGamesSearch(before),
    });
    renderGamesPanel(); // the search bar appears when the keyboard opens (even with empty text)
    requestAnimationFrame(() => {
        const panel = /** @type {HTMLElement|null} */ (document.querySelector('#keyboardOverlay .keyboard-panel'));
        if (!panel || !gamesSearchTyping) return;
        $('gamesOverlay').style.setProperty('--kb-h', `${panel.offsetHeight}px`);
        $('gamesOverlay').classList.add('kb-docked');
        const el = document.querySelector('#gamesPanelContent .focused');
        if (el) el.scrollIntoView({ block: 'nearest' });
    });
}

// Physical keyboard (a bonus, called by the keydown fallback of renderer/main.js): a printable character is appended to the search,
// Backspace deletes, 'clear' (Esc) clears the search. `true` = handled.
function gamesSearchKey(action) {
    if (!gamesPanel.isOpen() || gamesFilter.isOpen()) return false;
    if (keyboardPanel.isOpen()) return false;
    if (gamesPanelSystem ? !gamesPanelSystemGames.length : !gamesPanelRows.length) return false;
    if (action === 'clear') {
        if (!gamesPanelQuery) return false;
        setGamesQuery('');
        return true;
    }
    if (action === 'backspace') {
        if (!gamesPanelQuery) return false;
        setGamesQuery(gamesPanelQuery.slice(0, -1));
        return true;
    }
    if (typeof action === 'string' && action.length === 1) {
        if (action === ' ' && !gamesPanelQuery) return true; // no leading space is appended
        setGamesQuery(gamesPanelQuery + action);
        return true;
    }
    return false;
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        SEARCH_MIN_CHARS, normalizeSearchText, searchTokens, searchCharCount, isSearchActive, searchRows, pushRecentQuery,
    });
}
