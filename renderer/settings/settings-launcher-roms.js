// Custom ROM-folder source for an added launcher (Launchers □ menu → "Assign games"): folders (＋ with the browser, ✕ = remove) → file type
// (system template OR custom extensions) → launch arguments (`{rom}`) → save. Saving is the `set-custom-game-source` IPC (main normalizes +
// validates); the games show up in the Games panel's "OTHER" source. Load order: AFTER settings-dir-browse.js, BEFORE settings-launchers.js.
// Background: docs/dev/launchers/README.md#custom-rom-folders

// System templates for the file-type step (the most common emulator formats). The name is a system/brand name (not translated); the
// extension list shows in the row too.
const ROM_EXT_PRESETS = [
    { label: 'Nintendo Switch', exts: ['.nsp', '.xci', '.nro'] },
    { label: 'Nintendo 3DS', exts: ['.3ds', '.cci', '.cia'] },
    { label: 'Nintendo DS', exts: ['.nds'] },
    { label: 'Wii U', exts: ['.wua', '.wux', '.rpx'] },
    { label: 'GameCube / Wii', exts: ['.iso', '.rvz', '.wbfs', '.gcm', '.ciso'] },
    { label: 'Nintendo 64', exts: ['.z64', '.n64', '.v64'] },
    { label: 'Game Boy (Color / Advance)', exts: ['.gb', '.gbc', '.gba'] },
    { label: 'SNES / NES', exts: ['.sfc', '.smc', '.nes'] },
    { label: 'PlayStation 1', exts: ['.cue', '.chd', '.pbp', '.m3u'] },
    { label: 'PlayStation 2', exts: ['.iso', '.chd', '.cso'] },
    { label: 'PSP', exts: ['.iso', '.cso', '.pbp'] },
    { label: 'Sega Mega Drive / Genesis', exts: ['.md', '.gen', '.smd'] },
    { label: 'Dreamcast', exts: ['.gdi', '.chd', '.cdi'] },
];

// Typed extension text → normalized list (`iso` → `.iso`, lowercase, deduped). Pure.
function parseRomExts(text) {
    const out = [];
    for (const raw of String(text || '').split(/[\s,;]+/)) {
        if (!raw) continue;
        const e = (raw.startsWith('.') ? raw : `.${raw}`).toLowerCase();
        if (/^\.[a-z0-9]{1,10}$/.test(e) && !out.includes(e)) out.push(e);
    }
    return out;
}

/**
 * @param {Object} o
 * @param {() => boolean} o.isActive is the Launchers subview still open
 * @param {() => void} o.scroll scrolls the focused row into view
 * @param {(gp: any) => void} o.onClose the flow closed (○ on the first step / after saving)
 */
function createLauncherRomsFlow({ isActive, scroll, onClose }) {
    const ui = { content: 'settingsContent', title: 'settingsPanelTitle', hint: 'settingsPanelHint' };
    /** @type {null | { step: string, launcher: { id: string, name: string }, dirs: string[], exts: string[], argsTemplate: string, focus: number }} */
    let st = null;
    let buttonStates = {};

    const browser = createDirBrowser({
        viewId: 'launchers', ui, isActive, scroll,
        isPicked: (p) => !!st && st.dirs.includes(p),
        onPick: (dir) => {
            if (st && !st.dirs.includes(dir)) st.dirs = [...st.dirs, dir];
            browser.close();
        },
        onClose: (gp) => {
            if (!st) return;
            st.step = 'dirs';
            // The choosing ✕ (`close()` without gp) is still held — the folder list must not take it as new.
            if (gp) syncEdge(buttonStates, gp, ['cross', 'cancel']);
            else buttonStates = { ...buttonStates, cross: true };
            render();
        },
    });

    // `source`: the existing setting (when editing) or null.
    function open(launcher, source) {
        buttonStates = { cross: true };
        st = {
            step: 'dirs', launcher,
            dirs: source ? source.dirs.slice() : [],
            exts: source ? source.exts.slice() : [],
            argsTemplate: source ? source.argsTemplate : '{rom}',
            focus: 0,
        };
        render();
    }

    function close(gp) {
        st = null;
        browser.reset();
        onClose(gp);
    }

    // Rows of the folder step: the added folders, "＋ Add folder…", "Next →".
    /** @returns {Array<{ type: string, path?: string }>} */
    function dirRows() {
        return [...st.dirs.map((d) => ({ type: 'dir', path: d })), { type: 'add' }, { type: 'next' }];
    }

    /** @returns {Array<{ type: string, preset?: { label: string, exts: string[] } }>} */
    function extRows() {
        return [...ROM_EXT_PRESETS.map((p) => ({ type: 'preset', preset: p })), { type: 'custom' }];
    }

    function askTemplate() {
        openKeyboard({
            title: tr('sv.romsTemplateTitle'), initial: st.argsTemplate || '{rom}', maxLength: 300, ownerStates: buttonStates,
            onCancel: () => { if (isActive()) render(); },
            onConfirm: (txt) => {
                const t = String(txt).trim();
                st.argsTemplate = t.includes('{rom}') ? t : `${t} {rom}`.trim();
                save().catch(ignoreError);
            },
        });
    }

    function pickExts(exts) {
        st.exts = exts;
        askTemplate();
    }

    function askCustomExts() {
        openKeyboard({
            title: tr('sv.romsExtsKbTitle'), initial: st.exts.join(' '), maxLength: 200, ownerStates: buttonStates,
            onCancel: () => { if (isActive()) render(); },
            onConfirm: (txt) => {
                const exts = parseRomExts(txt);
                if (!exts.length) { showStatus(tr('sv.romsExtsInvalid'), true); render(); return; }
                pickExts(exts);
            },
        });
    }

    async function save() {
        const launcher = st.launcher;
        const res = await window.launcher.setCustomGameSource({
            launcherId: launcher.id, dirs: st.dirs, exts: st.exts, argsTemplate: st.argsTemplate,
        }).catch(() => null);
        if (!res || !res.ok) {
            showStatus(tr('sv.romsFailed', { reason: (res && res.reason) || '?' }), true);
            if (isActive()) render();
            return;
        }
        showStatus(tr('sv.romsSaved', { name: launcher.name.toUpperCase() }));
        await refreshCustomGameSourceIds().catch(ignoreError);
        close(null);
    }

    // --- drawing ---

    function row(i, inner) {
        return `<div class="settings-item${i === st.focus ? ' focused' : ''}">${inner}</div>`;
    }

    function render() {
        if (!st || !isActive()) return;
        if (st.step === 'browse') { browser.render(); return; }
        $(ui.title).textContent = tr('sv.romsTitle', { name: st.launcher.name });
        if (st.step === 'dirs') {
            const rows = dirRows();
            if (st.focus >= rows.length) st.focus = rows.length - 1;
            const onDir = rows[st.focus] && rows[st.focus].type === 'dir';
            $(ui.hint).innerHTML = subviewHint(onDir ? 'sv.hintRemoveDir' : 'hint.select');
            $(ui.content).innerHTML = `<div class="changelog-para">${esc(tr('sv.romsIntro'))}</div>`
                + rows.map((r, i) => {
                    if (r.type === 'dir') return row(i, `<span class="bt-name">${esc(r.path)}</span>`);
                    if (r.type === 'add') return row(i, `<span class="bt-name">＋ ${esc(tr('sv.romsAddDir'))}</span>`);
                    return row(i, `<span class="bt-name">${esc(tr('sv.romsNext'))}</span>`);
                }).join('');
        } else if (st.step === 'exts') {
            $(ui.title).textContent = tr('sv.romsExtsTitle');
            $(ui.hint).innerHTML = subviewHint('hint.select');
            const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
            $(ui.content).innerHTML = extRows().map((r, i) => {
                if (r.type === 'custom') {
                    const cur = st.exts.length && !ROM_EXT_PRESETS.some((p) => same(p.exts, st.exts)) ? ` <span class="bt-disamb">${esc(st.exts.join(' '))}</span>` : '';
                    return row(i, `<span class="bt-name">${esc(tr('sv.romsExtsCustom'))}</span>${cur}`);
                }
                const tag = same(r.preset.exts, st.exts) ? ` ${currentTag(null)}` : '';
                return row(i, `<span class="bt-name">${esc(r.preset.label)}</span> <span class="bt-disamb">${esc(r.preset.exts.join(' '))}</span>${tag}`);
            }).join('');
        }
        scroll();
    }

    // --- input ---

    function handle(gp) {
        if (!st) return;
        if (st.step === 'browse') { browser.handle(gp); return; }
        if (st.step === 'dirs') {
            const rows = dirRows();
            navList(gp, buttonStates, {
                count: rows.length,
                move: (d, repeated) => { st.focus = stepIndex(st.focus, d, rows.length, repeated); render(); },
                onSelect: () => {
                    const r = rows[st.focus];
                    if (r.type === 'dir') { st.dirs = st.dirs.filter((d) => d !== r.path); render(); return; }
                    if (r.type === 'add') { st.step = 'browse'; browser.open(st.dirs[st.dirs.length - 1] || null); return; }
                    if (!st.dirs.length) { showStatus(tr('sv.romsNoDir'), true); return; }
                    st.step = 'exts';
                    st.focus = 0;
                    render();
                },
                onBack: () => close(gp),
            });
        } else if (st.step === 'exts') {
            const rows = extRows();
            navList(gp, buttonStates, {
                count: rows.length,
                move: (d, repeated) => { st.focus = stepIndex(st.focus, d, rows.length, repeated); render(); },
                onSelect: () => {
                    const r = rows[st.focus];
                    if (r.type === 'custom') askCustomExts();
                    else pickExts(r.preset.exts.slice());
                },
                onBack: () => { st.step = 'dirs'; st.focus = 0; render(); },
            });
        }
    }

    // Deletes the launcher's custom source (□ menu "Detach games").
    async function clear(launcher) {
        const res = await window.launcher.setCustomGameSource({ launcherId: launcher.id, remove: true }).catch(() => null);
        if (res && res.ok) showStatus(tr('sv.romsCleared', { name: launcher.name.toUpperCase() }));
        else showStatus(tr('sv.romsFailed', { reason: (res && res.reason) || '?' }), true);
        await refreshCustomGameSourceIds().catch(ignoreError);
    }

    return {
        open, handle, render, clear,
        isOpen: () => !!st,
        reset: () => { st = null; browser.reset(); },
        // Only for the renderer-smoke test: draws one step directly (without IPC).
        _show: (state) => { st = state; render(); },
    };
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { ROM_EXT_PRESETS, parseRomExts });
}
