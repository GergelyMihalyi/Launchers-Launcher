// i18n — the `tr()` logic; the UI string tables live in one file per language (i18n-hu.js / i18n-en.js). `tr(key)` fallback: active
// language → hu → the `key` itself (a missing key shows up immediately during development). Interpolation: `tr('foo', { n: 3 })` turns `{n}`
// in the string into `3`. The active language comes from the `language` key (`get-language` IPC → `setActiveLanguage()`). Load order:
// AFTER `util.js` + the two language tables, BEFORE `state.js`.
// CONVENTION: every user-visible string goes through `tr('<area>.<name>')`; `hu` is COMPLETE. A new key: into BOTH tables.
// Background: docs/dev/renderer/overview.md#html-building-and-i18n

// Node/test: `esc` from renderer/util.js, the two language tables from i18n-hu.js / i18n-en.js (all global <script>s loaded EARLIER in
// the browser) — `currentTag()` calls `esc`.
if (typeof esc === 'undefined' && typeof module !== 'undefined') {
    // eslint-disable-next-line no-undef
    globalThis.esc = module.require('../util.js').esc;
}
if (typeof I18N_HU === 'undefined' && typeof module !== 'undefined') {
    Object.assign(globalThis, {
        I18N_HU: module.require('./i18n-hu.js').I18N_HU,
        I18N_EN: module.require('./i18n-en.js').I18N_EN,
    });
}

const LANGUAGES = ['hu', 'en'];
const LANG_LABELS = { hu: 'Magyar', en: 'English' };

const I18N = { hu: I18N_HU, en: I18N_EN };

let activeLang = 'hu';

function setActiveLanguage(lang) {
    activeLang = (lang && I18N[lang]) ? lang : 'hu';
    // The screen reader picks its pronunciation from <html lang>.
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = activeLang;
    return activeLang;
}

function activeLanguage() {
    return activeLang;
}

function tr(key, params) {
    const table = I18N[activeLang] || I18N.hu;
    let s = table[key];
    if (s == null) s = I18N.hu[key];
    if (s == null) return key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            s = s.split('{' + k + '}').join(String(v));
        }
    }
    return s;
}

// The shared builder of the "currently selected/active" badge (`<span class="audio-current-tag">…</span>`) — lives here (not in util.js)
// because it calls `tr()`. `opts.paren: true` for the "(CURRENT)" form (the most common), otherwise the raw text without parentheses. The
// caller adds the leading space if needed.
function currentTag(text, opts) {
    const useParen = (opts && opts.paren) || text == null;
    const shown = esc(text == null ? tr('lang.current') : text);
    return `<span class="audio-current-tag">${useParen ? `(${shown})` : shown}</span>`;
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        tr, setActiveLanguage, activeLanguage, I18N, LANGUAGES, LANG_LABELS, currentTag,
    });
}
