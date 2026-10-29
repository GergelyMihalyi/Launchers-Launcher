// In-app flatpak installer overlay: ✕ on a not-installed catalog row of the Launchers subview → `openLauncherInstall(entry)`; "Install" →
// `install-flatpak` IPC, the % lines arrive on the `flatpak-install-progress` push (`liInstallProgress`/`liInstallDone`); success → main
// auto-adds + `launchers-changed`. Load order: AFTER changelog.js, BEFORE gamepad.js.

let liEntry = null;          // { id, name, flathubId }
let liState = 'confirm';     // 'confirm' | 'running' | 'done' | 'error'
let liPct = 0;
let liError = '';
let liFocus = 0;             // 0 = Install, 1 = Cancel
let liOwnerStates = null;    // the calling subview's *ButtonStates (syncEdge on close)

// Lifecycle on the shared `createOverlay` (renderer/util.js).
const launcherInstall = createOverlay({
    elementId: 'launcherInstallOverlay',
    // The X that selected the row may STILL be held — every edge key is set to "pressed" so they only fire on release + a fresh press.
    // Without this the confirm screen "skips".
    enterStates: { cross: true, close: true, cancel: true, up: true, down: true },
    // The calling subview's (Launchers) button watching did not run while the installer was open.
    syncOnClose: () => ({ states: liOwnerStates, keys: ['cross', 'cancel'] }),
    onOpen: (entry, ownerStates) => {
        liEntry = entry;
        liState = 'confirm';
        liPct = 0;
        liError = '';
        liFocus = 0;
        liOwnerStates = ownerStates || null;
        renderLauncherInstall();
    },
});

function openLauncherInstall(entry, ownerStates) {
    if (!entry) return;
    launcherInstall.open(entry, ownerStates);
}

function closeLauncherInstall(gp) { launcherInstall.close(gp); }

function renderLauncherInstall() {
    $('launcherInstallTitle').textContent = tr('li.title', { name: liEntry ? liEntry.name : '' });
    const c = $('launcherInstallContent');
    if (liState === 'running') {
        // The flatpak progress push arrives often: the icon loader (wave animation) must not restart on every %, so after the first draw only the
        // bar/% is patched.
        let run = c.querySelector('.li-running');
        if (!run) {
            c.innerHTML = `<div class="li-running">${loadingBlock('md', { immediate: true })}`
                + `<div class="li-status">${esc(tr('li.installing'))}</div>`
                + '<div class="li-bar"><div class="li-bar-fill"></div></div>'
                + '<div class="li-pct"></div></div>';
            run = c.querySelector('.li-running');
            $('launcherInstallHint').innerHTML = `<span>${esc(tr('li.pleaseWait'))}</span>`;
        }
        const fill = /** @type {HTMLElement} */ (run.querySelector('.li-bar-fill'));
        fill.classList.toggle('li-bar-indeterminate', liPct <= 0);
        fill.style.width = `${Math.max(4, liPct)}%`;
        const pct = /** @type {HTMLElement} */ (run.querySelector('.li-pct'));
        pct.textContent = liPct > 0 ? `${liPct}%` : '';
        pct.hidden = liPct <= 0;
        return;
    }
    if (liState === 'done') {
        c.innerHTML = `<div class="li-status">${esc(tr('li.done'))}</div>`;
        $('launcherInstallHint').innerHTML = `<span>${btnIcon('confirm')} / ${btnIcon('back')} ${esc(tr('hint.close'))}</span>`;
        return;
    }
    if (liState === 'error') {
        const detail = liError ? `<div class="li-cmd">${esc(liError)}</div>` : '';
        c.innerHTML = `<div class="li-status">${esc(tr('li.failed'))}</div>`
            + detail
            + `<div class="settings-empty">${esc(tr('li.failedHint', { cmd: `flatpak install flathub ${liEntry ? liEntry.flathubId : ''}` }))}</div>`;
        $('launcherInstallHint').innerHTML = `<span>${btnIcon('confirm')} / ${btnIcon('back')} ${esc(tr('hint.close'))}</span>`;
        return;
    }
    // confirm
    c.innerHTML = `<div class="li-status">${esc(tr('li.confirm'))}</div>`
        + `<div class="li-cmd">flatpak install flathub ${esc(liEntry ? liEntry.flathubId : '')}</div>`
        + `<div class="settings-item ${liFocus === 0 ? 'focused' : ''}"><span class="bt-name">${esc(tr('li.install'))}</span></div>`
        + `<div class="settings-item ${liFocus === 1 ? 'focused' : ''}"><span class="bt-name">${esc(tr('li.cancel'))}</span></div>`;
    $('launcherInstallHint').innerHTML = `
        <span>▲▼ ${esc(tr('hint.nav'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('hint.select'))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.close'))}</span>`;
}

// Called by renderer/ipc.js on the flatpak-install-progress / -done pushes.
function liInstallProgress(data) {
    if (!launcherInstall.isOpen() || !liEntry || data.id !== liEntry.id) return;
    liPct = Math.max(liPct, Math.min(100, data.pct | 0));
    liState = 'running';
    renderLauncherInstall();
}
function liInstallDone(data) {
    if (!launcherInstall.isOpen() || !liEntry || data.id !== liEntry.id) return;
    liState = data.ok ? 'done' : 'error';
    liError = data.ok ? '' : String(data.error || '').slice(0, 300);
    if (data.ok) {
        liPct = 100; feedback('nav');
        showStatus(tr('li.doneToast', { name: liEntry.name.toUpperCase() }));
    } else {
        feedback('back');
        showStatus(tr('li.failedToast', { name: liEntry.name.toUpperCase() }), true);
    }
    renderLauncherInstall();
}

function startLauncherInstall() {
    liState = 'running';
    liPct = 0;
    liError = '';
    renderLauncherInstall();
    feedback('nav');
    showStatus(tr('li.startedToast', { name: liEntry.name.toUpperCase() }));
    window.launcher.installFlatpak({ id: liEntry.id });
}

function handleLauncherInstallInput(gp) {
    if (liState === 'running') return; // main allows one install at a time
    if (liState === 'done' || liState === 'error') {
        edge(launcherInstall.states, 'close',
            gp.buttons[BTN.cross]?.pressed || gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed,
            () => closeLauncherInstall(gp));
        return;
    }
    // confirm: 2 rows (Install / Cancel)
    edge(launcherInstall.states, 'up', gp.buttons[BTN.up]?.pressed, () => { liFocus = 0; renderLauncherInstall(); });
    edge(launcherInstall.states, 'down', gp.buttons[BTN.down]?.pressed, () => { liFocus = 1; renderLauncherInstall(); });
    edge(launcherInstall.states, 'cross', gp.buttons[BTN.cross]?.pressed, () => {
        if (liFocus === 1) closeLauncherInstall(gp);
        else startLauncherInstall();
    });
    edge(launcherInstall.states, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed,
        () => closeLauncherInstall(gp));
}
