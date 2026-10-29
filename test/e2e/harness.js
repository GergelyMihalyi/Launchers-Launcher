'use strict';

// Offscreen Electron e2e smoke — the REAL index.html + renderer in an invisible (offscreen,
// no GPU/display) BrowserWindow, with a stubbed `window.launcher` (preload-stub.js).
// Per scenario it calls the renderer's globals/functions directly (the same lexical
// scope as the DevTools console), and checks pixel geometry + renderer errors.
// See also docs/dev/testing.md (offscreen render).
//
// Run: `npm run test:e2e` (started by test/e2e/e2e.spec.js). Directly:
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron test/e2e/harness.js --headless --no-sandbox
// The last `E2E_RESULT <json>` line of the output is the result. `E2E_SHOTS=<folder>` → screenshots
// (PNG) per scenario — for visual comparison before/after an Electron upgrade.

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.join(__dirname, '..', '..');
const WIDTH = Number(process.env.E2E_WIDTH) || 1920;
const HEIGHT = Number(process.env.E2E_HEIGHT) || 1080;
const SHOTS = process.env.E2E_SHOTS || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The body is an async function TEST string; it runs in the page's global scope (the `let`s are reachable).
function ev(win, body) {
    return win.webContents.executeJavaScript(`(async () => { ${body} })()`);
}

async function waitFor(win, cond, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await ev(win, `return !!(${cond});`)) return true;
        await sleep(50);
    }
    throw new Error(`timeout: ${cond}`);
}

// Whether the carousel cards have stopped moving — NOT a fixed wall-clock wait: on a loaded machine
// the offscreen window gets frames less often, and animation time advances with the frames (measured:
// after 700 ms a 0.42 s transition was only at 300 ms → the card a few px off center).
// We wait for the `finished` of EVERY animation of the cards, repeatedly
// (the wrap-around teleport starts a new transition one rAF later), up to `timeoutMs`.
async function settleCarousel(win, timeoutMs = 5000) {
    await ev(win, `
        const end = Date.now() + ${timeoutMs};
        const running = () => [...document.querySelectorAll('#cards .card')].flatMap((c) => c.getAnimations());
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        while (running().length && Date.now() < end) {
            await Promise.race([
                Promise.all(running().map((a) => a.finished.catch(() => {}))),
                new Promise((res) => setTimeout(res, 250)),
            ]);
            await new Promise((res) => requestAnimationFrame(res));
        }
        return 0;`);
}

async function shot(win, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
}

const FAKE_PAD = '{ buttons: [], axes: [] }';
// Waiting out "✕ held" (renderer/util.js HOLD_MS = 550).
const HOLD_WAIT_MS = 650;

// Shared check: no horizontal overflow, the fatal overlay did not come up.
const LAYOUT_OK = `
    const fatal = document.getElementById('fatalOverlay');
    const fatalShown = fatal && getComputedStyle(fatal).display !== 'none';
    return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        fatalShown,
    };`;

const SCENARIOS = [
    {
        // The logo's lift-off splash (index.html #bootSplash, renderer/boot/boot-splash.js): it covers the start, plays through
        // (sp-total 3.4 s — it does NOT leave early, even though the cards are ready in ms), then removes itself.
        name: 'boot: the logo splash plays through, then removes itself',
        async run(win, expect) {
            const present = await ev(win, `return !!document.getElementById('bootSplash');`);
            expect(present, 'the splash is not in the DOM after loading');
            await waitFor(win, `!document.getElementById('bootSplash')`, 12000);
            const t = await ev(win, `return Math.round(performance.now());`);
            expect(t >= 3300, `the splash disappeared too early: ${t} ms (the animation is 3400 ms)`);
            return { removedAtMs: t };
        },
    },
    {
        name: 'boot: carousel + bars, centered focus',
        async run(win, expect) {
            await waitFor(win, `document.querySelectorAll('#cards .card').length === launchers.length + 1 && launchers.length > 0`);
            await settleCarousel(win); // carousel-transition
            const r = await ev(win, `
                const f = document.querySelector('#cards .card.focused').getBoundingClientRect();
                return {
                    cards: document.querySelectorAll('#cards .card').length,
                    focusedCenterDx: Math.abs((f.left + f.width / 2) - innerWidth / 2),
                    focusedWidth: f.width,
                    continueBar: !document.getElementById('continueBar').hidden,
                    bottomBarH: document.getElementById('bottomBar').getBoundingClientRect().height,
                    ...(function () { ${LAYOUT_OK} })(),
                };`);
            expect(r.cards === 6, `cards: ${r.cards}`);
            expect(r.focusedCenterDx < 4, `the focused card is not centered (dx=${r.focusedCenterDx})`);
            expect(r.focusedWidth > 150, `width of the focused card ${r.focusedWidth}`);
            expect(r.continueBar, 'the Continue bar is hidden');
            expect(r.bottomBarH > 10, 'the bottom bar is missing');
            expect(r.overflowX <= 0, `horizontal overflow: ${r.overflowX}px`);
            expect(!r.fatalShown, 'the fatal overlay is visible');
            await shot(win, '01-home');
            return r;
        },
    },
    {
        name: 'carousel navigation wraps around (wrap-teleport)',
        async run(win, expect) {
            for (let i = 0; i < 7; i++) {
                await ev(win, `navFocusNext(); return 0;`);
                await sleep(60);
            }
            await settleCarousel(win);
            const r = await ev(win, `
                const el = document.querySelector('#cards .card.focused'); const f = el.getBoundingClientRect();
                return { idx: focusedIndex, dx: Math.abs((f.left + f.width / 2) - innerWidth / 2),
                    running: el.getAnimations().map((a) => [a.transitionProperty, a.playState, Math.round(a.currentTime)]) };`);
            expect(r.dx < 4, `not centered after navigation (dx=${r.dx}, running animations: ${JSON.stringify(r.running)})`);
            return r;
        },
    },
    {
        name: 'themes: all load, the focused card is visible',
        async run(win, expect) {
            const ids = await ev(win, `return THEMES.map((t) => t.id);`);
            expect(ids.length >= 10, `only ${ids.length} themes`);
            const bad = [];
            for (const id of ids) {
                const r = await ev(win, `
                    applyTheme(${JSON.stringify(id)});
                    await new Promise((res) => setTimeout(res, 40));
                    const f = document.querySelector('#cards .card.focused').getBoundingClientRect();
                    const bg = getComputedStyle(document.body).backgroundColor;
                    return { attr: document.documentElement.dataset.theme || 'neon', w: f.width, bg };`);
                if (r.attr !== id || r.w < 100 || !r.bg) bad.push(`${id}: ${JSON.stringify(r)}`);
            }
            await ev(win, `applyTheme('neon'); return 0;`);
            expect(!bad.length, `bad themes: ${bad.join('; ')}`);
            return { themes: ids.length };
        },
    },
    {
        name: 'Settings: fixed-size panel + every sub-view opens',
        async run(win, expect) {
            await ev(win, `openSettings(); return 0;`);
            await sleep(400);
            const panel = await ev(win, `
                const r = document.querySelector('#settingsOverlay .settings-panel').getBoundingClientRect();
                return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
                         cats: document.querySelectorAll('#settingsMenuList .settings-item').length };`);
            expect(panel.left >= 0 && panel.top >= 0 && panel.right <= WIDTH && panel.bottom <= HEIGHT, `the panel sticks out: ${JSON.stringify(panel)}`);
            expect(panel.w > 600 && panel.h > 400, `panel size: ${panel.w}×${panel.h}`);
            expect(panel.cats >= 5, `categories: ${panel.cats}`);
            await shot(win, '02-settings');
            const ids = await ev(win, `return SETTINGS_MENU.map((m) => m.id).filter((id) => id !== 'setup-rerun');`);
            const empty = [];
            for (const id of ids) {
                const html = await ev(win, `
                    settingsZone = 'content'; settingsView = ${JSON.stringify(id)};
                    await SETTINGS_VIEWS[${JSON.stringify(id)}].open();
                    await new Promise((res) => setTimeout(res, 60));
                    return document.getElementById('settingsContent').innerHTML.length;`);
                if (!html) empty.push(id);
            }
            await ev(win, `closeSettings(${FAKE_PAD}); return 0;`);
            expect(!empty.length, `empty sub-view(s): ${empty.join(', ')}`);
            return { views: ids.length };
        },
    },
    {
        name: 'Games panel: 16 000 RetroArch ROMs, virtualized list, deep focus is visible',
        async run(win, expect) {
            await ev(win, `gamesPanelMemory = null; openGamesPanel(); return 0;`);
            await waitFor(win, `gamesPanelRetroUnified && gamesPanelRetroUnified.length > 15000`);
            await sleep(300);
            const r1 = await ev(win, `
                return { rows: gamesPanelVisibleRows.length,
                         dom: document.querySelectorAll('#gamesPanelContent .settings-item, #gamesPanelContent .game-cell').length };`);
            expect(r1.rows > 16000, `visible rows: ${r1.rows}`);
            expect(r1.dom < 800, `not virtualized: ${r1.dom} DOM rows`);
            const t0 = Date.now();
            const r2 = await ev(win, `
                gamesPanelFocusIndex = 12000; renderGamesPanel();
                await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
                renderGamesPanel();
                await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
                const c = document.getElementById('gamesPanelContent').getBoundingClientRect();
                const f = document.querySelector('#gamesPanelContent .focused');
                if (!f) return { found: false };
                const fr = f.getBoundingClientRect();
                return { found: true, inView: fr.top >= c.top - 1 && fr.bottom <= c.bottom + 1, fTop: fr.top, cTop: c.top, cBottom: c.bottom };`);
            const ms = Date.now() - t0;
            expect(r2.found, 'no focused row in the DOM');
            expect(r2.inView, `the focused row is not visible: ${JSON.stringify(r2)}`);
            await shot(win, '03-games-deep');
            return { ...r1, deepJumpMs: ms };
        },
    },
    {
        name: 'Games search: docked keyboard, filtering, the list above the keyboard',
        async run(win, expect) {
            await ev(win, `gamesPanelFocusIndex = 0; renderGamesPanel(); openGamesSearch(); return 0;`);
            await waitFor(win, `keyboardPanel.isOpen()`);
            await ev(win, `for (const ch of 'zelda') kbKey(ch); return 0;`);
            await sleep(400);
            const r = await ev(win, `
                const kb = document.querySelector('#keyboardOverlay .keyboard-panel') || document.querySelector('#keyboardOverlay > *');
                const k = kb.getBoundingClientRect();
                const c = document.getElementById('gamesPanelContent').getBoundingClientRect();
                const bar = document.querySelector('.games-search');
                return { query: gamesPanelQuery, rows: gamesPanelVisibleRows.length,
                         docked: document.getElementById('gamesOverlay').classList.contains('kb-docked'),
                         kbTop: k.top, kbBottom: k.bottom, listBottom: c.bottom,
                         barText: bar ? bar.textContent : '' };`);
            expect(r.query === 'zelda', `query: ${r.query}`);
            expect(r.rows > 0 && r.rows < 16000, `filtered rows: ${r.rows}`);
            expect(r.docked, 'the panel did not get the kb-docked class');
            expect(r.kbBottom <= HEIGHT + 1, `the keyboard sticks out: ${r.kbBottom}`);
            expect(r.listBottom <= r.kbTop + 2, `the list extends below the keyboard (${r.listBottom} > ${r.kbTop})`);
            await shot(win, '04-games-search');
            await ev(win, `kbKey('cancel'); closeGamesPanel(${FAKE_PAD}); return 0;`);
            return r;
        },
    },
    {
        name: 'Game details: opens on a held ✕, the card fits, ○ closes without launching',
        async run(win, expect) {
            await ev(win, `gamesPanelMemory = null; openGamesPanel(); return 0;`);
            await waitFor(win, `gamesPanelVisibleRows.some((r) => r.type === 'unified')`);
            // The real input path: a released frame (resetting the opening state), then ✕
            // held > HOLD_MS — the short ✕ (launch) must NOT run.
            await ev(win, `
                gamesPanelFocusIndex = gamesPanelVisibleRows.findIndex((r) => r.type === 'unified');
                renderGamesPanel();
                handleGamesPanelInput({ buttons: [{ pressed: false }], axes: [] });
                handleGamesPanelInput({ buttons: [{ pressed: true }], axes: [] });
                return 0;`);
            await sleep(HOLD_WAIT_MS);
            await ev(win, `handleGamesPanelInput({ buttons: [{ pressed: true }], axes: [] }); return 0;`);
            await waitFor(win, `gamesDetails.isOpen() && !!document.querySelector('#gamesDetailsContent .game-details-facts')`);
            await sleep(300); // the panel's entry animation
            const r = await ev(win, `
                const p = document.querySelector('#gamesDetailsOverlay .settings-panel').getBoundingClientRect();
                const text = document.getElementById('gamesDetailsContent').textContent;
                return { launching: isLaunching, bottom: p.bottom, right: p.right,
                         facts: document.querySelectorAll('#gamesDetailsContent .game-details-facts dt').length,
                         actions: document.querySelectorAll('#gamesDetailsContent .game-details-actions .settings-item').length,
                         hasSuggestion: text.includes('covers/steam/1.png') };`);
            expect(!r.launching, 'the long ✕ launched the game');
            expect(r.bottom <= HEIGHT + 1 && r.right <= WIDTH + 1, `the card sticks out: ${JSON.stringify(r)}`);
            expect(r.facts >= 3, `few fact rows: ${r.facts}`);
            expect(r.actions === 6, `actions: ${r.actions}`);
            expect(r.hasSuggestion, 'the cover-override path is not on the card');
            await shot(win, '05-game-details');
            const r2 = await ev(win, `
                handleGameDetailsInput({ buttons: [{ pressed: false }], axes: [] });
                handleGameDetailsInput({ buttons: [{ pressed: false }, { pressed: true }], axes: [] });
                return { details: gamesDetails.isOpen(), panel: gamesPanel.isOpen(), launching: isLaunching };`);
            expect(!r2.details && r2.panel && !r2.launching, `after ○: ${JSON.stringify(r2)}`);
            await ev(win, `closeGamesPanel(${FAKE_PAD}); return 0;`);
            return r;
        },
    },
    {
        name: 'Setup wizard: the button layout fits without scrolling, "Done" reports the missing one',
        async run(win, expect) {
            await ev(win, `openSetupWizard(true); return 0;`);
            await waitFor(win, `wizChoices.selftest.length > 0`);
            await ev(win, `wizStep = WIZ_SEQ.indexOf('controls'); renderWizStep(); return 0;`);
            await sleep(300);
            const r1 = await ev(win, `
                const p = document.querySelector('#setupOverlay .settings-panel').getBoundingClientRect();
                const c = document.getElementById('setupContent');
                return { rows: document.querySelectorAll('#setupContent .controls-help-row').length,
                         bottom: p.bottom, right: p.right, overflow: c.scrollHeight > c.clientHeight + 1 };`);
            expect(r1.rows >= 16, `button-layout rows: ${r1.rows}`);
            // No focusable row on the step — whatever does not fit is unreachable with a controller.
            expect(!r1.overflow, 'the button layout would fit only with scrolling');
            expect(r1.bottom <= HEIGHT + 1 && r1.right <= WIDTH + 1, `the panel sticks out: ${JSON.stringify(r1)}`);
            await shot(win, '06-wizard-controls');
            await ev(win, `wizStep = WIZ_SEQ.indexOf('done'); renderWizStep(); return 0;`);
            const r2 = await ev(win, `return { text: document.getElementById('setupContent').textContent };`);
            expect(r2.text.includes('kscreen-doctor'), 'the "Done" step does not report the missing command');
            await shot(win, '07-wizard-done');
            await ev(win, `closeSetupWizard(${FAKE_PAD}); return 0;`);
            return r1;
        },
    },
    {
        name: 'Screen reader: the label of the focused card / list item goes into the live region',
        async run(win, expect) {
            await ev(win, `feedbackState = { ...feedbackState, screenReader: true }; applyScreenReaderPref(); updateFocus((focusedIndex + 1) % cards.length); return 0;`);
            await sleep(400);
            const r1 = await ev(win, `
                const card = document.querySelector('.card.focused');
                return { said: document.getElementById('srAnnounce').textContent, label: card && card.getAttribute('aria-label'),
                         lang: document.documentElement.lang };`);
            expect(r1.label && r1.said === r1.label, `card: ${JSON.stringify(r1)}`);
            expect(r1.lang === 'hu', `<html lang>: ${r1.lang}`);
            await ev(win, `openSettingsView('feedback'); return 0;`);
            await sleep(300);
            await ev(win, `handleSettingsInput({ buttons: [], axes: [] }); handleSettingsInput({ buttons: Object.assign([], { 13: { pressed: true } }), axes: [] }); return 0;`);
            await sleep(400);
            const r2 = await ev(win, `
                const f = document.querySelector('#settingsContent .settings-item.focused');
                return { said: document.getElementById('srAnnounce').textContent, text: f && f.textContent.replace(/\\s+/g, ' ').trim() };`);
            expect(r2.text && r2.said === r2.text, `list item: ${JSON.stringify(r2)}`);
            await ev(win, `closeSettings({ buttons: [], axes: [] }); feedbackState = { ...feedbackState, screenReader: false }; applyScreenReaderPref(); updateFocus(0); return 0;`);
            return { card: r1.said, item: r2.said };
        },
    },
    {
        // The emulator sections are built from the registry (melonDS is `background`
        // → the panel opens without it, its rows pop in later), the launch goes over the shared IPC.
        name: 'Games panel: registry-driven emulator sections + shared launch-emulator-game',
        async run(win, expect) {
            await ev(win, `gamesPanelMemory = null; openGamesPanel(); return 0;`);
            await waitFor(win, `gamesPanelRows.some((r) => r.type === 'melonds-game')`);
            const r = await ev(win, `
                const count = (src) => { gamesPanelSource = src; gamesPanelFocusIndex = 0; renderGamesPanel();
                    return { rows: gamesPanelVisibleRows.length, types: [...new Set(gamesPanelVisibleRows.map((x) => x.type))] }; };
                const pcsx2 = count('pcsx2');
                const melonds = count('melonds');
                const sources = availableSources();
                __e2e.calls.length = 0;
                startGameLaunch({ ...EMULATOR_SOURCE_BY_TYPE['melonds-game'].launch(gamesPanelVisibleRows[0]), name: 'x', fromPanel: true });
                const call = __e2e.calls.find((c) => c.name === 'launchEmulatorGame');
                const launched = isLaunching;
                endLaunching(); hideLoading();
                return { pcsx2, melonds, sources, payload: call && call.args[0], launched };`);
            expect(r.pcsx2.rows === 30 && r.pcsx2.types.join() === 'pcsx2-game', `PCSX2: ${JSON.stringify(r.pcsx2)}`);
            expect(r.melonds.rows === 10 && r.melonds.types.join() === 'melonds-game', `melonDS: ${JSON.stringify(r.melonds)}`);
            expect(r.sources.includes('pcsx2') && r.sources.includes('melonds'), `chips: ${r.sources}`);
            expect(r.payload && r.payload.source === 'melonds' && r.payload.path === '/nds/0.nds', `payload: ${JSON.stringify(r.payload)}`);
            expect(r.launched, 'startGameLaunch did not start');
            return { pcsx2: r.pcsx2.rows, melonds: r.melonds.rows };
        },
    },
    {
        // The card menu's "Remove" first arms, only the 2nd ✕ deletes; afterwards △
        // undoes it instead of opening the Games panel (undo-remove-launcher).
        name: 'card menu: removal with confirmation + △ undo',
        async run(win, expect) {
            const cross = `{ buttons: Object.assign([], { 0: { pressed: true } }), axes: [] }`;
            const r = await ev(win, `
                __e2e.calls.length = 0;
                openCardMenu('heroic');
                cardMenuFocus = cardMenuRootRows().findIndex((row) => row.id === 'remove');
                handleCardMenuInput(${FAKE_PAD});
                handleCardMenuInput(${cross});
                const armedLabel = document.querySelector('#cardMenuContent .armed') ? 'armed' : 'none';
                const removedAfterFirst = __e2e.calls.some((c) => c.name === 'removeLauncher');
                handleCardMenuInput(${FAKE_PAD});
                handleCardMenuInput(${cross});
                const removed = __e2e.calls.find((c) => c.name === 'removeLauncher');
                const pending = launcherUndoPending();
                const toast = document.getElementById('status').textContent;
                undoLauncherRemoval();
                const undo = __e2e.calls.find((c) => c.name === 'undoRemoveLauncher');
                return { armedLabel, removedAfterFirst, removed: removed && removed.args[0], pending, toast,
                         undo: undo && undo.args[0], open: cardMenu.isOpen(), after: launcherUndoPending() };`);
            expect(r.armedLabel === 'armed' && !r.removedAfterFirst, `the first ✕ did not only arm: ${JSON.stringify(r)}`);
            expect(r.removed === 'heroic' && !r.open, `the second ✕ did not delete: ${JSON.stringify(r)}`);
            expect(r.pending && /VISSZAVONÁS|UNDO/.test(r.toast), `no undo toast: ${r.toast}`);
            expect(r.undo === 'heroic' && !r.after, `the undo did not go out: ${JSON.stringify(r)}`);
            // Let the "RESTORED" toast finish — the next scenario reads its own toast.
            await waitFor(win, `!_toastActive`);
            return { toast: r.toast };
        },
    },
    {
        // After closing (○ or launch) the panel reopens at the same place — source +
        // focused item by KEY; opening the card menu for a specific source starts from the top.
        name: 'Games panel: place memory (source + focus) after closing',
        async run(win, expect) {
            await ev(win, `gamesPanelMemory = null; openGamesPanel(); return 0;`);
            await waitFor(win, `gamesPanelRows.some((r) => r.type === 'pcsx2-game')`);
            const before = await ev(win, `
                gamesPanelSource = 'pcsx2'; gamesPanelFocusIndex = 7; renderGamesPanel();
                const key = gamesRowKey(gamesPanelVisibleRows[7]);
                closeGamesPanel(${FAKE_PAD});
                return key;`);
            await ev(win, `openGamesPanel(); return 0;`);
            await waitFor(win, `gamesPanelRows.some((r) => r.type === 'pcsx2-game')`);
            const r = await ev(win, `
                const out = { source: gamesPanelSource, key: gamesRowKey(gamesPanelVisibleRows[gamesPanelFocusIndex]),
                              focusedEl: !!document.querySelector('#gamesPanelContent .focused') };
                closeGamesPanel(${FAKE_PAD});
                return out;`);
            expect(before && r.source === 'pcsx2' && r.key === before, `back: ${JSON.stringify(r)} (expected: ${before})`);
            expect(r.focusedEl, 'no focused element on the restored panel');
            await ev(win, `openGamesPanel('pcsx2'); return 0;`);
            await waitFor(win, `gamesPanelRows.some((r) => r.type === 'pcsx2-game')`);
            const fresh = await ev(win, `const i = gamesPanelFocusIndex; closeGamesPanel(${FAKE_PAD}); gamesPanelMemory = null; return i;`);
            expect(fresh === 0, `opening with a specific source did not start from the beginning: ${fresh}`);
            return { key: before };
        },
    },
    {
        name: 'failed launch: the specific reason in the toast + Select → Log',
        async run(win, expect) {
            const r = await ev(win, `
                __e2e.emit('onAppError', { appId: 'pcsx2-game-x', error: 'x', errorKey: 'err.flatpakNotInstalled', params: { app: 'net.pcsx2.PCSX2' } });
                await new Promise((res) => setTimeout(res, 50));
                const toast = document.getElementById('status').textContent;
                const jumpArmed = Date.now() - launchErrorAt < LOG_JUMP_MS;
                openSettingsView('log');
                await new Promise((res) => setTimeout(res, 150));
                const out = { toast, jumpArmed, view: settingsView, zone: settingsZone,
                              title: document.getElementById('settingsPanelTitle').textContent };
                closeSettings(${FAKE_PAD});
                return out;`);
            expect(/net\.pcsx2\.PCSX2/.test(r.toast) && /NAPLÓ/.test(r.toast), `toast: ${r.toast}`);
            expect(r.jumpArmed, 'the jump to the Log did not arm');
            expect(r.view === 'log' && r.zone === 'content', `view: ${r.view}/${r.zone}`);
            return r;
        },
    },
    {
        // The "＋ Add another program…" wizard with real button presses —
        // source → installed app → preview → add; the payload carries the selected flatpak.
        name: '"＋ Add launcher" wizard: installed app → preview → add-launcher',
        async run(win, expect) {
            await ev(win, `openSettingsView('launchers'); return 0;`);
            await waitFor(win, `launchersViewRows.some((r) => r.type === 'add-wizard')`);
            const press = (btn) => `
                handleLaunchersInput({ buttons: [], axes: [] });
                handleLaunchersInput({ buttons: Object.assign([], { ${btn}: { pressed: true } }), axes: [] });`;
            await ev(win, `
                launchersViewFocusIndex = launchersViewRows.findIndex((r) => r.type === 'add-wizard');
                handleLaunchersInput({ buttons: [], axes: [] });
                ${press(0)}
                return 0;`);
            const r1 = await ev(win, `return { open: launcherAddFlow.isOpen(), title: document.getElementById('settingsPanelTitle').textContent };`);
            expect(r1.open, 'the wizard did not open');
            await ev(win, `${press(0)} return 0;`); // "Installed application"
            await waitFor(win, `document.querySelectorAll('#settingsContent .launcher-icon-thumb').length === 2`);
            const r2 = await ev(win, `return { rows: document.querySelectorAll('#settingsContent .settings-item').length };`);
            await ev(win, `${press(0)} return 0;`); // the first app (by name: Bar Game)
            await waitFor(win, `!!document.querySelector('#settingsContent .launcher-add-preview')`);
            await shot(win, '07-launcher-add-preview');
            const r3 = await ev(win, `
                __e2e.calls.length = 0;
                ${press(0)}
                const call = __e2e.calls.find((c) => c.name === 'addLauncher');
                const out = { payload: call && call.args[0], open: launcherAddFlow.isOpen(), view: settingsView };
                closeSettings(${FAKE_PAD});
                return out;`);
            expect(r2.rows === 2, `app rows: ${r2.rows}`);
            expect(r3.payload && r3.payload.id === 'flatpak-org-foo-bar' && r3.payload.cmd === 'flatpak'
                && r3.payload.args.join(' ') === 'run org.foo.Bar', `payload: ${JSON.stringify(r3.payload)}`);
            expect(!r3.open && r3.view === 'launchers', `after adding: ${JSON.stringify(r3)}`);
            return { title: r1.title, payload: r3.payload.id };
        },
    },
    {
        name: 'Wi-Fi: list + ✕ on an unsaved password-protected network → masked keyboard (deferred 1.1)',
        async run(win, expect) {
            await ev(win, `wifiState.loaded = false; openSettings(); openSettingsView('wifi'); return 0;`);
            await waitFor(win, `wifiState.loaded`);
            await sleep(400);
            await shot(win, '08-wifi');
            const r = await ev(win, `
                const items = [...document.querySelectorAll('#settingsContent .settings-item')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim());
                const pad = (b) => ({ buttons: Object.assign([], b), axes: [] });
                handleSettingsInput(pad({}));                       // releasing the entering ✕
                handleSettingsInput(pad({ 13: { pressed: true } })); // ▼ to the 2nd network
                handleSettingsInput(pad({}));
                handleSettingsInput(pad({ 0: { pressed: true } }));  // ✕
                await new Promise((res) => setTimeout(res, 200));
                return { items, kb: keyboardPanel.isOpen(), masked: !!(kbConfig && kbConfig.masked),
                         title: document.getElementById('keyboardOverlay').textContent.includes('Neighbor 5G') };`);
            await sleep(300); // the keyboard overlay's transition
            await shot(win, '09-wifi-password');
            await ev(win, `closeKeyboard(${FAKE_PAD}); closeSettings(${FAKE_PAD}); return 0;`);
            expect(r.items.length === 4, `rows: ${JSON.stringify(r.items)}`);
            expect(/Home/.test(r.items[0]) && /AKTÍV/.test(r.items[0]), `active row: ${r.items[0]}`);
            expect(r.kb && r.masked && r.title, `keyboard: ${JSON.stringify(r)}`);
            return { rows: r.items.length, kb: r.kb };
        },
    },
    {
        name: 'Launchers: □ menu → "Enter folder manually" → folder browser → ✓ → set-launcher-path (native-11 round 3)',
        async run(win, expect) {
            await ev(win, `openSettings(); openSettingsView('launchers'); return 0;`);
            await waitFor(win, `settingsView === 'launchers' && launchersViewRows.some((r) => r.id === 'ryujinx')`);
            const r = await ev(win, `
                const pad = (b) => ({ buttons: Object.assign([], b), axes: [] });
                const step = async (b) => { handleSettingsInput(pad(b)); handleSettingsInput(pad({})); await new Promise((res) => setTimeout(res, 60)); };
                const items = () => [...document.querySelectorAll('#settingsContent .settings-item')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim());
                handleSettingsInput(pad({}));   // releasing the entering ✕
                launchersViewFocusIndex = launchersViewRows.findIndex((row) => row.id === 'ryujinx');
                renderLaunchersList();
                const hint = document.getElementById('settingsPanelHint').textContent;
                await step({ 2: { pressed: true } });          // □ → menu
                const menu = items();
                await step({ 0: { pressed: true } });          // ✕ "Set folder manually…"
                await new Promise((res) => setTimeout(res, 150));
                const browser = items();
                await step({});                                // releasing the browser's entering ✕
                await step({ 0: { pressed: true } });          // ✕ "✓ choose this folder"
                await new Promise((res) => setTimeout(res, 250));
                const calls = __e2e.calls.filter((c) => c.name === 'findLauncherExecutables' || c.name === 'setLauncherPath')
                    .map((c) => ({ name: c.name, args: c.args }));
                return { hint, menu, browser, calls, back: document.getElementById('settingsPanelTitle').textContent };`);
            await shot(win, '10-launcher-path');
            await ev(win, `closeSettings(${FAKE_PAD}); return 0;`);
            expect(/Továbbiak/.test(r.hint), `help line: ${r.hint}`);
            expect(r.menu.some((t) => /Mappa megadása kézzel/.test(t)), `menu: ${JSON.stringify(r.menu)}`);
            expect(r.browser.some((t) => /ezt a mappát választom/i.test(t)), `browser: ${JSON.stringify(r.browser)}`);
            expect(r.calls.length === 2 && r.calls[1].args[0].path === '/opt/ryujinx/Ryujinx' && r.calls[1].args[0].apply === true,
                `calls: ${JSON.stringify(r.calls)}`);
            return { menu: r.menu.length, back: r.back };
        },
    },
    {
        name: 'UI size "large": no horizontal overflow, the Settings fit',
        async run(win, expect) {
            await ev(win, `applyUiScale('large'); openSettings(); return 0;`);
            await sleep(400);
            const r = await ev(win, `
                const p = document.querySelector('#settingsOverlay .settings-panel').getBoundingClientRect();
                return { overflowX: document.documentElement.scrollWidth - innerWidth, right: p.right, bottom: p.bottom };`);
            await ev(win, `closeSettings(${FAKE_PAD}); applyUiScale('normal'); return 0;`);
            expect(r.overflowX <= 0, `overflow: ${r.overflowX}`);
            expect(r.right <= WIDTH && r.bottom <= HEIGHT, `the panel sticks out: ${JSON.stringify(r)}`);
            return r;
        },
    },
];

// The REAL preload.js (sandbox + contextBridge + the synchronous `get-boot-state`) in a separate
// window with the same webPreferences as the production `createWindow()`: does it expose `window.launcher`?
// An Electron upgrade can break this most silently (see "Preload and the sandbox" in docs/dev/architecture.md).
async function checkRealPreload() {
    ipcMain.on('get-boot-state', (event) => {
        event.returnValue = { theme: 'nord', background: {}, launcherIcons: ['assets/icons/steam.svg'], safeMode: null };
    });
    const w = new BrowserWindow({
        show: false, width: 400, height: 300,
        webPreferences: { offscreen: true, preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    await w.loadURL('data:text/html,<html><body></body></html>');
    const r = await w.webContents.executeJavaScript(`({
        has: typeof window.launcher === 'object' && window.launcher !== null,
        theme: window.launcher && window.launcher.initialTheme,
        icons: window.launcher && window.launcher.initialLauncherIcons,
        fns: window.launcher ? Object.values(window.launcher).filter((v) => typeof v === 'function').length : 0,
        nodeLeak: typeof require !== 'undefined' || typeof process !== 'undefined',
    })`);
    w.destroy();
    ipcMain.removeAllListeners('get-boot-state');
    return r;
}

async function main() {
    const results = [];
    {
        const failures = [];
        let details = null;
        try {
            details = await checkRealPreload();
            if (!details.has) failures.push('the real preload.js did not expose window.launcher');
            if (details.theme !== 'nord') failures.push(`initialTheme: ${details.theme} (the sendSync boot-state did not arrive)`);
            if (!Array.isArray(details.icons) || details.icons.length !== 1) failures.push('initialLauncherIcons is missing');
            if (details.fns < 100) failures.push(`only ${details.fns} window.launcher functions`);
            if (details.nodeLeak) failures.push('require/process is visible in the renderer (contextIsolation is broken)');
        } catch (err) {
            failures.push(`exception: ${err.message}`);
        }
        results.push({ name: 'real preload.js: sandbox + contextBridge + sendSync boot-state', ok: !failures.length, failures, details, ms: 0 });
    }

    const win = new BrowserWindow({
        show: false, width: WIDTH, height: HEIGHT, frame: false, useContentSize: true,
        // Newer Electron would shrink the window to the screen (the headless "screen" is small) —
        // so the 4K run would silently test at a smaller size. See the size check below.
        enableLargerThanScreen: true,
        webPreferences: {
            offscreen: true, contextIsolation: false, sandbox: false, nodeIntegration: false,
            preload: path.join(__dirname, 'preload-stub.js'),
        },
    });
    win.webContents.setFrameRate(30);
    const consoleErrors = [];
    // Electron ≤34: (event, level:number, message); 35+: the data is on the event object
    // (`level: 'error'|…`, `message`) — we handle both (for the upgrade comparison).
    win.webContents.on('console-message', (e, level, message) => {
        const lvl = e && e.level !== undefined ? e.level : level;
        const msg = e && e.message !== undefined ? e.message : message;
        if (lvl === 'error' || lvl === 3) consoleErrors.push(msg);
    });
    await win.loadFile(path.join(root, 'index.html'));
    const vp = await ev(win, `return { w: innerWidth, h: innerHeight };`);
    if (Math.abs(vp.w - WIDTH) > 1 || Math.abs(vp.h - HEIGHT) > 1) {
        // setSize may bypass the constructor limit; if it is still wrong, the run is invalid.
        win.setContentSize(WIDTH, HEIGHT);
        await sleep(200);
        const vp2 = await ev(win, `return { w: innerWidth, h: innerHeight };`);
        if (Math.abs(vp2.w - WIDTH) > 1 || Math.abs(vp2.h - HEIGHT) > 1) {
            throw new Error(`the viewport is ${vp2.w}×${vp2.h}, not the requested ${WIDTH}×${HEIGHT}`);
        }
    }

    let before = 0; // the first scenario also sees the errors during loading
    for (const sc of SCENARIOS) {
        const failures = [];
        const expect = (cond, msg) => { if (!cond) failures.push(msg); };
        const t0 = Date.now();
        let details = null;
        try {
            details = await sc.run(win, expect);
        } catch (err) {
            failures.push(`exception: ${err.message}`);
        }
        const errs = await ev(win, `return __e2e.errors.slice(${before});`);
        before += errs.length;
        for (const e of errs) failures.push(`renderer error: ${e}`);
        results.push({ name: sc.name, ok: !failures.length, failures, details, ms: Date.now() - t0 });
    }
    const out = {
        electron: process.versions.electron, chrome: process.versions.chrome,
        size: `${WIDTH}x${HEIGHT}`, results, consoleErrors,
    };
    process.stdout.write(`E2E_RESULT ${JSON.stringify(out)}\n`);
    app.exit(0);
}

// Do not quit the app when the preload-check window closes (Electron default).
app.on('window-all-closed', () => {});

app.whenReady().then(main).catch((err) => {
    process.stdout.write(`E2E_RESULT ${JSON.stringify({ fatal: err.stack || String(err) })}\n`);
    app.exit(1);
});
