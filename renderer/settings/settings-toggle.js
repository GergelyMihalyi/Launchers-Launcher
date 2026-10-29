// Two uniform "On/Off switch" subview factories. `createToggleSubview(cfg)` for a single logical switch (immediate effect, no confirmation),
// returns `{ open, handle }` — the calling file registers it itself with `SETTINGS_VIEWS['<id>'] = createToggleSubview({...})`
// (`test/contracts/settings-views.test.js` looks for the literal pattern, so the registration cannot move into the factory).
// `createMultiToggleSubview(cfg)` (below) for N independent switches in one list. Background: docs/dev/renderer/overview.md#settings-view-factories
//
// `cfg`: { id, hintKey, onLabelKey, offLabelKey, defaultOn, get, set }
//   - id: the SETTINGS_MENU/SETTINGS_VIEWS key (the title is `tr('menu.' + id)`); hintKey/onLabelKey/offLabelKey: `tr()` keys
//   - defaultOn: initial/fallback value (with `true` the stored value is coerced as `!== false`, with `false` as `=== true`)
//   - get: () => Promise<boolean>; set: (boolean) => void (fire-and-forget)
// Load order: AFTER settings.js, BEFORE every calling subview file.
function createToggleSubview({
    id, hintKey, onLabelKey, offLabelKey, defaultOn, get, set,
}) {
    const rows = [
        { id: true, labelKey: onLabelKey },
        { id: false, labelKey: offLabelKey },
    ];
    let focusIndex = 0;
    let buttonStates = {};
    let current = defaultOn;

    function render() {
        const rowsHtml = rows.map((row, i) => {
            const tag = row.id === current ? ` ${currentTag()}` : '';
            return `<div class="settings-item ${i === focusIndex ? 'focused' : ''}"><span class="bt-name">${esc(tr(row.labelKey))}</span>${tag}</div>`;
        }).join('');
        $('settingsContent').innerHTML = `<div class="settings-subhead">${esc(tr(hintKey))}</div>${rowsHtml}`;
        scrollSettingsFocusIntoView();
    }

    async function open() {
        setSubviewFrame({ title: tr(`menu.${id}`), hint: 'hint.select', skeleton: true });
        buttonStates = { cross: true };

        const fetched = await get().catch(() => defaultOn);
        if (settingsView !== id) return; // left meanwhile
        current = defaultOn ? fetched !== false : fetched === true;
        focusIndex = current ? 0 : 1;
        render();
    }

    function handle(gp) {
        navList(gp, buttonStates, {
            count: rows.length,
            move: (d, repeated) => {
                const n = rows.length;
                focusIndex = stepIndex(focusIndex, d, n, repeated);
                render();
            },
            onSelect: () => {
                const row = rows[focusIndex];
                if (!row || row.id === current) return;
                current = row.id; // immediate live effect (UI)
                set(row.id);      // persist (+ any sidecar/autostart) + feedback
                render();
            },
            onBack: () => backToSettingsMenu(gp),
        });
    }

    // Called by the push feedback (`onToggleChanged` of renderer/ipc.js): `set()` is fire-and-forget and `onSelect` sets `current`
    // optimistically — if the actual write failed, this aligns the view back to the real value (if it is open).
    function setCurrent(value) {
        current = !!value;
        focusIndex = current ? 0 : 1;
        if (settingsView === id) render();
    }

    return {
        open, handle, render, setCurrent,
    };
}

// "N INDEPENDENT On/Off switches in ONE list" subview factory (settings-feedback/-accessibility/-recent-games/-output-behavior).
// `cfg`: { id, hintKey, rows, getState, setState, persist, afterToggle, preload }
//   - rows: [{ key, labelKey }] OR () => [...] (dynamic row list, e.g. the CEC-guarded rows)
//   - getState()/setState(next): closures over the caller's OWN top-level `let` (the name stays, other files — e.g. renderer/ipc.js —
//     reference it directly after a server feedback)
//   - persist(patch): the `window.launcher.setXxx(patch)` call; afterToggle(row, next): an optional side effect (e.g. an `<html>` attribute)
//   - preload(): optional ASYNC preload on `open()`; if the user left meanwhile (`settingsView !== id`), it does not render
// Returns: `{ open, handle, render }` — the caller exposes `render` as its OWN `renderXxxView` (the ipc.js handlers call that NAME).
/**
 * @param {Object} cfg
 * @param {string} cfg.id
 * @param {string} cfg.hintKey
 * @param {Array<{ key: string, labelKey: string }>|(() => Array<{ key: string, labelKey: string }>)} cfg.rows
 * @param {() => Object} cfg.getState
 * @param {(next: Object) => void} cfg.setState
 * @param {(patch: Object) => void} cfg.persist
 * @param {(row: { key: string, labelKey: string }, next: boolean) => void} [cfg.afterToggle]  AFTER the toggle (e.g. `applyMotionPref`)
 * @param {() => (void|Promise<void>)} [cfg.preload]
 */
function createMultiToggleSubview({
    id, hintKey, rows, getState, setState, persist, afterToggle, preload,
}) {
    let focusIndex = 0;
    let buttonStates = {};

    const currentRows = () => (typeof rows === 'function' ? rows() : rows);

    function render() {
        const list = currentRows();
        if (focusIndex >= list.length) focusIndex = 0;
        const state = getState();
        $('settingsContent').innerHTML = list.map((row, i) => {
            const on = state[row.key] !== false;
            return `<div class="settings-item ${i === focusIndex ? 'focused' : ''}">${esc(tr(row.labelKey))} — ${currentTag(tr(on ? 'on' : 'off'))}</div>`;
        }).join('');
        scrollSettingsFocusIntoView();
    }

    async function open() {
        setSubviewFrame({ title: tr(`menu.${id}`), hint: hintKey });
        // Entered from the menu with X; while it is held, it must not count as an immediate toggle.
        buttonStates = { cross: true };
        focusIndex = 0;
        if (preload) {
            $('settingsContent').innerHTML = skeletonList(currentRows().length || 3);
            await preload();
            if (settingsView !== id) return; // left meanwhile
        }
        render();
    }

    function handle(gp) {
        const list = currentRows();
        navList(gp, buttonStates, {
            count: list.length,
            move: (d, repeated) => {
                focusIndex = stepIndex(focusIndex, d, list.length, repeated);
                render();
            },
            onSelect: () => {
                const row = list[focusIndex];
                if (!row) return;
                const next = getState()[row.key] === false;
                setState({ ...getState(), [row.key]: next }); // immediate live effect
                persist({ [row.key]: next });                  // persist + feedback
                if (afterToggle) afterToggle(row, next);
                render();
            },
            onBack: () => backToSettingsMenu(gp),
        });
    }

    return { open, handle, render };
}

// N-item "pick one" subview factory (ui-scale, sleep-timer). The current value is maintained OUTSIDE (`getCurrent()`), not loaded on `open()`.
// cfg: { id, subheadKey?, rows: [{ id, labelKey }], getCurrent, onSelect, tagFor? }
//   - onSelect(row): live apply and/or persist — the caller decides whether it runs on a repeated selection too
//   - tagFor(row, isCurrent): optional row-end badge HTML (default: `currentTag()` for the current one; the sleep timer's live countdown label)
/**
 * @param {Object} cfg
 * @param {string} cfg.id
 * @param {string} [cfg.subheadKey]
 * @param {Array<Object>} cfg.rows
 * @param {() => any} cfg.getCurrent
 * @param {(row: any) => void} cfg.onSelect
 * @param {(row: any, isCurrent: boolean) => string} [cfg.tagFor]
 */
function createSelectSubview({
    id, subheadKey, rows, getCurrent, onSelect, tagFor,
}) {
    let focusIndex = 0;
    let buttonStates = {};

    function render() {
        const current = getCurrent();
        const rowsHtml = rows.map((row, i) => {
            const isCurrent = row.id === current;
            const tag = tagFor ? tagFor(row, isCurrent) : (isCurrent ? ` ${currentTag()}` : '');
            return `<div class="settings-item ${i === focusIndex ? 'focused' : ''}"><span class="bt-name">${esc(tr(row.labelKey))}</span>${tag}</div>`;
        }).join('');
        $('settingsContent').innerHTML = (subheadKey ? `<div class="settings-subhead">${esc(tr(subheadKey))}</div>` : '') + rowsHtml;
        scrollSettingsFocusIntoView();
    }

    function open() {
        setSubviewFrame({ title: tr(`menu.${id}`), hint: 'hint.select' });
        buttonStates = { cross: true };
        focusIndex = Math.max(0, rows.findIndex((r) => r.id === getCurrent()));
        render();
    }

    function handle(gp) {
        navList(gp, buttonStates, {
            count: rows.length,
            move: (d, repeated) => { focusIndex = stepIndex(focusIndex, d, rows.length, repeated); render(); },
            onSelect: () => { const row = rows[focusIndex]; if (row) onSelect(row); render(); },
            onBack: () => backToSettingsMenu(gp),
        });
    }

    return { open, handle, render };
}

// A numeric "pick one" pref persisted in main (screensaver / volume step / volume cap / TV-mode exit time) — builds on `createSelectSubview`, but
// keeps the current value ITSELF: `load()` at startup (renderer/ipc.js), `setCurrent(v)` on the `*-changed` push (the value confirmed by main).
// `apply(v)` is the renderer-side live effect (may be omitted for a pref with a main-side effect). The push handling and the toast are wired by
// `onPrefSelectChanged` of renderer/ipc.js through `SETTINGS_VIEWS[id]`.
// cfg: { id, subheadKey?, rows: [{ id, labelKey }], defaultValue, get, set, apply? }
/**
 * @param {Object} cfg
 * @param {string} cfg.id
 * @param {string} [cfg.subheadKey]
 * @param {Array<{ id: any, labelKey: string }>} cfg.rows
 * @param {any} cfg.defaultValue
 * @param {() => Promise<any>} cfg.get
 * @param {(v: any) => void} cfg.set
 * @param {(v: any) => void} [cfg.apply]
 */
function createPrefSelectSubview({
    id, subheadKey, rows, defaultValue, get, set, apply,
}) {
    let current = defaultValue;
    const normalize = (v) => (rows.some((r) => r.id === v) ? v : defaultValue);

    const view = createSelectSubview({
        id,
        subheadKey,
        rows,
        getCurrent: () => current,
        onSelect: (row) => {
            if (row.id === current) return;
            setCurrent(row.id); // immediate live effect
            set(row.id);        // persist + feedback
        },
    });

    function setCurrent(value) {
        current = normalize(value);
        if (apply) apply(current);
        if (settingsView === id) view.render();
    }

    function load() {
        return get().then(setCurrent).catch(ignoreError);
    }

    // For the toast: the value's label (`tr` key), for an unknown one the default row's.
    function labelKeyFor(value) {
        const row = rows.find((r) => r.id === normalize(value));
        return row ? row.labelKey : '';
    }

    return {
        ...view, setCurrent, load, labelKeyFor,
    };
}
