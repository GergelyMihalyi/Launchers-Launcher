// Settings → Update subview (`system` group). On entry `check-update` (git fetch + status/rev-list at the repo root) → state; ✕ = update
// (`git pull --ff-only` + relaunch), ONLY if there is a new commit AND the working tree is clean. Load order: after settings.js.

let updateStatus = null;
let updateButtonStates = {};
let updateInProgress = false;
// Dependency hygiene: `npm outdated` + `npm audit` — informational only, requested in the background AFTER the update state (network-bound,
// may take seconds). `null` = in progress.
let depHealth = null;

async function openUpdateView() {
    setSubviewFrame({ title: tr('menu.update'), skeleton: true });
    $('settingsPanelHint').innerHTML = `
        <span>${btnIcon('confirm')} ${esc(tr('hint.update'))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>
    `;
    // Entered from the menu with ✕ — while it is held, it must not start an update immediately.
    updateButtonStates = { cross: true };
    updateInProgress = false;
    depHealth = null;
    updateStatus = await window.launcher.checkUpdate().catch(() => ({ state: 'error' }));
    if (settingsView !== 'update') return; // left meanwhile
    renderUpdateView();
    window.launcher.checkDependencies().catch(() => ({ ok: false })).then((res) => {
        if (settingsView !== 'update' || updateInProgress) return;
        depHealth = res || { ok: false };
        renderUpdateView();
    });
}

// HTML of the "Dependencies" section (pure apart from `tr`/`esc`). `h === null` → in progress.
function depHealthHtml(h) {
    let body;
    if (!h) {
        body = esc(tr('sv.depChecking'));
    } else if (!h.ok) {
        body = esc(tr('sv.depUnavailable'));
    } else {
        const lines = [];
        if (h.outdated) {
            if (!h.outdated.length) lines.push(esc(tr('sv.depUpToDate')));
            else {
                const shown = h.outdated.slice(0, 5).map((p) => `${p.name} ${p.current || '?'} → ${p.latest || '?'}${p.major ? ` (${tr('sv.depMajor')})` : ''}`);
                lines.push(esc(tr('sv.depOutdated', { n: h.outdated.length, list: shown.join(', ') })));
            }
        }
        if (h.audit) {
            lines.push(h.audit.total
                ? `<span class="tag-warn">${esc(tr('sv.depVulns', { n: h.audit.total, critical: h.audit.critical, high: h.audit.high }))}</span>`
                : esc(tr('sv.depNoVulns')));
        }
        body = lines.join('<br>');
    }
    return `<div class="settings-subhead">${esc(tr('sv.depTitle'))}</div>`
        + `<div class="settings-empty">${body}<br><span class="bt-disamb">${esc(tr('sv.depNote'))}</span></div>`;
}

function renderUpdateView() {
    const s = updateStatus || { state: 'error' };
    const confirm = btnGlyph('confirm');
    const branchNote = s.branch && s.branch !== 'main'
        ? `<br><br><span class="bt-disamb">${esc(tr('sv.updateBranchNote', { branch: s.branch }))}</span>` : '';
    let body;
    switch (s.state) {
        case 'up-to-date':
            body = `${esc(tr('sv.updateUpToDate'))}${branchNote}`;
            break;
        case 'available':
            body = esc(tr('sv.updateAvailable', { n: s.ahead }))
                + (s.needsNpmInstall ? `<br><br>${esc(tr('sv.updateNpmNote'))}` : '')
                + `<br><br>${esc(tr('sv.updateConfirmNote', { confirm }))}${branchNote}`;
            break;
        case 'dirty':
            body = esc(tr('sv.updateDirty', { n: s.dirtyFiles || '?' }))
                + `<br><br>${esc(tr('sv.updateDirtyNote'))}`;
            break;
        case 'offline':
            body = esc(tr('sv.updateOffline'));
            break;
        case 'no-upstream':
            body = esc(tr('sv.updateNoUpstream', { branch: s.branch || '?' }))
                + `<br><br>${esc(tr('sv.updateNoUpstreamNote'))}`;
            break;
        default:
            body = `${esc(tr('sv.updateCheckFailed'))}${s.message ? `: ${esc(s.message)}` : ''}.`;
    }
    $('settingsContent').innerHTML = `<div class="settings-empty">${body}</div>${depHealthHtml(depHealth)}`;
    scrollSettingsFocusIntoView();
}

// The "update in progress" screen — called by the initial ✕ press AND the later `apply-update-progress` push (npm install phase).
function renderUpdateProgress(phase) {
    const key = phase === 'npm-install' ? 'sv.updateInstalling' : 'sv.updateInProgress';
    // May take minutes (npm install) — the icon loader shows that the launcher is alive.
    $('settingsContent').innerHTML = loadingBlock('lg', { immediate: true })
        + `<div class="settings-empty">${esc(tr(key))}</div>`;
}

function handleUpdateInput(gp) {
    navList(gp, updateButtonStates, {
        count: 0, // no list — only ✕ (update) / ○ (back)
        move: () => {},
        onSelect: () => {
            if (updateInProgress) return;
            if (!updateStatus || updateStatus.state !== 'available') return;
            updateInProgress = true;
            renderUpdateProgress('pull');
            window.launcher.applyUpdate();
        },
        onBack: () => { if (!updateInProgress) backToSettingsMenu(gp); },
    });
}

SETTINGS_VIEWS['update'] = { open: openUpdateView, handle: handleUpdateInput };
