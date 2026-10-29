// The "+ Add launcher" wizard — ONE step-by-step flow for adding OUTSIDE the catalog:
//   source ─┬─ Installed application (flatpak + native .desktop, with icon; △ = filter) ─┐
//           ├─ Type a custom command (name → command → arguments) ───────────────────────┤
//           └─ Pick a program from a folder (dir browser → executable → name) ────────────┴─ preview
// Name, icon and accent color can be set on the preview. Adding is the `add-launcher` IPC — main's `checkLauncherPayload` gate decides, main
// copies the program's own icon (`iconFile`) into the launcher's icon folder. Load order: AFTER settings-dir-browse.js, BEFORE
// settings-launchers.js.

// A name → id slice (for the "custom-<slug>" / "flatpak-<appid-slug>" launcher ids).
function customLauncherSlug(name) {
    return String(name).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

// A unique `custom-<slug>[-N]` id next to the already added launchers.
function customLauncherId(name, existing) {
    const taken = new Set((existing || []).map((l) => l.id));
    const base = `custom-${customLauncherSlug(name)}`;
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
}

// Case- and accent-insensitive filter key (for the △ filter of the installed-app list).
function addFilterKey(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Filters the installed apps by name / appid / command (every word must match). Pure.
function filterInstalledApps(apps, query) {
    const words = addFilterKey(query).split(/\s+/).filter(Boolean);
    if (!words.length) return apps;
    return apps.filter((a) => {
        const hay = addFilterKey(`${a.name} ${a.appId || ''} ${a.cmd || ''}`);
        return words.every((w) => hay.includes(w));
    });
}

// The wizard's output → the `add-launcher` payload. `existing` = the added launchers (id clash). Pure (the renderer test checks it).
function launcherAddPayload(draft, existing) {
    const id = draft.kind === 'flatpak' && draft.appId
        ? `flatpak-${customLauncherSlug(draft.appId)}`
        : customLauncherId(draft.name, existing);
    const payload = {
        id, name: draft.name, hint: '', icon: draft.builtinIcon || '',
        cmd: draft.cmd, args: draft.args.slice(), custom: true,
    };
    if (!draft.builtinIcon && draft.useOwnIcon && draft.iconFile) payload.iconFile = draft.iconFile;
    if (draft.accent) payload.accent = draft.accent;
    return payload;
}

const LAUNCHER_ADD_SOURCES = ['apps', 'typed', 'browse'];
// source → [label, note] i18n keys
const LAUNCHER_ADD_SOURCE_KEYS = {
    apps: ['sv.addSrcApps', 'sv.addSrcAppsNote'],
    typed: ['sv.addSrcTyped', 'sv.addSrcTypedNote'],
    browse: ['sv.addSrcBrowse', 'sv.addSrcBrowseNote'],
};
const LAUNCHER_ADD_PREVIEW_ROWS = ['add', 'name', 'icon', 'accent'];

/**
 * @param {Object} o
 * @param {() => boolean} o.isActive is the Launchers subview still open
 * @param {() => void} o.scroll scrolls the focused row into view
 * @param {(gp: any) => void} o.onClose the wizard closed (○ on the source step / successful add)
 */
function createLauncherAddFlow({ isActive, scroll, onClose }) {
    const ui = { content: 'settingsContent', title: 'settingsPanelTitle', hint: 'settingsPanelHint' };
    /** @type {null | Record<string, any>} */
    let st = null;
    let buttonStates = {};

    const browser = createDirBrowser({
        viewId: 'launchers', ui, isActive, scroll,
        onPick: (dir) => { findExecutables(dir).catch(ignoreError); },
        onClose: (gp) => { toSource(gp); },
    });

    const palette = () => (typeof CARD_ACCENT_PALETTE !== 'undefined' ? CARD_ACCENT_PALETTE : [{ hex: null }]);

    function open() {
        buttonStates = { cross: true };
        st = { step: 'source', focus: 0 };
        render();
    }

    function close(gp) {
        st = null;
        browser.reset();
        onClose(gp);
    }

    function toSource(gp) {
        st = { step: 'source', focus: st && st.step === 'source' ? st.focus : 0 };
        if (gp) syncEdge(buttonStates, gp, ['cross', 'cancel']);
        render();
    }

    // --- steps ---

    async function openApps() {
        st = { step: 'apps', apps: null, filter: '', focus: 0 };
        render();
        const res = await window.launcher.listInstalledApps().catch(() => null);
        if (!isActive() || !st || st.step !== 'apps') return;
        st.apps = (res && res.ok && Array.isArray(res.items)) ? res.items : [];
        st.failed = !(res && res.ok);
        render();
    }

    function shownApps() {
        return st && st.apps ? filterInstalledApps(st.apps, st.filter) : [];
    }

    function openFilter() {
        const prev = st;
        const before = prev.filter;
        openKeyboard({
            title: tr('sv.addFilterTitle'), initial: prev.filter, maxLength: 60, ownerStates: buttonStates,
            layout: 'compact', dock: 'bottom', live: true,
            onChange: (txt) => { if (st === prev) { st.filter = txt; st.focus = 0; render(); } },
            // ○ = undo the live filtering (the filter from before opening the keyboard stays)
            onCancel: () => { if (st === prev) { st.filter = before; st.focus = 0; render(); } },
            onConfirm: (txt) => { if (st === prev) { st.filter = String(txt); st.focus = 0; render(); } },
        });
    }

    function pickApp(app) {
        toPreview({
            kind: app.kind, appId: app.appId || null, name: app.name, cmd: app.cmd, args: app.args || [],
            iconFile: app.icon || null, useOwnIcon: !!app.icon, builtinIcon: '', accent: null,
            back: 'apps', apps: st.apps, filter: st.filter, appsFocus: st.focus,
        });
    }

    function askTyped() {
        const draft = { kind: 'custom', name: '', cmd: '', args: [], iconFile: null, useOwnIcon: false, builtinIcon: '', accent: null, back: 'source' };
        const cancel = () => { if (isActive()) toSource(null); };
        const askArgs = () => openKeyboard({
            title: tr('sv.customArgsTitle'), initial: draft.args.join(' '), maxLength: 400, ownerStates: buttonStates,
            onCancel: cancel,
            onConfirm: (txt) => { draft.args = String(txt).split(/\s+/).filter(Boolean); toPreview(draft); },
        });
        const askCmd = () => openKeyboard({
            title: tr('sv.customCmdTitle'), initial: draft.cmd, maxLength: 200, ownerStates: buttonStates,
            onCancel: cancel,
            onConfirm: (txt) => {
                const cmd = String(txt).trim();
                if (!cmd) { showStatus(tr('sv.customCmdRequired'), true); cancel(); return; }
                draft.cmd = cmd;
                askArgs();
            },
        });
        openKeyboard({
            title: tr('sv.customNameTitle'), initial: '', maxLength: 60, ownerStates: buttonStates,
            onCancel: cancel,
            onConfirm: (txt) => {
                const name = String(txt).trim();
                if (!name) { showStatus(tr('sv.customNameRequired'), true); cancel(); return; }
                draft.name = name;
                askCmd();
            },
        });
    }

    function openBrowse() {
        st = { step: 'browse' };
        browser.open(null);
    }

    async function findExecutables(dir) {
        const res = await window.launcher.findLauncherExecutables({ dir }).catch(() => null);
        if (!isActive() || !st || st.step !== 'browse') return;
        const items = (res && res.ok && Array.isArray(res.items)) ? res.items : [];
        if (!items.length) {
            showStatus(tr('sv.addExecNone'), true);
            return;
        }
        browser.reset();
        buttonStates = { cross: true };
        st = { step: 'exec', dir, items, focus: 0 };
        render();
    }

    function pickExecutable(it) {
        const base = it.name.split('/').pop() || it.name;
        const guess = base.replace(/\.appimage$/i, '').replace(/[-_.]?(x86_64|amd64|linux|v?\d[\w.]*)$/ig, '').replace(/[-_]+/g, ' ').trim() || base;
        const dir = st.dir;
        openKeyboard({
            title: tr('sv.customNameTitle'), initial: guess, maxLength: 60, ownerStates: buttonStates,
            onCancel: () => { if (isActive()) render(); },
            onConfirm: (txt) => {
                const name = String(txt).trim() || guess;
                toPreview({
                    kind: 'custom', name, cmd: it.path, args: [], iconFile: null, useOwnIcon: false,
                    builtinIcon: '', accent: null, back: 'exec', dir, items: st.items, execFocus: st.focus,
                });
            },
        });
    }

    function toPreview(draft) {
        buttonStates = { ...buttonStates, cross: true };
        st = { step: 'preview', draft, focus: 0 };
        render();
    }

    function backFromPreview(gp) {
        const d = st.draft;
        if (d.back === 'apps') st = { step: 'apps', apps: d.apps, filter: d.filter, focus: d.appsFocus };
        else if (d.back === 'exec') st = { step: 'exec', dir: d.dir, items: d.items, focus: d.execFocus };
        else { toSource(gp); return; }
        if (gp) syncEdge(buttonStates, gp, ['cross', 'cancel']);
        render();
    }

    async function openIconPick() {
        const icons = await window.launcher.listIcons().catch(() => []);
        if (!isActive() || !st || st.step !== 'preview') return;
        const d = st.draft;
        /** @type {Array<{ type: string, path?: string }>} */
        const rows = [
            ...(d.iconFile ? [{ type: 'own' }] : []),
            { type: 'none' },
            ...(Array.isArray(icons) ? icons : []).map((p) => ({ type: 'builtin', path: p })),
        ];
        const cur = d.builtinIcon
            ? rows.findIndex((r) => r.path === d.builtinIcon)
            : rows.findIndex((r) => r.type === (d.useOwnIcon ? 'own' : 'none'));
        st = { step: 'icon', draft: d, rows, focus: Math.max(0, cur) };
        render();
    }

    function pickIcon(row) {
        const d = st.draft;
        d.builtinIcon = row.type === 'builtin' ? row.path : '';
        d.useOwnIcon = row.type === 'own';
        toPreview(d);
    }

    function renameDraft() {
        const d = st.draft;
        openKeyboard({
            title: tr('sv.customNameTitle'), initial: d.name, maxLength: 60, ownerStates: buttonStates,
            onCancel: () => { if (isActive()) render(); },
            onConfirm: (txt) => { const name = String(txt).trim(); if (name) d.name = name; if (isActive()) render(); },
        });
    }

    function cycleAccent(dir) {
        const pal = palette();
        const d = st.draft;
        const idx = Math.max(0, pal.findIndex((c) => (c.hex || null) === (d.accent || null)));
        d.accent = pal[(idx + dir + pal.length) % pal.length].hex || null;
        render();
    }

    function commit(gp) {
        const d = st.draft;
        const payload = launcherAddPayload(d, typeof launchers !== 'undefined' ? launchers : []);
        window.launcher.addLauncher(payload);
        showStatus(tr('sv.customAdded', { name: d.name.toUpperCase() }));
        close(gp);
    }

    // --- drawing ---

    function iconSrcOf(d) {
        if (d.builtinIcon) return d.builtinIcon;
        if (d.useOwnIcon && d.iconFile) return fileUrl(d.iconFile);
        return FALLBACK_ICON;
    }

    function iconLabel(d) {
        if (d.builtinIcon) return d.builtinIcon.replace(/^assets\/icons\//, '');
        return tr(d.useOwnIcon && d.iconFile ? 'sv.addIconOwn' : 'sv.addIconNone');
    }

    function row(i, focus, inner, extra = '') {
        return `<div class="settings-item${i === focus ? ' focused' : ''}${extra}">${inner}</div>`;
    }

    function thumb(src) {
        return `<img src="${esc(src)}" alt="" class="launcher-icon-thumb" aria-hidden="true" data-icon-fallback>`;
    }

    function render() {
        if (!st || !isActive()) return;
        if (st.step === 'browse') { browser.render(); return; }
        const title = $(ui.title);
        const hint = $(ui.hint);
        const content = $(ui.content);
        if (st.step === 'source') {
            title.textContent = tr('sv.addTitle');
            hint.innerHTML = subviewHint('hint.select');
            content.innerHTML = `<div class="changelog-para">${esc(tr('sv.addIntro'))}</div>`
                + LAUNCHER_ADD_SOURCES.map((s, i) => row(i, st.focus,
                    `<span class="bt-name">${esc(tr(LAUNCHER_ADD_SOURCE_KEYS[s][0]))}</span> <span class="bt-disamb">${esc(tr(LAUNCHER_ADD_SOURCE_KEYS[s][1]))}</span>`)).join('');
        } else if (st.step === 'apps') {
            title.textContent = tr('sv.addAppsTitle');
            hint.innerHTML = subviewHint('hint.select') + `<span>${btnIcon('menu')} ${esc(tr('sv.hintFilter'))}</span>`;
            if (!st.apps) { content.innerHTML = skeletonList(); return; }
            const list = shownApps();
            const bar = st.filter ? `<div class="changelog-para">${esc(tr('sv.addFilterActive', { q: st.filter, back: btnGlyph('back') }))}</div>` : '';
            if (!list.length) {
                content.innerHTML = bar + emptyState(tr(st.filter ? 'sv.addAppsFilterEmpty' : (st.failed ? 'sv.addAppsFailed' : 'sv.addAppsEmpty'), { q: st.filter }));
                return;
            }
            if (st.focus >= list.length) st.focus = list.length - 1;
            content.innerHTML = bar + list.map((a, i) => {
                const tag = a.kind === 'flatpak' ? tr('sv.tagFlatpak') : tr('sv.tagNative');
                const known = a.known ? ` ${currentTag(tr('sv.tagAdded'))}` : '';
                return row(i, st.focus, `${thumb(a.icon ? fileUrl(a.icon) : FALLBACK_ICON)}<span class="bt-name">${esc(a.name)}</span>`
                    + ` <span class="bt-disamb">${esc(tag)}</span>${known}`);
            }).join('');
        } else if (st.step === 'exec') {
            title.textContent = tr('sv.addExecTitle');
            hint.innerHTML = subviewHint('hint.select');
            content.innerHTML = st.items.map((it, i) => row(i, st.focus,
                `<span class="bt-name">${esc(it.name)}</span> <span class="bt-disamb">${esc(st.dir)}</span>`)).join('');
        } else if (st.step === 'icon') {
            title.textContent = tr('sv.customIconTitle');
            hint.innerHTML = subviewHint('hint.select');
            content.innerHTML = st.rows.map((r, i) => {
                if (r.type === 'own') return row(i, st.focus, `${thumb(fileUrl(st.draft.iconFile))}<span class="bt-name">${esc(tr('sv.addIconOwn'))}</span>`);
                if (r.type === 'none') return row(i, st.focus, `<span class="bt-name">${esc(tr('sv.customNoIcon'))}</span>`);
                return row(i, st.focus, `${thumb(r.path)}<span class="bt-name">${esc(r.path.replace(/^assets\/icons\//, ''))}</span>`);
            }).join('');
        } else if (st.step === 'preview') {
            const d = st.draft;
            title.textContent = tr('sv.addPreviewTitle');
            hint.innerHTML = subviewHint('hint.select') + `<span>◀▶ ${esc(tr('sv.hintAccent'))}</span>`;
            const accent = d.accent ? ` style="--preview-accent: ${esc(d.accent)}"` : '';
            const cmdLine = [d.cmd, ...d.args].join(' ');
            const card = `<div class="launcher-add-preview"${accent}>`
                + `<img src="${esc(iconSrcOf(d))}" alt="" aria-hidden="true" data-icon-fallback>`
                + `<div><div class="launcher-add-preview-name">${esc(d.name)}</div>`
                + `<div class="bt-disamb">${esc(cmdLine)}</div></div></div>`;
            const labels = {
                add: `<span class="bt-name">＋ ${esc(tr('sv.addConfirm'))}</span>`,
                name: `<span class="bt-name">${esc(tr('sv.addRowName'))}</span> <span class="bt-disamb">${esc(d.name)}</span>`,
                icon: `<span class="bt-name">${esc(tr('sv.addRowIcon'))}</span> <span class="bt-disamb">${esc(iconLabel(d))}</span>`,
                accent: `<span class="bt-name">${esc(tr('sv.addRowAccent'))}</span> `
                    + (d.accent ? `<span class="launcher-add-swatch" style="background:${esc(d.accent)}"></span>` : `<span class="bt-disamb">${esc(tr('sv.addAccentDefault'))}</span>`),
            };
            content.innerHTML = card + LAUNCHER_ADD_PREVIEW_ROWS.map((r, i) => row(i, st.focus, labels[r])).join('');
        }
        // A broken / missing icon file → the shared `FALLBACK_ICON` (no broken-image sign).
        content.querySelectorAll('img[data-icon-fallback]').forEach((el) => {
            const img = /** @type {HTMLImageElement} */ (el);
            img.addEventListener('error', () => { img.src = FALLBACK_ICON; }, { once: true });
        });
        scroll();
    }

    // --- input ---

    function listNav(gp, count, onSelect, onBack) {
        navList(gp, buttonStates, {
            count,
            move: (d, repeated) => { st.focus = stepIndex(st.focus, d, count, repeated); render(); },
            onSelect, onBack,
        });
    }

    function handle(gp) {
        if (!st) return;
        const step = st.step;
        if (step === 'browse') { browser.handle(gp); return; }
        if (step === 'source') {
            listNav(gp, LAUNCHER_ADD_SOURCES.length, () => {
                const src = LAUNCHER_ADD_SOURCES[st.focus];
                if (src === 'apps') openApps().catch(ignoreError);
                else if (src === 'typed') askTyped();
                else openBrowse();
            }, () => close(gp));
        } else if (step === 'apps') {
            const list = shownApps();
            listNav(gp, list.length, () => { const a = list[st.focus]; if (a) pickApp(a); }, () => {
                if (st.filter) { st.filter = ''; st.focus = 0; render(); return; }
                toSource(gp);
            });
            if (st && st.step === 'apps' && st.apps) edge(buttonStates, 'triangle', gp.buttons[BTN.triangle]?.pressed, () => openFilter());
        } else if (step === 'exec') {
            listNav(gp, st.items.length, () => { const it = st.items[st.focus]; if (it) pickExecutable(it); }, () => {
                const dir = st.dir;
                st = { step: 'browse' };
                browser.open(dir);
            });
        } else if (step === 'icon') {
            listNav(gp, st.rows.length, () => pickIcon(st.rows[st.focus]), () => toPreview(st.draft));
        } else if (step === 'preview') {
            listNav(gp, LAUNCHER_ADD_PREVIEW_ROWS.length, () => {
                const r = LAUNCHER_ADD_PREVIEW_ROWS[st.focus];
                if (r === 'add') commit(gp);
                else if (r === 'name') renameDraft();
                else if (r === 'icon') openIconPick().catch(ignoreError);
                else cycleAccent(1);
            }, () => backFromPreview(gp));
            if (st && st.step === 'preview' && LAUNCHER_ADD_PREVIEW_ROWS[st.focus] === 'accent') {
                edgeRepeat(buttonStates, 'left', gp.buttons[BTN.left]?.pressed, () => cycleAccent(-1));
                edgeRepeat(buttonStates, 'right', gp.buttons[BTN.right]?.pressed, () => cycleAccent(1));
            }
        }
    }

    return {
        open, handle, render,
        isOpen: () => !!st,
        reset: () => { st = null; browser.reset(); },
        // Only for the renderer-smoke test: draws one step directly (without IPC).
        _show: (state) => { st = state; render(); },
    };
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { customLauncherSlug, customLauncherId, filterInstalledApps, launcherAddPayload });
}
