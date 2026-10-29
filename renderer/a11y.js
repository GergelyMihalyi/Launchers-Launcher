// Screen-reader support (`feedback.screenReader`). The focus is VISUAL (`.focused`, moved by the controller), the DOM focus does not move —
// when enabled, a MutationObserver watches which element gets `.focused`, and its label (`aria-label`, otherwise its text) goes into the
// invisible `#srAnnounce` live region (debounced). When disabled there is NO observer. Load order: AFTER util.js.
// Background: docs/dev/renderer/overview.md#accessibility

const SR_ANNOUNCE_DELAY_MS = 150;
let srObserver = null;
let srTimer = null;
let srLast = '';

// The label to announce for an element: `aria-label`, otherwise its visible text (whitespace collapsed, max 200 characters). Pure (apart
// from `getAttribute`/`textContent`).
function a11yLabelOf(el) {
    if (!el) return '';
    const aria = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null;
    return String(aria || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// The element that got the focus LAST among the mutations (or `null`).
function focusedFromMutations(records) {
    let target = null;
    for (const r of records) {
        if (r.type === 'attributes') {
            if (r.target.classList && r.target.classList.contains('focused')) target = r.target;
            continue;
        }
        for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.classList.contains('focused')) target = n;
            else {
                const f = n.querySelector('.focused');
                if (f) target = f;
            }
        }
    }
    return target;
}

function srAnnounce(text) {
    const el = $('srAnnounce');
    if (!el || !text || text === srLast) return;
    srLast = text;
    el.textContent = text;
}

function setScreenReaderSupport(on) {
    if (on && !srObserver && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        srObserver = new MutationObserver((records) => {
            const target = focusedFromMutations(records);
            if (!target) return;
            clearTimeout(srTimer);
            srTimer = setTimeout(() => srAnnounce(a11yLabelOf(target)), SR_ANNOUNCE_DELAY_MS);
        });
        srObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    } else if (!on && srObserver) {
        srObserver.disconnect();
        srObserver = null;
        clearTimeout(srTimer);
        srLast = '';
    }
}

function applyScreenReaderPref() {
    setScreenReaderSupport(typeof feedbackState !== 'undefined' && feedbackState.screenReader === true);
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { a11yLabelOf, focusedFromMutations });
}
