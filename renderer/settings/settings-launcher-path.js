// Manually set native launcher — a SHARED flow for the Settings → Launchers subview and the setup wizard's launcher step: folder browser
// (`createDirBrowser`) → main looks for the program in it (`find-launcher-executables`) → immediately for one match, from a picker list for
// several → `set-launcher-path`. If nothing in the folder matches by name, it offers every executable of the folder (`guess`).
//
// Load order: AFTER settings-dir-browse.js, BEFORE settings-launchers.js and setup-wizard.js.

/**
 * @param {Object} o
 * @param {string} o.viewId the dir browser's `viewId`
 * @param {{ content: string, title: string, hint: string }} o.ui DOM ids for drawing
 * @param {() => boolean} o.isActive is the calling view still open
 * @param {() => void} o.scroll scrolls the focused row into view
 * @param {boolean} o.apply should main add / switch the launcher immediately (the wizard: no)
 * @param {(entry: any, path: string) => void} o.onDone after a successful save (the flow is already closed)
 * @param {(gp: any) => void} o.onClose cancel (○) — the caller redraws + syncs
 */
function createLauncherPathFlow({ viewId, ui, isActive, scroll, apply, onDone, onClose }) {
    /** @type {null | { entry: any, dir: string, items: Array<{ path: string, name: string }>, guess: boolean, focus: number, buttonStates: Object }} */
    let pick = null;
    let entry = null;

    const browser = createDirBrowser({
        viewId, ui, isActive, scroll,
        onPick: (dir) => { findIn(dir).catch(ignoreError); },
        onClose: (gp) => { entry = null; onClose(gp); },
    });

    function startDir(e) {
        const p = e && e.manualPath;
        return p ? p.slice(0, p.lastIndexOf('/')) || null : null;
    }

    function open(e) {
        entry = e;
        pick = null;
        browser.open(startDir(e));
    }

    async function findIn(dir) {
        const e = entry;
        if (!e) return;
        const res = await window.launcher.findLauncherExecutables({ id: e.id, dir }).catch(() => null);
        if (!isActive() || entry !== e) return;
        const items = (res && res.ok && Array.isArray(res.items)) ? res.items : [];
        if (!items.length) {
            showStatus(tr('sv.lpNoneFound', { name: e.name.toUpperCase() }), true);
            return;
        }
        if (items.length === 1 && !res.guess) {
            commit(items[0].path);
            return;
        }
        browser.reset();
        pick = { entry: e, dir, items, guess: !!res.guess, focus: 0, buttonStates: { cross: true } };
        renderPick();
    }

    function renderPick() {
        $(ui.title).textContent = tr('sv.lpPickTitle', { name: pick.entry.name });
        $(ui.hint).innerHTML = subviewHint('hint.select');
        const note = pick.guess ? `<div class="changelog-para">${esc(tr('sv.lpGuessNote'))}</div>` : '';
        $(ui.content).innerHTML = note + pick.items.map((it, i) =>
            `<div class="settings-item${i === pick.focus ? ' focused' : ''}"><span class="bt-name">${esc(it.name)}</span>`
            + ` <span class="bt-disamb">${esc(pick.dir)}</span></div>`,
        ).join('');
        scroll();
    }

    async function commit(filePath) {
        const e = entry;
        const res = await window.launcher.setLauncherPath({ id: e.id, path: filePath, apply }).catch(() => null);
        if (!res || !res.ok) {
            showStatus(tr('sv.lpRejected', { reason: (res && res.reason) || '?' }), true);
            return;
        }
        showStatus(tr('sv.lpSaved', { name: e.name.toUpperCase() }));
        pick = null;
        browser.reset();
        entry = null;
        onDone(e, filePath);
    }

    function handle(gp) {
        if (!pick) { browser.handle(gp); return; }
        const count = pick.items.length;
        navList(gp, pick.buttonStates, {
            count,
            move: (d, repeated) => { pick.focus = stepIndex(pick.focus, d, count, repeated); renderPick(); },
            onSelect: () => { const it = pick.items[pick.focus]; if (it) commit(it.path).catch(ignoreError); },
            onBack: () => { const dir = pick.dir; pick = null; browser.open(dir); },
        });
    }

    // Clears the manual path (falls back to the detected variant if the added launcher used it).
    async function clear(e, onCleared) {
        const res = await window.launcher.setLauncherPath({ id: e.id, path: null, apply }).catch(() => null);
        if (res && res.ok) showStatus(tr('sv.lpCleared', { name: e.name.toUpperCase() }));
        else showStatus(tr('sv.lpRejected', { reason: (res && res.reason) || '?' }), true);
        if (onCleared) onCleared();
    }

    return {
        open, handle, clear,
        isOpen: () => !!pick || browser.isOpen(),
        reset: () => { pick = null; entry = null; browser.reset(); },
    };
}
