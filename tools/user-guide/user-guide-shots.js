'use strict';

// Regenerates the user guide (docs/user-guide/README.md) screenshots from the REAL UI:
// the technique of test/e2e/harness.js (offscreen BrowserWindow, the real index.html +
// renderer, stubbed `window.launcher`), with made-up sample data (user-guide-fixtures.js).
// Reloads the page per scene (clean state) and calls the renderer globals directly.
//
// Run (from the repo root, also works from the agent sandbox):
//   npm run user-guide-shots
//   = env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron tools/user-guide/user-guide-shots.js --headless --no-sandbox
// Output: docs/user-guide/img/*.jpg (1280 px wide; theme images 640 px). Exits non-zero on a
// renderer error. Re-run after a UI change and commit the images.

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..', '..');
const OUT = process.env.USER_GUIDE_OUT || path.join(root, 'docs', 'user-guide', 'img');
const WIDTH = 1920;
const HEIGHT = 1080;
const PAD = '{ buttons: [], axes: [] }';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ev(win, body) {
    return win.webContents.executeJavaScript(`(async () => { ${body} })()`);
}

async function waitFor(win, cond, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await ev(win, `return !!(${cond});`)) return;
        await sleep(50);
    }
    throw new Error(`timed out waiting for: ${cond}`);
}

// Every animation (carousel, overlay entry) has finished and the visible images have loaded.
async function settle(win) {
    await ev(win, `
        const end = Date.now() + 4000;
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const running = () => document.getAnimations().filter((a) => a.playState === 'running' && isFinite(a.effect?.getTiming().iterations));
        while (running().length && Date.now() < end) {
            await Promise.race([Promise.all(running().map((a) => a.finished.catch(() => {}))), new Promise((res) => setTimeout(res, 250))]);
        }
        await Promise.all([...document.images].filter((i) => i.src && !i.complete)
            .map((i) => new Promise((res) => { i.onload = i.onerror = res; setTimeout(res, 2000); })));
        return 0;`);
    await sleep(150);
}

async function shot(win, name, width = 1280) {
    await settle(win);
    const img = (await win.webContents.capturePage()).resize({ width, quality: 'best' });
    fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(84));
    process.stdout.write(`  ${name}.jpg\n`);
}

async function fresh(win, theme = 'neon') {
    await win.loadFile(path.join(root, 'index.html'));
    await ev(win, `document.getElementById('bootSplash')?.remove(); return 0;`); // the startup logo animation would cover the shots
    await waitFor(win, `typeof launchers !== 'undefined' && launchers.length > 0 && document.querySelectorAll('#cards .card').length === launchers.length + 1`);
    await ev(win, `applyTheme(${JSON.stringify(theme)}); return 0;`);
    const vp = await ev(win, `return [innerWidth, innerHeight];`);
    if (vp[0] !== WIDTH || vp[1] !== HEIGHT) throw new Error(`the viewport is ${vp.join('×')}, not ${WIDTH}×${HEIGHT}`);
    await settle(win);
}

async function openPanel(win, source) {
    await ev(win, `gamesPanelMemory = null; openGamesPanel(${source ? JSON.stringify(source) : ''}); return 0;`);
    await waitFor(win, `gamesPanel.isOpen() && gamesPanelVisibleRows.length > 0`);
}

// Button-press simulation for a handler: a released frame, then the button pressed.
const press = (handler, btn) => `${handler}(${PAD}); ${handler}({ buttons: Object.assign([], { ${btn}: { pressed: true } }), axes: [] });`;

const SCENES = [
    ['01-home', async (win) => { /* the fresh load itself */ }],
    ['02-continue-bar', async (win) => {
        await ev(win, `navExitRecentBar(); return 0;`);
    }],
    ['03-quick-launch-bar', async (win) => {
        await ev(win, `navEnterRecentBar(); return 0;`);
    }],
    ['04-card-menu', async (win) => {
        await ev(win, `openCardMenu('steam'); return 0;`);
    }],
    ['05-system-menu', async (win) => {
        await ev(win, `openQuickPowerMenu(); return 0;`);
    }],
    ['06-volume', async (win) => {
        await ev(win, `showVolumeOverlay(45); return 0;`);
    }],
    ['10-games-all', async (win) => {
        await openPanel(win);
    }],
    ['11-games-steam-grid', async (win) => {
        await openPanel(win, 'steam');
        await ev(win, `gamesPanelFocusIndex = 1; renderGamesPanel(); return 0;`);
    }],
    ['12-games-filter', async (win) => {
        await openPanel(win);
        await ev(win, `openGamesSourceFilter(); return 0;`);
    }],
    ['13-games-search', async (win) => {
        await openPanel(win);
        await ev(win, `openGamesSearch(); return 0;`);
        await waitFor(win, `keyboardPanel.isOpen()`);
        await ev(win, `for (const ch of 'cry') kbKey(ch); return 0;`);
    }],
    ['14-game-details', async (win) => {
        await openPanel(win, 'steam');
        await ev(win, `gamesPanelFocusIndex = gamesPanelVisibleRows.findIndex((r) => r.type === 'game'); renderGamesPanel(); openGameDetailsForFocused(); return 0;`);
        await waitFor(win, `gamesDetails.isOpen() && !!document.querySelector('#gamesDetailsContent .game-details-facts')`);
    }],
    ['15-retroarch-systems', async (win) => {
        await openPanel(win, 'retro');
    }],
    ['20-settings', async (win) => {
        await ev(win, `openSettings(); return 0;`);
    }],
    ['21-settings-theme', async (win) => {
        await ev(win, `openSettings(); openSettingsView('theme'); return 0;`);
    }],
    ['22-settings-controls', async (win) => {
        await ev(win, `openSettings(); openSettingsView('controls'); return 0;`);
    }],
    ['23-settings-controllers', async (win) => {
        await ev(win, `openSettings(); openSettingsView('bt-controller'); return 0;`);
        await sleep(300);
    }],
    ['24-settings-launchers', async (win) => {
        await ev(win, `openSettings(); openSettingsView('launchers'); return 0;`);
        await waitFor(win, `launchersViewRows.length > 0`);
    }],
    ['25-add-launcher', async (win) => {
        await ev(win, `openSettings(); openSettingsView('launchers'); return 0;`);
        await waitFor(win, `launchersViewRows.some((r) => r.type === 'add-wizard')`);
        await ev(win, `
            launchersViewFocusIndex = launchersViewRows.findIndex((r) => r.type === 'add-wizard');
            handleLaunchersInput(${PAD});
            ${press('handleLaunchersInput', 0)}
            return 0;`);
        await ev(win, `${press('handleLaunchersInput', 0)} return 0;`);
        await waitFor(win, `document.querySelectorAll('#settingsContent .launcher-icon-thumb').length > 0`);
        await ev(win, `${press('handleLaunchersInput', 0)} return 0;`); // the first app → preview
        await waitFor(win, `!!document.querySelector('#settingsContent .launcher-add-preview')`);
    }],
    ['26-wifi', async (win) => {
        await ev(win, `wifiState.loaded = false; openSettings(); openSettingsView('wifi'); return 0;`);
        await waitFor(win, `wifiState.loaded`);
    }],
    ['27-power', async (win) => {
        await ev(win, `openSettings(); openSettingsView('power'); return 0;`);
    }],
    ['30-wizard-welcome', async (win) => {
        await ev(win, `openSetupWizard(false); return 0;`);
        await waitFor(win, `setupWizard.isOpen() && wizChoices.selftest.length > 0`);
    }],
    ['31-wizard-launchers', async (win) => {
        await ev(win, `openSetupWizard(false); return 0;`);
        await waitFor(win, `setupWizard.isOpen() && wizChoices.selftest.length > 0`);
        await ev(win, `wizStep = WIZ_SEQ.indexOf('launchers'); renderWizStep(); return 0;`);
        await sleep(300);
    }],
    ['32-wizard-controls', async (win) => {
        await ev(win, `openSetupWizard(false); return 0;`);
        await waitFor(win, `setupWizard.isOpen() && wizChoices.selftest.length > 0`);
        await ev(win, `wizStep = WIZ_SEQ.indexOf('controls'); renderWizStep(); return 0;`);
    }],
];

const THEME_SHOTS = ['nintendo', 'win31', 'oled', 'deck'];

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const win = new BrowserWindow({
        show: false, width: WIDTH, height: HEIGHT, frame: false, useContentSize: true, enableLargerThanScreen: true,
        webPreferences: {
            offscreen: true, contextIsolation: false, sandbox: false, nodeIntegration: false,
            preload: path.join(__dirname, 'user-guide-preload.js'),
        },
    });
    win.webContents.setFrameRate(30);
    // The headless "screen" is 0×0: the constructor size does not apply (empty capturePage) —
    // setContentSize works around it (see the viewport check in test/e2e/harness.js).
    win.setContentSize(WIDTH, HEIGHT);
    const errors = [];
    const collect = async (label) => {
        const errs = await ev(win, `return __shots.errors.splice(0);`);
        for (const e of errs) errors.push(`${label}: ${e}`);
    };

    for (const [name, run] of SCENES) {
        await fresh(win);
        await run(win);
        await shot(win, name);
        await collect(name);
    }
    for (const theme of THEME_SHOTS) {
        await fresh(win, theme);
        await shot(win, `40-theme-${theme}`, 640);
        await collect(theme);
    }
    if (errors.length) {
        process.stdout.write(`renderer errors:\n${errors.join('\n')}\n`);
        app.exit(1);
        return;
    }
    process.stdout.write(`done: ${OUT}\n`);
    app.exit(0);
}

app.on('window-all-closed', () => {});
app.whenReady().then(main).catch((err) => {
    process.stdout.write(`${err.stack || err}\n`);
    app.exit(1);
});
