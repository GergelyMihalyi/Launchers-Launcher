'use strict';

// Renderer smoke: the renderer/*.js files are split into classic <script src>s that share
// ONE global lexical scope (no type="module"). This test exists because there is no GUI:
// the sandbox has no Electron window, so a load error would not be caught otherwise. It checks:
//   1. every renderer/*.js referenced in index.html exists,
//   2. the files concatenated in order are syntactically valid (new vm.Script),
//   3. no conflicting top-level `let`/`const` declarations between two files (in the
//      concatenated source this gives a SyntaxError — exactly what we want to catch),
//   4. the bundle ACTUALLY RUNS in a minimal DOM stub (top level of every file + controller-id.js),
//      and the main render functions (renderCards / layoutCarousel / renderRecentBar /
//      renderGamesPanel / renderThemeList / renderCategoryList / renderControllerStatus)
//      DO NOT THROW on fake data (the runtime `undefined.map` / bad property reference
//      class). `ipc.js` + `main.js` (top-level IPC wiring + DOM event binding) are
//      INTENTIONALLY left out of the run — test 3 covers them syntactically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// The <script src="renderer/..."> references, in HTML order. `renderer/boot/` (the boot
// scripts that run before the first paint, using `window.launcher` and the DOM in a top-level IIFE)
// is NOT part of the bundle — `test/contracts/csp.test.js` guards those.
const scripts = [...html.matchAll(/<script\s+src="(renderer\/(?!boot\/)[^"]+)"><\/script>/g)].map((m) => m[1]);

test('index.html references renderer/*.js files', () => {
    assert.ok(scripts.length >= 10, `only ${scripts.length} renderer/*.js references`);
});

test('every referenced renderer/*.js exists', () => {
    for (const rel of scripts) {
        assert.ok(fs.existsSync(path.join(root, rel)), `missing: ${rel}`);
    }
});

test('the renderer/*.js files concatenated in order are syntactically valid (no conflicting top-level declaration)', () => {
    const parts = scripts.map((rel) => `// ==== ${rel} ====\n` + fs.readFileSync(path.join(root, rel), 'utf8'));
    const bundle = parts.join('\n;\n');
    assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'renderer-bundle.js' }));
});

// --------------------------------------------------------------------------
// 4. Run in a minimal DOM stub
// --------------------------------------------------------------------------

// A stub element that permits everything: the render functions build innerHTML + call a few DOM
// APIs (classList/dataset/addEventListener/querySelector), but there is no layout. Every
// method is a no-op or returns another stub; getter/setter properties never throw.
function stubEl() {
    const el = {
        style: {}, dataset: {}, attributes: {}, hidden: false,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        _html: '', _text: '',
        appendChild(c) { return c; }, append() {}, prepend() {}, insertBefore(c) { return c; },
        removeChild(c) { return c; }, remove() {}, replaceWith() {}, replaceChildren() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
        removeAttribute(k) { delete this.attributes[k]; },
        hasAttribute(k) { return k in this.attributes; },
        querySelector() { return stubEl(); },
        querySelectorAll() { return []; },
        getElementsByClassName() { return []; },
        closest() { return null; }, matches() { return false; }, contains() { return false; },
        cloneNode() { return stubEl(); },
        focus() {}, blur() {}, click() {}, scrollIntoView() {},
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
        animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; },
        offsetWidth: 100, offsetHeight: 100, offsetTop: 0, offsetLeft: 0, clientWidth: 100, clientHeight: 100,
    };
    Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
    Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = String(v); } });
    Object.defineProperty(el, 'firstChild', { get() { return null; } });
    Object.defineProperty(el, 'parentNode', { get() { return null; } });
    return el;
}

function makeContext() {
    const byId = {};
    const doc = {
        readyState: 'complete', hidden: false, visibilityState: 'visible',
        documentElement: stubEl(), body: stubEl(), head: stubEl(),
        getElementById(id) { return (byId[id] || (byId[id] = stubEl())); },
        // The carousel collects the `.card`s with querySelectorAll AFTER rendering — give it
        // 4 stub cards so the layoutCarousel spacing math also runs (not just the n===0 branch).
        querySelector() { return stubEl(); },
        querySelectorAll(sel) { return sel === '.card' ? [stubEl(), stubEl(), stubEl(), stubEl()] : []; },
        createElement() { return stubEl(); },
        createElementNS() { return stubEl(); },
        createDocumentFragment() { return stubEl(); },
        createTextNode() { return stubEl(); },
        addEventListener() {}, removeEventListener() {},
        hasFocus() { return true; },
        fonts: { ready: Promise.resolve(), load: () => Promise.resolve(), add() {} },
    };
    const launcherProxy = new Proxy({}, {
        get: () => (...args) => {
            // on*(cb) registration -> no-op; everything else -> a harmless resolved Promise
            if (typeof args[args.length - 1] === 'function') return undefined;
            return Promise.resolve(undefined);
        },
    });
    const ctx = {
        console,
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        setTimeout: () => 0, clearTimeout: () => {},
        setInterval: () => 0, clearInterval: () => {},
        requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
        queueMicrotask: (fn) => Promise.resolve().then(fn),
        Promise, Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Map, Set, Symbol, Error,
        parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        document: doc,
        navigator: { getGamepads: () => [], language: 'hu', userAgent: 'node', vibrate() {} },
        location: { reload() {}, href: 'file:///index.html' },
        performance: { now: () => Date.now() },
        getComputedStyle: () => ({ width: '480px', getPropertyValue: () => '' }),
        AudioContext: function () { return { createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { value: 0 } }), createGain: () => ({ connect() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }), destination: {}, currentTime: 0, resume() {} }; },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.self = ctx;
    ctx.window.launcher = launcherProxy;
    return ctx;
}

// The driver appended to the END of the bundle: it runs in the same lexical scope, so it can set
// the `let` globals (launchers / THEMES / gamesPanelRows / ...) and call the render
// functions by bare name. It puts the result in the context-global `__smoke`.
const DRIVER = `
;(function () {
    var results = [];
    function run(label, fn) {
        try { fn(); results.push({ label: label, ok: true }); }
        catch (e) { results.push({ label: label, ok: false, err: (e && e.stack) || String(e) }); }
    }
    var FAKE = [
        { id: 'steam', name: 'Steam', icon: 'assets/icons/steam.svg', hint: 'Big Picture', cmd: 'steam', args: [], accent: '#1b2838',
          usage: { count: 4, lastLaunchedAt: '2026-01-02T00:00:00.000Z' }, running: true,
          recentGames: [{ key: 'steam-game-620', name: 'Portal 2', cover: '/c/620.png', kind: 'steam', params: { appid: '620' } },
                        { key: 'steam-game-440', name: 'TF2', cover: null, kind: 'steam', params: { appid: '440' } }] },
        { id: 'heroic', name: 'Heroic', icon: 'assets/icons/heroic.svg', hint: 'GOG / Epic', cmd: 'flatpak', args: ['run', 'com.heroicgameslauncher.hgl'],
          usage: { count: 1, lastLaunchedAt: '2026-01-01T00:00:00.000Z' }, running: false, recentGames: [] },
        { id: 'retroarch', name: 'RetroArch', icon: 'assets/icons/retroarch.svg', hint: 'Emulators', cmd: 'flatpak', args: ['run', 'org.libretro.RetroArch'],
          usage: null, running: false, recentGames: [] }
    ];

    run('renderCards', function () { launchers = FAKE; renderCards(); });
    run('refreshRunningState', function () { launchers = FAKE.map((l) => ({ ...l, running: true })); refreshRunningState(); });
    run('layoutCarousel', function () { layoutCarousel(); });
    run('renderRecentBar (on a card)', function () { recentBarFocus = -1; renderRecentBar(); });
    run('renderRecentBar (in the bar)', function () { recentBarFocus = 0; renderRecentBar(); });
    run('renderContinueBar (empty)', function () { continueGames = []; continueFocus = -1; renderContinueBar(); });
    run('renderContinueBar (with items)', function () {
        continueGames = [
            { key: 'steam-game-620', name: 'Portal 2', cover: '/c/620.png', kind: 'steam', params: { appid: '620' } },
            { key: 'retroarch:NES:Metroid', name: 'Metroid', cover: null, kind: 'retroarch', params: { system: 'NES', path: '/m.nes' } }
        ];
        continueFocus = 0;
        renderContinueBar();
    });
    run('updateCarouselPeek', function () { updateCarouselPeek(); });
    run('updateFocus', function () { updateFocus(1); });

    run('renderGamesPanel (empty)', function () { renderGamesPanel(); });
    run('renderGamesPanel (grid + retro)', function () {
        gamesPanelLoadOk = true;
        gamesPanelSystem = null;
        gamesPanelSource = 'all';
        gamesPanelFocusIndex = 0;
        gamesPanelRows = [
            { type: 'game', source: 'steam', name: 'Portal 2', cover: '/c/620.png', appid: '620' },
            { type: 'game', source: 'gog', name: 'Hades', cover: null, appName: 'Hades' },
            { type: 'retro-system', system: 'Nintendo - SNES', count: 1234 },
            { type: 'ryujinx-game', id: '010093801237C000', name: 'Metroid Dread', path: '/x.xci', titleId: '010093801237C000', cover: null },
            { type: 'pcsx2-game', id: 'SCUS-97472', name: 'Shadow of the Colossus', path: '/x.iso', serial: 'SCUS-97472', cover: null }
        ];
        renderGamesPanel();
    });
    run('renderGamesPanel (★ favorites filter)', function () {
        gamesPanelSystem = null;
        gamesPanelFavorites = [
            { key: 'steam-game-620', name: 'Portal 2', cover: '/c/620.png', kind: 'steam', params: { appid: '620' } },
            { key: 'retroarch:NES:Metroid', name: 'Metroid', cover: null, kind: 'retroarch', params: { system: 'NES', path: '/m.nes' } }
        ];
        gamesPanelSource = 'fav';
        gamesPanelFocusIndex = 0;
        renderGamesPanel();
        gamesPanelSource = 'all';
        gamesPanelFavorites = [];
    });
    run('renderGameDetails (loading, facts, error) — update-ideas2 C1', function () {
        gamesDetails.open({
            key: 'pcsx2-game-SCUS-97472', name: 'Shadow of the Colossus', cover: '/c/sotc.png', kind: 'pcsx2',
            params: { path: '/x.iso', serial: 'SCUS-97472' },
        });
        renderGameDetails();
        gameDetailsData = {
            ok: true,
            launcher: { count: 2, totalMs: 3600000, lastLaunchedAt: '2026-09-20T10:00:00.000Z' },
            native: { playtimeMs: 7200000, lastPlayedAt: 1758000000000, label: 'PCSX2' },
            file: { path: '/x.iso', exists: true, isDir: false, sizeBytes: 4500000000 },
            cover: { override: null, suggestion: '/h/Pictures/launchers-launcher/covers/pcsx2/SCUS-97472.png' },
        };
        renderGameDetails();
        gameDetailsData = { ok: false };
        renderGameDetails();
        gamesDetails.close();
    });
    run('renderGamesPanel (summary recently-played bar)', function () {
        gamesPanelSystem = null;
        gamesPanelSource = 'all';
        gamesPanelFocusIndex = 0;
        gamesPanelRecent = [
            { key: 'retroarch:Nintendo - SNES:Super Mario World', name: 'Super Mario World', cover: '/t/smw.png',
              kind: 'retroarch', params: { system: 'Nintendo - SNES', path: '/roms/smw.sfc' }, lastLaunchedAt: '2026-01-03T00:00:00.000Z' },
            { key: 'steam-game-620', name: 'Portal 2', cover: null,
              kind: 'steam', params: { appid: '620' }, lastLaunchedAt: '2026-01-02T00:00:00.000Z' }
        ];
        renderGamesPanel();
        gamesPanelRecent = [];
    });

    run('renderGamesPanelSystemList', function () {
        gamesPanelSystem = 'Nintendo - SNES';
        gamesPanelSystemGames = [{ label: 'Super Mario World' }, { label: 'Zelda' }];
        renderGamesPanelSystemList();
        gamesPanelSystem = null;
    });

    // Live search: ALL, RETRO chip (flat ROM matches),
    // ★ FAVORITE, empty result, the search bar while typing and the filtered view of the system drill-down.
    run('renderGamesPanel (search: ALL + RETRO chip + empty result)', function () {
        gamesPanelSystem = null;
        gamesPanelLoadOk = true;
        gamesPanelFocusIndex = 0;
        gamesPanelRows = [
            { type: 'game', source: 'steam', name: 'Portal 2', cover: null, appid: '620' },
            { type: 'retro-system', system: 'Nintendo - SNES', count: 2 }
        ];
        gamesPanelRetroUnified = retroGroupsToUnifiedRows([
            { system: 'Nintendo - SNES', games: [{ label: 'Super Mario World', path: '/a.sfc', cover: null }, { label: 'Zelda', path: '/b.sfc', cover: null }] }
        ]);
        gamesPanelSource = 'all';
        gamesPanelQuery = 'mari';
        renderGamesPanel();
        gamesPanelSource = 'retro';
        renderGamesPanel();
        gamesPanelQuery = 'missingilyen';
        renderGamesPanel();
        gamesPanelQuery = 'ma'; // < SEARCH_MIN_CHARS: no filtering, "1 more character"
        gamesSearchTyping = true;
        renderGamesPanel();
        gamesSearchTyping = false;
        gamesPanelQuery = '';
        gamesPanelSource = 'all';
        gamesPanelRetroUnified = null;
        gamesPanelRows = [];
    });
    run('renderGamesPanelSystemList (search)', function () {
        gamesPanelSystem = 'Nintendo - SNES';
        gamesPanelSystemGames = [{ label: 'Super Mario World' }, { label: 'Zelda' }];
        gamesPanelQuery = 'zel';
        renderGamesPanelSystemList();
        gamesPanelQuery = 'missingilyen';
        renderGamesPanelSystemList();
        gamesPanelQuery = '';
        gamesPanelSystem = null;
    });
    run('keyboard: in live mode ○ keeps the text, in non-live mode CANCEL; Start = DONE', function () {
        function pad(idx) { var b = []; b[idx] = { pressed: true }; return { buttons: b, axes: [0, 0] }; }
        var got = null;
        openKeyboard({ layout: 'compact', live: true, initial: 'zel', onConfirm: function (t) { got = 'ok:' + t; }, onCancel: function () { got = 'cancel'; } });
        keyboardPanel.states = {};
        handleKeyboardInput(pad(BTN.circle));
        if (got !== 'ok:zel') throw new Error('live mode ○ -> ' + got);
        got = null;
        openKeyboard({ initial: 'abc', onConfirm: function (t) { got = 'ok:' + t; }, onCancel: function () { got = 'cancel'; } });
        keyboardPanel.states = {};
        handleKeyboardInput(pad(BTN.circle));
        if (got !== 'cancel') throw new Error('non-live ○ -> ' + got);
        got = null;
        openKeyboard({ initial: 'abc', onConfirm: function (t) { got = 'ok:' + t; }, onCancel: function () { got = 'cancel'; } });
        keyboardPanel.states = {};
        handleKeyboardInput(pad(BTN.start));
        if (got !== 'ok:abc') throw new Error('Start -> ' + got);
    });
    run('renderKeyboard (compact, docked)', function () {
        openKeyboard({ title: 'Search', layout: 'compact', dock: 'bottom', live: true, onChange: function () {} });
        renderKeyboard();
        closeKeyboard();
    });

    run('renderThemeList', function () {
        THEMES = [{ id: 'neon', label: 'Neon', swatch: ['#0a0a12', '#141422', '#00e5ff'] },
                  { id: 'win31', label: 'Windows 3.1', swatch: ['#008080', '#c0c0c0', '#000080'], motion: 'off' }];
        renderThemeList();
    });
    run('renderCategoryList', function () { renderCategoryList(); renderCategoryItems(); });
    // Regression: applyLanguageEverywhere() (settings-language.js) called the pre-menu-refactor
    // renderSettingsMenu() (a nonexistent function) - with the Settings panel OPEN this crashed
    // the renderer on EVERY language switch (#fatalOverlay). renderBottomBar/applyStaticLabels
    // live in main.js (which is intentionally left out of this bundle), so we give them a
    // harmless local stub, for this run only.
    run('applyLanguageEverywhere (settings open, items zone) - renderSettingsMenu() crash regression', function () {
        if (typeof renderBottomBar === 'undefined') globalThis.renderBottomBar = function () {};
        if (typeof applyStaticLabels === 'undefined') globalThis.applyStaticLabels = function () {};
        settingsPanel.open();
        settingsView = null;
        settingsZone = 'items';
        settingsGroupIndex = 0;
        applyLanguageEverywhere();
        settingsPanel.reset();
        settingsZone = 'categories';
    });
    run('renderFeedbackView / renderRecentGamesUiView / renderOutputBehaviorView (createMultiToggleSubview)', function () {
        renderFeedbackView();
        renderRecentGamesUiView();
        renderOutputBehaviorView();
    });
    run('renderWizStep (launchers step)', function () {
        // renderWizStep needs no open state (the factory's open() would also start the full,
        // async querying load).
        wizStep = WIZ_SEQ.indexOf('launchers');
        wizFocus = 0;
        wizChoices.catalog = [
            { id: 'steam', name: 'Steam', installed: true, common: true, active: false },
            { id: 'heroic', name: 'Heroic', installed: false, common: true, active: false },
        ];
        wizData.addLaunchers = ['steam'];
        renderWizStep();
    });
    run('renderWizStep (button layout + done: install/command check) — update-ideas2 D5', function () {
        wizStep = WIZ_SEQ.indexOf('controls');
        renderWizStep();
        wizStep = WIZ_SEQ.indexOf('done');
        wizData.addLaunchers = ['steam', 'heroic'];
        wizChoices.selftest = [{ cmd: 'pactl', ok: true }, { cmd: 'kscreen-doctor', ok: false }];
        renderWizStep();
        wizChoices.selftest = [{ cmd: 'pactl', ok: true }];
        wizData.addLaunchers = ['steam'];
        renderWizStep();
    });
    run('renderLauncherInstall (confirm/running/done/error)', function () {
        liEntry = { id: 'heroic', name: 'Heroic', flathubId: 'com.heroicgameslauncher.hgl' };
        for (const s of ['confirm', 'running', 'done', 'error']) {
            liState = s; liPct = 42; renderLauncherInstall();
        }
        launcherInstall.reset(); liState = 'confirm';
    });
    run('renderChangelog', function () {
        renderChangelog({
            pending: true, heading: '[Unreleased]',
            lines: ['### Added', '- A **new** thing.', '', 'Plain paragraph.', '- Another one.'],
        });
        renderChangelog({ pending: true, heading: '', lines: [] });
    });
    run('renderCardMenu (root + accent)', function () {
        launchers = FAKE;
        cardMenuLauncherId = 'steam';
        cardMenuFocus = 0;
        cardMenuPage = 'root';
        renderCardMenu();
        cardMenuPage = 'accent';
        renderCardMenu();
        cardMenuPage = 'root';
    });
    run('renderQuickPowerMenu (armed + plain sor)', function () {
        // createArmedActionList (renderer/util.js) keeps the state in the qpList closure —
        // we reach the render branch of the armed AND the plain (armed:false, "Quit app")
        // row through its own methods (reset/moveFocus/select), not through the no longer existing
        // qpFocus/qpArmedIndex globals.
        qpList.reset();
        qpList.select(); // 1st ✕ on the "poweroff" row -> arms
        qpList.moveFocus(1, false);
        qpList.moveFocus(1, false);
        qpList.moveFocus(1, false); // focus on the "quit" (armed:false) row
        renderQuickPowerMenu();
        qpList.reset();
    });
    run('renderPowerView (armed row) — the createArmedActionList caller on the settings-system.js side', function () {
        settingsView = 'power';
        powerList.reset();
        powerList.select(); // 1st ✕ on the "poweroff" row -> arms
        renderPowerView();
        powerList.reset();
        settingsView = null;
    });
    run('renderStartupOutput + "Keep it?" countdown', function () {
        settingsView = 'startup-output';
        startupMonitors = [{ name: 'DP-3', label: 'DP-3 — 2560×1080' }];
        startupSinks = [{ name: 'sink', description: 'HDMI' }];
        startupConfig = { monitor: 'DP-3', sink: null };
        startMonitorConfirm('DP-3 — 2560×1080', 15000);
        renderStartupOutput();
        endMonitorConfirm();
        renderStartupOutput();
        monitorSwitching = { name: 'DP-3', timer: 0 }; // "SWITCHING…" marker on the row
        renderStartupOutput();
        endMonitorSwitching();
        settingsView = null;
    });
    run('renderSaveBackupView (C2: sources + earlier backups + error branch) + renderControlsHelpView', function () {
        saveBackupState = {
            ok: true, dir: '/h/launchers-launcher-saves', isDefaultDir: true, running: false, keep: 5,
            sources: [{ id: 'pcsx2', name: 'PCSX2', bytes: 8, paths: [{ path: '/p', bytes: 8 }] }],
            backups: [{ name: 'launchers-launcher-saves-2026-09-24_210000.tar.zst', bytes: 99, mtimeMs: 1758740400000 }],
        };
        saveBackupFocus = 3;
        saveBackupRunning = true;
        renderSaveBackupView();
        saveBackupState = { ok: false };
        saveBackupRunning = false;
        renderSaveBackupView();
        renderControlsHelpView();
    });
    run('renderUpdateView + dependency section (D6: in progress / error / outdated + vulnerability)', function () {
        updateStatus = { state: 'up-to-date' };
        for (const h of [null, { ok: false }, { ok: true, outdated: [], audit: { total: 0 } },
            { ok: true, outdated: [{ name: 'electron', current: '44.0.0', latest: '45.0.0', major: true }], audit: { total: 3, critical: 1, high: 2 } }]) {
            depHealth = h;
            renderUpdateView();
        }
        depHealth = null;
    });
    run('renderLogList (D4: levels, filters, empty filter result)', function () {
        logLines = [
            { text: '[t] start', level: 'info' }, { text: '[t] WARN x', level: 'warn' }, { text: '[t] ERROR y', level: 'error' },
        ];
        for (const f of ['all', 'warn', 'error']) { logFilter = f; focusNewestLogLine(); renderLogList(); }
        logLines = [{ text: '[t] ok', level: 'info' }];
        logFilter = 'error';
        renderLogList();
        logFilter = 'all';
    });
    run('renderConfigBackupsView (dynamic rows, armed + empty branch)', function () {
        settingsView = 'config-backups';
        configBackups = [];
        renderConfigBackupsView();
        configBackups = [
            { name: 'config.json.pre-restore', kind: 'pre-restore', date: '2026-09-24', size: 3000 },
            { name: 'config.json.bak-2026-09-23', kind: 'daily', date: '2026-09-23', size: 2900 },
        ];
        configBackupList.reset();
        configBackupList.moveFocus(1, false);
        configBackupList.select(); // 1st ✕ -> arms (the 2nd ✕ would call IPC)
        renderConfigBackupsView();
        configBackupList.reset();
        configBackups = [];
        settingsView = null;
    });
    run('renderLaunchersList (+ add-wizard row)', function () {
        launchers = FAKE;
        launchersCatalog = [{ id: 'lutris', name: 'Lutris', installed: true }];
        launchersViewRows = buildLaunchersRows();
        launchersViewFocusIndex = 0;
        renderLaunchersList();
    });
    run('renderVariantPick (native/flatpak selector)', function () {
        variantPick = { entry: { id: 'lutris', name: 'Lutris', nativeCmd: 'lutris' }, focus: 0 };
        renderVariantPick();
        variantPick = null;
    });
    run('"＋ Add launcher" wizard: every step renders', function () {
        settingsView = 'launchers';
        const flow = getLauncherAddFlow();
        flow.open();
        const apps = [
            { key: 'flatpak:com.x.Y', kind: 'flatpak', name: 'Y app', appId: 'com.x.Y', cmd: 'flatpak', args: ['run', 'com.x.Y'], icon: '/i/y.png', known: false },
            { key: 'desktop:w', kind: 'native', name: 'W', cmd: 'w', args: [], icon: null, known: true },
        ];
        flow._show({ step: 'apps', apps: null, filter: '', focus: 0 });
        flow._show({ step: 'apps', apps, filter: '', focus: 1 });
        flow._show({ step: 'apps', apps, filter: 'missing', focus: 0 });
        flow._show({ step: 'apps', apps: [], filter: '', focus: 0, failed: true });
        flow._show({ step: 'exec', dir: '/opt', items: [{ path: '/opt/a.AppImage', name: 'a.AppImage' }], focus: 0 });
        const draft = { kind: 'flatpak', appId: 'com.x.Y', name: 'Y', cmd: 'flatpak', args: ['run', 'com.x.Y'], iconFile: '/i/y.png', useOwnIcon: true, builtinIcon: '', accent: '#1a9fff', back: 'source' };
        flow._show({ step: 'icon', draft, rows: [{ type: 'own' }, { type: 'none' }, { type: 'builtin', path: 'assets/icons/steam.svg' }], focus: 2 });
        flow._show({ step: 'preview', draft, focus: 3 });
        flow._show({ step: 'preview', draft: { ...draft, accent: null, useOwnIcon: false, builtinIcon: 'assets/icons/steam.svg' }, focus: 0 });
        flow.reset();
        settingsView = null;
    });
    run('custom ROM folder source: the setup steps + a custom row in the Games panel', function () {
        settingsView = 'launchers';
        const flow = getLauncherRomsFlow();
        flow.open({ id: 'custom-citron', name: 'Citron' }, null);
        flow._show({ step: 'dirs', launcher: { id: 'custom-citron', name: 'Citron' }, dirs: ['/roms/switch'], exts: [], argsTemplate: '{rom}', focus: 0 });
        flow._show({ step: 'exts', launcher: { id: 'custom-citron', name: 'Citron' }, dirs: ['/roms/switch'], exts: ['.nsp', '.xci', '.nro'], argsTemplate: '{rom}', focus: 0 });
        flow._show({ step: 'exts', launcher: { id: 'custom-citron', name: 'Citron' }, dirs: ['/roms/switch'], exts: ['.foo'], argsTemplate: '{rom}', focus: 0 });
        flow.reset();
        settingsView = null;
    });
    run('renderStats', function () {
        statsRows = [
            { key: 'steam', kind: 'launcher', name: 'Steam', count: 4, totalMs: 7200000, lastSessionMs: 1800000, lastLaunchedAt: '2026-01-02T00:00:00.000Z' },
            { key: 'steam-game-620', kind: 'steam', name: 'Portal 2', count: 2, totalMs: 5400000, lastSessionMs: 2700000, lastLaunchedAt: null },
            { key: 'retroarch-game', kind: 'retroarch', name: null, count: 1, totalMs: 600000, lastSessionMs: 600000, lastLaunchedAt: null }
        ];
        buildStatsSections();
        renderStats();
    });
    run('renderStats (empty)', function () { statsRows = []; buildStatsSections(); renderStats(); });
    run('renderBackgroundView', function () {
        settingsView = 'background';
        THEMES = [{ id: 'neon', label: 'Neon', swatch: ['#0a0a12', '#141422', '#00e5ff'] }];
        currentTheme = 'neon';
        bgSetMap({ neon: { type: 'builtin', id: 'aurora' } });
        bgViewTheme = 'neon';
        bgBuiltins = [{ id: 'aurora', label: 'Aurora', swatch: ['#0a1a33', '#1c6e8c'] }];
        bgCustoms = [{ name: 'foto.jpg', path: '/home/x/Pictures/launchers-launcher/foto.jpg' }];
        bgFocusIndex = 1;
        renderBackgroundView();
        applyBackgroundForTheme('neon');
        applyBackground({ type: 'custom', path: '/home/x/Pictures/launchers-launcher/foto.jpg' });
        applyBackground({ type: 'none' });
        settingsView = null;
    });
    run('renderBtDeviceList (paired + scan + found)', function () {
        settingsView = 'bt-controller';
        btState.controller.list = [{ mac: 'AA:BB:CC:DD:EE:01', name: 'DualSense', connected: true, type: 'dualsense', battery: 80 }];
        btState.controller.scanning = false;
        btState.controller.found = [{ mac: 'AA:BB:CC:DD:EE:99', name: 'Xbox Wireless', icon: 'input-gaming' }];
        btState.controller.focusIndex = 1;
        renderBtDeviceList('controller');
        btState.controller.scanning = true;
        renderBtDeviceList('controller');
        btState.controller.scanning = false;
        btState.controller.list = [];
        btState.controller.found = [];
        renderBtDeviceList('controller');
        settingsView = null;
    });
    run('renderControllerStatus (empty)', function () { renderControllerStatus(); });
    run('renderControllerStatus (chip)', function () {
        ctrlBtItems = [{ connected: true, type: 'dualsense', battery: 12, mac: 'AA:BB', name: 'DualSense' }];
        renderControllerStatus();
    });
    run('tr — string', function () {
        if (typeof tr('toast.launchFailed') !== 'string') throw new Error('tr does not return a string');
    });

    globalThis.__smoke = results;
})();
`;

test('the renderer bundle runs in a DOM stub, the render functions do not throw on fake data', () => {
    // controller-id.js (a separate <script src> in the browser) BEFORE renderer/*.js —
    // controller-labels / controller-status get the `classifyController` / `CONTROLLER_SYMBOLS`
    // globals from it; launcher-registry.js likewise (the `EMULATOR_REGISTRY` of
    // games-panel-sources.js). ipc.js + main.js are LEFT OUT (top-level IPC / DOM binding).
    const files = [
        'controller-id.js', 'launcher-registry.js',
        ...scripts.filter((s) => s !== 'renderer/ipc.js' && s !== 'renderer/main.js'),
    ];
    const bundle = files
        .map((rel) => `// ==== ${rel} ====\n` + fs.readFileSync(path.join(root, rel), 'utf8'))
        .join('\n;\n') + DRIVER;

    const ctx = makeContext();
    vm.createContext(ctx);

    assert.doesNotThrow(
        () => vm.runInContext(bundle, ctx, { filename: 'renderer-smoke-bundle.js' }),
        'the top-level run of the bundle threw',
    );

    const results = ctx.__smoke;
    assert.ok(Array.isArray(results) && results.length > 0, 'the driver did not run');
    const failed = results.filter((r) => !r.ok);
    assert.equal(
        failed.length, 0,
        'render function(s) threw:\n' + failed.map((r) => `  • ${r.label}\n${r.err}`).join('\n'),
    );
});

// The controller-driven pop-ups go through the shared `createOverlay` factory — so the
// entering edge state + the closing `syncEdge` are mandatory. A manual `.visible` is only allowed on
// NON-interactive overlays (loader/TV exit/volume — overlays.js; screensaver — home/idle.js).
test('an interactive overlay only gets .visible through createOverlay', () => {
    const allowed = new Set(['renderer/util.js', 'renderer/overlays.js', 'renderer/home/idle.js']);
    const offenders = [];
    for (const rel of scripts) {
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        if (/classList\.(add|remove|toggle)\('visible'/.test(src) && !allowed.has(rel)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], `use createOverlay (renderer/util.js): ${offenders.join(', ')}`);
});
