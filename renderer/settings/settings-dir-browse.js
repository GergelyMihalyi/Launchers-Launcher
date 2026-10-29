// Controller-driven folder browser for the Settings subviews — a SHARED factory (melonDS ROM folders, backup target folder, manual launcher
// folder). The `browse-dir` IPC (lib/dir-browse.js) lists the host filesystem from home. Rows: "✓ choose this folder" / ".. up" / subfolders /
// "⌨ Manual entry..." (on-screen keyboard). Draws into the calling subview's `#settingsContent`, with its own edge state; on close the caller's
// `onClose(gp)` syncs. Load order: AFTER settings.js, BEFORE the subviews using it.
// Background: docs/dev/renderer/settings.md#directory-browser-and-manual-launcher-path

/**
 * @param {Object} o
 * @param {string} o.viewId the calling subview's id (to drop a stale async response)
 * @param {(path: string) => boolean} [o.isPicked] is the folder already chosen (badge)
 * @param {string} [o.pickedTagKey] i18n key of the badge (default: "(ADDED)")
 * @param {(path: string) => void} o.onPick the choice (the caller decides whether to close: `close()`)
 * @param {(gp: any) => void} o.onClose the browser closed (○/PS or `close()`)
 * @param {{ content: string, title: string, hint: string }} [o.ui] DOM ids for drawing (default: the Settings panel — the wizard
 *   passes its own `#setup*` elements)
 * @param {() => boolean} [o.isActive] is the calling view still open (default: `settingsView === viewId`)
 * @param {() => void} [o.scroll] scrolls the focused row into view (default: `scrollSettingsFocusIntoView`)
 */
function createDirBrowser({
    viewId, isPicked = () => false, pickedTagKey = 'sv.tagAdded', onPick, onClose,
    ui = { content: 'settingsContent', title: 'settingsPanelTitle', hint: 'settingsPanelHint' },
    isActive = () => settingsView === viewId,
    scroll = () => scrollSettingsFocusIntoView(),
}) {
    /** @type {null | { path: string, parent: string|null, dirs: Array<{name: string, path: string}>, focus: number, buttonStates: Object }} */
    let st = null;

    function rows() {
        const out = [{ type: 'select' }];
        if (st.parent) out.push({ type: 'up' });
        for (const d of st.dirs) out.push({ type: 'dir', name: d.name, path: d.path });
        out.push({ type: 'manual' });
        return out;
    }

    async function open(targetPath) {
        $(ui.title).textContent = tr('sv.browseDirTitle');
        $(ui.hint).innerHTML = subviewHint('hint.select');
        $(ui.content).innerHTML = skeletonList();
        const res = await window.launcher.browseDir(targetPath || null).catch(() => null);
        if (!isActive()) return; // left the subview meanwhile
        st = (!res || !res.ok)
            ? { path: (res && res.path) || targetPath || '', parent: null, dirs: [], focus: 0, buttonStates: { cross: true } }
            : { path: res.path, parent: res.parent, dirs: res.dirs, focus: 0, buttonStates: { cross: true } };
        render();
    }

    function render() {
        if (!st) return;
        const list = rows();
        if (st.focus >= list.length) st.focus = list.length - 1;
        $(ui.title).textContent = st.path || tr('sv.browseDirTitle');
        const picked = isPicked(st.path);
        let html = list.map((row, i) => {
            const focused = i === st.focus ? ' focused' : '';
            if (row.type === 'select') {
                const tag = picked ? ` ${currentTag(tr(pickedTagKey))}` : '';
                return `<div class="settings-item${focused}"><span class="bt-name">✓ ${esc(tr('sv.browseSelectHere'))}</span>${tag}</div>`;
            }
            if (row.type === 'up') {
                return `<div class="settings-item${focused}"><span class="bt-name">.. (${esc(tr('sv.browseUp'))})</span></div>`;
            }
            if (row.type === 'manual') {
                return `<div class="settings-item${focused}"><span class="bt-name">⌨ ${esc(tr('sv.browseManualEntry'))}</span></div>`;
            }
            return `<div class="settings-item${focused}"><span class="bt-name">📁 ${esc(row.name)}</span></div>`;
        }).join('');
        if (!st.dirs.length) html += emptyState(tr('sv.browseNoSubdirs'));
        $(ui.content).innerHTML = html;
        scroll();
    }

    function close(gp) {
        if (!st) return;
        st = null;
        onClose(gp);
    }

    function manualEntry() {
        openKeyboard({
            title: tr('sv.browseManualTitle'),
            initial: st.path,
            maxLength: 300,
            ownerStates: st.buttonStates,
            onCancel: () => { },
            onConfirm: async (txt) => {
                const p = String(txt).trim();
                if (!p || !st) return;
                const res = await window.launcher.browseDir(p).catch(() => null);
                if (!isActive() || !st) return;
                if (!res || !res.ok) { showStatus(tr('sv.romDirInvalid'), true); render(); return; }
                onPick(res.path);
                render();
            },
        });
    }

    function select() {
        const row = rows()[st.focus];
        if (!row) return;
        if (row.type === 'select') { if (st.path) onPick(st.path); render(); return; }
        if (row.type === 'up') { open(st.parent); return; }
        if (row.type === 'manual') { manualEntry(); return; }
        open(row.path);
    }

    function handle(gp) {
        const count = rows().length;
        navList(gp, st.buttonStates, {
            count,
            move: (d, repeated) => { st.focus = stepIndex(st.focus, d, count, repeated); render(); },
            onSelect: () => select(),
            onBack: () => close(gp),
        });
    }

    // `reset()` = a silent close (when the subview is reopened), without `onClose`.
    return { open, render, handle, close, reset: () => { st = null; }, isOpen: () => !!st };
}
