// First-start setup wizard (startup monitor / audio device / main controller / theme): a standalone overlay (#setupOverlay) with the
// .settings-* CSS, NOT a Settings subview. It ONLY records the choices, the `finish-setup` IPC applies them; live preview only for the theme.
// Load order: AFTER settings-*.js, BEFORE ipc.js. Background: docs/dev/renderer/settings.md#setup-wizard

// The "real" steps + the frame (welcome/done). wizStepInfo() is pure (does not call tr() — the renderer resolves the label with
// `wizStepLabel(id)`). Tested. The `controls` (button-layout help) frame step: nothing to choose, it does not count.
const WIZ_SEQ = ['welcome', 'language', 'launchers', 'monitor', 'sink', 'controller', 'theme', 'controls', 'done'];
const WIZ_REAL = ['language', 'launchers', 'monitor', 'sink', 'controller', 'theme'];
const WIZ_LABEL_KEY = {
    language: 'wizard.stepLanguage',
    launchers: 'wizard.stepLaunchers',
    monitor: 'wizard.stepMonitor',
    sink: 'wizard.stepSink',
    controller: 'wizard.stepController',
    theme: 'wizard.stepTheme',
    controls: 'wizard.stepControls',
    done: 'wizard.done',
};

// What the missing system commands are needed for (`REQUIRED_COMMANDS` of `lib/host-deps/selftest.js`) — literal i18n keys (checked by
// test/contracts/i18n-keys.test.js).
const WIZ_CMD_PURPOSE = {
    pactl: 'wizard.cmdAudio',
    'kscreen-doctor': 'wizard.cmdMonitor',
    bluetoothctl: 'wizard.cmdBluetooth',
    flatpak: 'wizard.cmdFlatpak',
    git: 'wizard.cmdUpdate',
};

// The check of the "Done" step: names of the chosen but not installed launchers + the missing system commands. Pure (without `tr`) —
// test/setup-wizard.test.js.
function wizCheckSummary(choices, data) {
    const catalog = (choices && Array.isArray(choices.catalog)) ? choices.catalog : [];
    const chosen = new Set((data && Array.isArray(data.addLaunchers)) ? data.addLaunchers : []);
    const selftest = (choices && Array.isArray(choices.selftest)) ? choices.selftest : [];
    return {
        notInstalled: catalog.filter((c) => chosen.has(c.id) && c.installed === false).map((c) => c.name),
        missingCommands: selftest.filter((r) => r && r.ok === false).map((r) => r.cmd),
        checked: selftest.length > 0,
    };
}

// stepIndex -> { id, counter } — counter e.g. "2 / 5" for the real steps, '' for the frame.
function wizStepInfo(stepIndex) {
    const id = WIZ_SEQ[Math.max(0, Math.min(WIZ_SEQ.length - 1, stepIndex))] || 'welcome';
    const ri = WIZ_REAL.indexOf(id);
    return { id, counter: ri === -1 ? '' : `${ri + 1} / ${WIZ_REAL.length}` };
}

// The step's label from `tr()` (called by the renderer; wizStepInfo stays pure).
function wizStepLabel(id) {
    return tr(WIZ_LABEL_KEY[id] || 'wizard.intro');
}

// Node/test: `createOverlay` from renderer/util.js (a global <script> loaded EARLIER in the browser) — the `createOverlay(...)` call at the
// top of the file needs it on require too.
if (typeof createOverlay === 'undefined' && typeof module !== 'undefined') {
    Object.assign(globalThis, { createOverlay: module.require('./util.js').createOverlay });
}

let wizIsRerun = false;
let wizStep = 0;
let wizFocus = 0;
let wizData = { language: null, addLaunchers: [], launcherVariants: {}, monitor: null, sink: null, mainController: null, theme: null };
let wizChoices = {
    monitors: [], sinks: [], controllers: [], themes: [], catalog: [], selftest: [],
    monitorsOk: true, sinksOk: true, controllersOk: true, // false on `{ ok:false }` of `list-*`
};
let wizThemeAtOpen = null; // the starting theme — restored on ○ in a re-run
let wizLangAtOpen = null;  // the starting language — restored on ○ in a re-run

// The explanatory line of a list step when there is nothing to choose: tells "empty" apart from "query failed" (headless start / missing
// kscreen-doctor / pactl). Returns `tr` keys (the renderer resolves them) — so the helper stays pure and test/setup-wizard.test.js can check
// at key level.
function wizListNote(stepId, choices) {
    const map = {
        monitor: ['monitors', 'wizard.noteMonitorEmpty', 'wizard.noteMonitorFail'],
        sink: ['sinks', 'wizard.noteSinkEmpty', 'wizard.noteSinkFail'],
        controller: ['controllers', 'wizard.noteControllerEmpty', 'wizard.noteControllerFail'],
    };
    const entry = map[stepId];
    if (!entry) return '';
    const [key, emptyKey, failKey] = entry;
    if (((choices && choices[key]) || []).length) return '';
    return (choices && choices[key + 'Ok'] === false) ? failKey : emptyKey;
}

// Lifecycle on the shared `createOverlay` (renderer/util.js).
const setupWizard = createOverlay({
    elementId: 'setupOverlay',
    // Re-run: entered from the menu with X — while it is held, no immediate choice. First start: the wizard comes up by itself, no held button
    // → empty state.
    enterStates: (isRerun) => (isRerun ? { cross: true } : {}),
    // The main nav's buttonStates were not updated while the wizard was open — sync with the physical state so a still pressed X/PS does not
    // launch a card / quit.
    syncOnClose: () => ({ states: buttonStates, keys: ['cross', 'ps', 'triangle'] }),
    onOpen: (isRerun) => { loadSetupWizard(isRerun); },
});

function openSetupWizard(isRerun) { setupWizard.open(isRerun); }

async function loadSetupWizard(isRerun) {
    if (wizPathFlow) wizPathFlow.reset();
    wizIsRerun = !!isRerun;
    wizStep = 0;
    wizFocus = 0;
    wizLangAtOpen = activeLanguage();
    wizData = { language: activeLanguage(), addLaunchers: [], launcherVariants: {}, monitor: null, sink: null, mainController: null, theme: null };
    renderWizStep();

    // Per-promise catch: one failed query must not blank the whole wizard.
    const [mRes, sRes, cRes, themes, dispCfg, mc, curTheme, catalog, selftest] = await Promise.all([
        window.launcher.listMonitors().catch(() => ({ ok: false, items: [] })),
        window.launcher.listAudioSinks().catch(() => ({ ok: false, items: [] })),
        window.launcher.listBtDevices('controller').catch(() => ({ ok: false, items: [] })),
        window.launcher.listThemes().catch(() => []),
        window.launcher.getDisplayConfig().catch(() => ({})),
        window.launcher.getMainController().catch(() => null),
        window.launcher.getTheme().catch(() => null),
        window.launcher.listLauncherCatalog().catch(() => []),
        window.launcher.getSelftest().catch(() => []),
    ]);
    if (!setupWizard.isOpen()) return;

    // Catalog: the `common` ones (steam/heroic/retroarch) first, then the installed ones, then by name.
    wizChoices.catalog = (Array.isArray(catalog) ? catalog : []).slice().sort((a, b) =>
        (Number(!!b.common) - Number(!!a.common))
        || (Number(b.installed === true) - Number(a.installed === true))
        || String(a.name).localeCompare(String(b.name)));
    // Checked by default: the INSTALLED common ones (steam/heroic/retroarch). Already active (`active`) launchers are checked too (re-run) —
    // `finish-setup` skips the existing ones. For a dual-variant entry `installed` may also be a string ('native'/'flatpak'/'both').
    wizData.addLaunchers = wizChoices.catalog
        .filter((c) => c.active || (c.common && !!c.installed))
        .map((c) => c.id);

    wizChoices.monitors = Array.isArray(mRes.items) ? mRes.items : [];
    wizChoices.monitorsOk = mRes.ok !== false;
    wizChoices.sinks = Array.isArray(sRes.items) ? sRes.items : [];
    wizChoices.sinksOk = sRes.ok !== false;
    wizChoices.controllers = Array.isArray(cRes.items) ? cRes.items : [];
    wizChoices.controllersOk = cRes.ok !== false;
    wizChoices.themes = Array.isArray(themes) ? themes : [];
    wizChoices.selftest = Array.isArray(selftest) ? selftest : [];
    wizData.monitor = (dispCfg && dispCfg.monitor) || null;
    wizData.sink = (dispCfg && dispCfg.sink) || null;
    wizData.mainController = mc || null;
    wizData.theme = curTheme || (wizChoices.themes[0] && wizChoices.themes[0].id) || null;
    wizThemeAtOpen = wizData.theme;
    renderWizStep();
}

function closeSetupWizard(gp) { setupWizard.close(gp); }

// --- Launcher step ---
function wizLauncherChecked(id) {
    return wizData.addLaunchers.includes(id);
}
// Native/flatpak variant: only selectable (□) if BOTH variants are installed — flatpak (recommended) by default; with one variant main
// adds that one.
function wizLauncherVariant(id) {
    return wizData.launcherVariants[id] === 'native' ? 'native' : 'flatpak';
}
function toggleWizLauncherVariant(id) {
    wizData.launcherVariants = { ...wizData.launcherVariants, [id]: wizLauncherVariant(id) === 'native' ? 'flatpak' : 'native' };
}
// Manual folder: if the automatic search does not find the program, □ → folder browser (the shared settings-launcher-path.js flow, drawn
// into the wizard's own `#setup*` elements). `apply: false` — only saves it; `finish-setup` does the adding.
let wizPathFlow = null;
function getWizPathFlow() {
    if (!wizPathFlow) {
        wizPathFlow = createLauncherPathFlow({
            viewId: 'wizard',
            ui: { content: 'setupContent', title: 'setupPanelTitle', hint: 'setupPanelHint' },
            isActive: () => setupWizard.isOpen(),
            scroll: () => {
                const f = document.querySelector('#setupContent .settings-item.focused');
                if (f) f.scrollIntoView({ block: 'nearest' });
            },
            apply: false,
            onDone: (entry) => { wizReloadCatalog(entry.id).catch(ignoreError); },
            onClose: (gp) => {
                if (gp) syncEdge(setupWizard.states, gp, ['cross', 'cancel', 'square']);
                renderWizStep();
            },
        });
    }
    return wizPathFlow;
}

// After saving the manual folder: fresh detection, the launcher checked.
async function wizReloadCatalog(id) {
    const catalog = await window.launcher.listLauncherCatalog().catch(() => null);
    if (!setupWizard.isOpen() || !Array.isArray(catalog)) return;
    const byId = new Map(catalog.map((c) => [c.id, c]));
    wizChoices.catalog = wizChoices.catalog.map((c) => byId.get(c.id) || c);
    if (!wizData.addLaunchers.includes(id)) wizData.addLaunchers = [...wizData.addLaunchers, id];
    setupWizard.states.cross = true; // the ✕ that triggered the save may still be held
    renderWizStep();
}

// The sub-line of a catalog row: installation state + (with both variants) the chosen variant.
function wizLauncherSub(c) {
    if (c.installed === false) return tr('wizard.notInstalled');
    if (c.manualPath && (c.installed === 'native' || c.installed === 'both')) {
        return tr('wizard.installedManual', { path: c.manualPath });
    }
    if (c.installed === 'both') {
        return `${tr('wizard.installedBoth')} · ${tr(wizLauncherVariant(c.id) === 'native' ? 'wizard.variantNative' : 'wizard.variantFlatpak')}`;
    }
    if (c.installed === 'native') return tr('wizard.installedNative');
    return c.installed ? tr('wizard.installed') : '';
}
function toggleWizLauncher(id) {
    if (wizData.addLaunchers.includes(id)) {
        wizData.addLaunchers = wizData.addLaunchers.filter((x) => x !== id);
    } else {
        wizData.addLaunchers = [...wizData.addLaunchers, id];
    }
}

// The selectable rows of the current step: { label, sub?, chosen?, check?, onSelect }.
/**
 * The rows of the wizard's current step.
 * @returns {Array<{ label: string, sub?: string, icon?: string, check?: boolean, chosen?: boolean, onSelect: () => void, onAlt?: () => void, altKey?: string }>}
 */
function wizRows() {
    const { id } = wizStepInfo(wizStep);
    if (id === 'language') {
        return LANGUAGES.map((lang) => ({
            label: LANG_LABELS[lang] || lang,
            chosen: wizData.language === lang,
            onSelect: () => {
                wizData.language = lang;
                setActiveLanguage(lang);              // live preview
                window.launcher.setLanguage(lang);   // persists immediately too
                wizNext();
            },
        }));
    }
    if (id === 'launchers') {
        // Multi-select: X = toggle (does not advance), the closing "Next" row advances.
        return [
            ...wizChoices.catalog.map((c) => ({
                label: c.name,
                sub: wizLauncherSub(c),
                check: wizLauncherChecked(c.id),
                onSelect: () => { toggleWizLauncher(c.id); feedback('nav'); renderWizStep(); },
                ...(c.installed === 'both' && !c.active ? {
                    altKey: 'wizard.hintVariant',
                    onAlt: () => { toggleWizLauncherVariant(c.id); feedback('nav'); renderWizStep(); },
                } : (c.nativeCmd && !c.active ? {
                    altKey: 'wizard.hintSetPath',
                    onAlt: () => { feedback('nav'); getWizPathFlow().open(c); },
                } : {})),
            })),
            { label: tr('wizard.next'), onSelect: () => wizNext() },
        ];
    }
    if (id === 'monitor') {
        return [
            ...wizChoices.monitors.map((m) => ({
                label: m.label, chosen: wizData.monitor === m.name,
                onSelect: () => { wizData.monitor = m.name; wizNext(); },
            })),
            { label: tr('wizard.skip'), onSelect: () => { wizData.monitor = null; wizNext(); } },
        ];
    }
    if (id === 'sink') {
        return [
            ...wizChoices.sinks.map((s) => ({
                label: s.description || s.name, chosen: wizData.sink === s.name,
                onSelect: () => { wizData.sink = s.name; wizNext(); },
            })),
            { label: tr('wizard.skip'), onSelect: () => { wizData.sink = null; wizNext(); } },
        ];
    }
    if (id === 'controller') {
        // Connected first (like Settings → Main controller), MAC tail on a name clash.
        const ctrls = [...wizChoices.controllers].sort(
            (a, b) => (Number(b.connected) - Number(a.connected)) || (a.name || '').localeCompare(b.name || ''),
        );
        const nameCounts = {};
        ctrls.forEach((c) => { nameCounts[c.name] = (nameCounts[c.name] || 0) + 1; });
        return [
            {
                label: tr('wizard.anyController'), sub: tr('wizard.noFilter'),
                chosen: !wizData.mainController,
                onSelect: () => { wizData.mainController = null; wizNext(); },
            },
            ...ctrls.map((c) => {
                const disamb = nameCounts[c.name] > 1 ? ` · …${c.mac.slice(-5)}` : '';
                return {
                    label: c.name || c.mac,
                    sub: (c.connected ? tr('wizard.connected') : tr('wizard.paired')) + disamb,
                    icon: c.type,
                    chosen: !!(wizData.mainController && wizData.mainController.mac === c.mac),
                    onSelect: () => {
                        wizData.mainController = { mac: c.mac, name: c.name, type: c.type };
                        wizNext();
                    },
                };
            }),
        ];
    }
    if (id === 'theme') {
        return wizChoices.themes.map((t) => ({
            label: t.label, chosen: wizData.theme === t.id,
            onSelect: () => { wizData.theme = t.id; wizNext(); },
        }));
    }
    return [];
}

function renderWizStep() {
    const info = wizStepInfo(wizStep);
    const label = wizStepLabel(info.id);
    $('setupPanelTitle').textContent = info.counter
        ? tr('wizard.title', { counter: info.counter, label })
        : label;

    const el = $('setupContent');
    if (info.id === 'welcome') {
        // the logo (wordmark) above the intro; a static, trusted markup — the alt is empty (decorative, the title says the name)
        el.innerHTML = `<img class="wizard-logo" src="assets/logo/logo-wordmark.svg" alt="">${emptyState(tr('wizard.welcome'))}`;
        wizHint(false);
        return;
    }
    if (info.id === 'controls') {
        el.innerHTML = `<div class="changelog-para">${esc(tr('wizard.controlsIntro'))}</div>${controlsHelpGridHtml()}`;
        wizHint(false);
        return;
    }
    if (info.id === 'done') {
        const parts = [
            `${tr('wizard.sLaunchers')}: ${wizData.addLaunchers.length}`,
            `${tr('wizard.sMonitor')}: ${wizData.monitor || tr('wizard.vSkipped')}`,
            `${tr('wizard.sSink')}: ${wizData.sink ? tr('wizard.vChosen') : tr('wizard.vSkipped')}`,
            `${tr('wizard.sController')}: ${wizData.mainController ? (wizData.mainController.name || wizData.mainController.mac) : tr('wizard.vAny')}`,
            `${tr('wizard.sTheme')}: ${wizData.theme || tr('wizard.vDefault')}`,
        ];
        // What is installed / what is missing.
        const check = wizCheckSummary(wizChoices, wizData);
        const checkLines = [];
        if (check.notInstalled.length) {
            checkLines.push(`⚠ ${esc(tr('wizard.checkNotInstalled', { names: check.notInstalled.join(', ') }))}`);
        }
        if (check.missingCommands.length) {
            const list = check.missingCommands.map((c) => `${c} (${tr(WIZ_CMD_PURPOSE[c] || 'wizard.cmdOther')})`).join(', ');
            checkLines.push(`⚠ ${esc(tr('wizard.checkMissingCommands', { list }))}`);
            // □ = install the missing ones with the system package manager (`runHostPackageInstall` of settings-diagnostics.js).
            checkLines.push(hostInstallRunning
                ? `… ${esc(tr('wizard.installRunning'))}`
                : `${esc(btnGlyph('alt'))} ${esc(tr('wizard.installMissing'))}`);
        }
        if (!checkLines.length && check.checked) checkLines.push(`✓ ${esc(tr('wizard.checkAllOk'))}`);
        el.innerHTML = `<div class="settings-empty">${esc(tr('wizard.doneSummary', { parts: parts.join(' · ') }))}<br><br>`
            + (checkLines.length ? `<span class="wiz-check">${checkLines.join('<br>')}</span><br><br>` : '')
            + `${tr('wizard.doneToLauncher', { confirm: btnGlyph('confirm') })}`
            + `${wizData.monitor ? `<br><br>${esc(tr('wizard.doneMonitorNote'))}` : ''}</div>`;
        wizHint(false);
        return;
    }

    const rows = wizRows();
    const noteKey = wizListNote(info.id, wizChoices);
    const noteHtml = noteKey ? emptyState(tr(noteKey)) : '';
    const stepNote = info.id === 'launchers'
        ? `<div class="changelog-para">${esc(tr('wizard.launchersHint'))}</div>` : '';
    if (!rows.length) {
        el.innerHTML = noteHtml || emptyState(tr('wizard.noneChoosable', { confirm: btnGlyph('confirm') }));
    } else {
        if (wizFocus >= rows.length) wizFocus = rows.length - 1;
        el.innerHTML = noteHtml + stepNote + rows.map((r, i) => {
            const box = r.check === true ? '☑ ' : (r.check === false ? '☐ ' : '');
            const icon = r.icon
                ? `<span class="bt-icon">${CONTROLLER_ICONS[r.icon] || CONTROLLER_ICONS.generic}</span>` : '';
            const sub = r.sub ? ` <span class="bt-disamb">${esc(r.sub)}</span>` : '';
            const tag = r.chosen ? ` ${currentTag(tr('wizard.current'))}` : '';
            return `<div class="settings-item ${i === wizFocus ? 'focused' : ''}">${box}${icon}<span class="bt-name">${esc(r.label)}</span>${sub}${tag}</div>`;
        }).join('');
    }
    wizHint(true);
    requestAnimationFrame(() => {
        const f = document.querySelector('#setupContent .settings-item.focused');
        if (f) f.scrollIntoView({ block: 'nearest' });
    });
}

function wizHint(hasList) {
    const back = wizStep > 0 ? tr('wizard.hintPrev') : (wizIsRerun ? tr('wizard.hintCancel') : '');
    const stepId = wizStepInfo(wizStep).id;
    const confirm = stepId === 'done' ? tr('wizard.hintFinish')
        : stepId === 'controls' ? tr('hint.next')
        : stepId === 'launchers' ? tr('wizard.hintToggle')
            : tr('wizard.hintConfirmStep');
    const install = stepId === 'done' && wizCheckSummary(wizChoices, wizData).missingCommands.length > 0;
    const focusedRow = hasList ? wizRows()[wizFocus] : null;
    const altKey = focusedRow && focusedRow.onAlt ? focusedRow.altKey : null;
    $('setupPanelHint').innerHTML = `
        ${hasList ? `<span>▲▼ ${esc(tr('wizard.hintNav'))}</span>` : ''}
        <span>${btnIcon('confirm')} ${esc(confirm)}</span>
        ${install ? `<span>${btnIcon('alt')} ${esc(tr('wizard.hintInstall'))}</span>` : ''}
        ${altKey ? `<span>${btnIcon('alt')} ${esc(tr(altKey))}</span>` : ''}
        ${back ? `<span>${btnIcon('back')} ${esc(back)}</span>` : ''}
    `;
}

function wizNext() {
    if (wizStep >= WIZ_SEQ.length - 1) return; // X on 'done' already commits (wizCommit)
    wizStep += 1;
    wizFocus = wizInitialFocus();
    feedback('nav');
    renderWizStep();
}

// Where the focus goes when entering the step: onto the `chosen` row (current setting / theme), or for the controller step onto the
// connected one if no main controller is set yet.
function wizInitialFocus() {
    const rows = wizRows();
    const chosen = rows.findIndex((r) => r.chosen);
    if (chosen > 0) return chosen;
    if (wizStepInfo(wizStep).id === 'controller' && wizChoices.controllers.some((c) => c.connected)) {
        return 1; // the first real row = the connected one (because of the connected-first sort)
    }
    return 0;
}

function wizPrev(gp) {
    if (wizStep > 0) {
        // When stepping back from the theme step, reset the live preview to the chosen one.
        wizStep -= 1;
        wizFocus = wizInitialFocus();
        if (wizData.theme) applyTheme(wizData.theme);
        feedback('back');
        renderWizStep();
    } else if (wizIsRerun) {
        if (wizThemeAtOpen) applyTheme(wizThemeAtOpen); // discard the live theme preview
        window.launcher.getTheme().then(applyTheme).catch(ignoreError);
        if (wizLangAtOpen && wizLangAtOpen !== activeLanguage()) {
            setActiveLanguage(wizLangAtOpen);
            window.launcher.setLanguage(wizLangAtOpen);
        }
        closeSetupWizard(gp);
    }
}

function wizCommit(gp) {
    suppressLaunchersToast = true; // do not toast the launchers-changed push of finish-setup
    window.launcher.finishSetup({
        language: wizData.language,
        addLaunchers: wizData.addLaunchers,
        launcherVariants: wizData.launcherVariants,
        monitor: wizData.monitor,
        sink: wizData.sink,
        mainController: wizData.mainController,
        theme: wizData.theme,
    });
    if (wizData.language) { setActiveLanguage(wizData.language); window.launcher.setLanguage(wizData.language); }
    if (wizData.theme) { applyTheme(wizData.theme); window.launcher.setTheme(wizData.theme); }
    closeSetupWizard(gp);
    renderBottomBar();
    applyStaticLabels();
    if (typeof cards !== 'undefined' && cards.length) renderCards();
    showStatus(tr('wizard.doneToast'));
}

function handleSetupWizardInput(gp) {
    if (wizPathFlow && wizPathFlow.isOpen()) { wizPathFlow.handle(gp); return; }
    const rows = wizRows();
    navList(gp, setupWizard.states, {
        count: rows.length,
        move: (d, repeated) => {
            if (!rows.length) return;
            wizFocus = stepIndex(wizFocus, d, rows.length, repeated);
            if (wizStepInfo(wizStep).id === 'theme') {
                const t = wizChoices.themes[wizFocus];
                if (t) applyTheme(t.id); // live preview
            }
            renderWizStep();
        },
        onSelect: () => {
            const row = rows[wizFocus];
            if (row) row.onSelect();
            else if (wizStepInfo(wizStep).id === 'done') wizCommit(gp);
            else wizNext();
        },
        onBack: () => wizPrev(gp),
    });
    edge(setupWizard.states, 'square', gp.buttons[BTN.square]?.pressed, () => wizAlt());
}

// □: on the "Done" step installs the missing ones, on the launcher step switches the variant.
function wizAlt() {
    const row = wizRows()[wizFocus];
    if (row && row.onAlt) { row.onAlt(); return; }
    wizInstallMissing();
}

// □ on the "Done" step: installs the missing system commands, then redraws with the fresh selftest.
function wizInstallMissing() {
    if (wizStepInfo(wizStep).id !== 'done') return;
    if (!wizCheckSummary(wizChoices, wizData).missingCommands.length) return;
    feedback('nav');
    runHostPackageInstall((res) => {
        if (res && Array.isArray(res.selftest) && res.selftest.length) wizChoices.selftest = res.selftest;
        if (setupWizard.isOpen()) renderWizStep();
    }).catch(ignoreError);
    renderWizStep(); // the "in progress" row
}

// Keyboard fallback (called by the keydown branch of renderer/main.js if setupWizard.isOpen()).
function wizKey(action) {
    const rows = wizRows();
    if (action === 1 || action === -1) {
        if (!rows.length) return;
        wizFocus = (wizFocus + action + rows.length) % rows.length;
        if (wizStepInfo(wizStep).id === 'theme') {
            const t = wizChoices.themes[wizFocus];
            if (t) applyTheme(t.id);
        }
        renderWizStep();
    } else if (action === 'select') {
        const row = rows[wizFocus];
        if (row) row.onSelect();
        else if (wizStepInfo(wizStep).id === 'done') wizCommit(null);
        else wizNext();
    } else if (action === 'back') {
        wizPrev(null);
    }
}

// Re-run from the Settings → System → "Setup wizard" row. open() closes the Settings panel and brings up the wizard; handle is empty (the
// wizardOpen branch takes over). The typeof guard: the file must be requirable standalone from test/setup-wizard.test.js (there is no
// `SETTINGS_VIEWS` then — the source-level test/contracts/settings-views.test.js still finds the literal, the guard does not hide it).
if (typeof SETTINGS_VIEWS !== 'undefined') {
    SETTINGS_VIEWS['setup-rerun'] = {
        open: () => { closeSettings(); openSetupWizard(true); },
        handle: () => {},
    };
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { wizStepInfo, wizListNote, wizCheckSummary, WIZ_SEQ, WIZ_REAL, WIZ_CMD_PURPOSE });
}
