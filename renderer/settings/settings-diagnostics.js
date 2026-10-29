// Settings → Diagnostics subview (read-only). Collects the existing query IPCs (listMonitors/listAudioSinks/listBtDevices/listLauncherCatalog)
// on one screen, so on the kiosk machine the user can see without a terminal what the launcher detects. X = manual refresh. Load order:
// after settings.js.

let diagSections = [];

// `MARKS` of `lib/startup-timeline.js` → i18n keys (as literals, so test/contracts/i18n-keys.test.js checks them).
// The `desktop` field of `get-app-info` (lib/desktop-env.js) → label (a proper noun, not translated).
const DIAG_DESKTOP_LABELS = { kde: 'KDE Plasma', gnome: 'GNOME', unknown: '?' };

const STARTUP_MARK_KEYS = {
    appReady: 'sv.stAppReady',
    outputsApplied: 'sv.stOutputsApplied',
    windowCreated: 'sv.stWindowCreated',
    rendererLoaded: 'sv.stRendererLoaded',
    launchersRendered: 'sv.stLaunchersRendered',
    warmupDone: 'sv.stWarmupDone',
};
let diagFocusIndex = 0;
let diagButtonStates = {};
// Is the install of the missing system packages (`install-host-packages`) running right now — shared by Diagnostics and the wizard's
// "Done" step.
let hostInstallRunning = false;

// The install result → toast (i18n key + parameters + is it an error). Pure — test/settings/settings-diagnostics.test.js.
function hostInstallToast(res) {
    if (!res) return { key: 'toast.hostInstallFailed', params: { list: '?' }, isError: true };
    if (res.error === 'nothing-missing') return { key: 'toast.hostInstallNothing', params: {}, isError: false };
    if (res.ok) return { key: 'toast.hostInstallOk', params: { list: (res.packages || []).join(', ') }, isError: false };
    const missing = (res.missingAfter || []).join(', ') || '?';
    if (res.error === 'unknown-distro') return { key: 'toast.hostInstallUnknownDistro', params: { list: missing }, isError: true };
    if (res.error === 'no-installer') return { key: 'toast.hostInstallNoInstaller', params: {}, isError: true };
    return { key: 'toast.hostInstallFailed', params: { list: missing }, isError: true };
}

// Installs the packages of the missing commands; the system's polkit dialog asks for the password. `onDone(res)` may redraw with the fresh
// selftest (`res.selftest`). Never throws.
async function runHostPackageInstall(onDone) {
    if (hostInstallRunning) return;
    hostInstallRunning = true;
    showStatus(tr('toast.hostInstallRunning'));
    let res = null;
    try {
        res = await window.launcher.installHostPackages();
    } catch {
        res = null;
    }
    hostInstallRunning = false;
    const t = hostInstallToast(res);
    showStatus(tr(t.key, t.params), t.isError);
    if (onDone) onDone(res);
}

async function openDiagnosticsView() {
    // - the user may still hold the entering X.
    diagButtonStates = { cross: true };
    setSubviewFrame({ title: tr('menu.diagnostics'), hint: 'hint.refresh', skeleton: true });
    diagFocusIndex = 0;
    await refreshDiagnostics();
}

async function refreshDiagnostics() {
    const [appInfo, timeline, selftest, monitors, sinks, headsets, controllers, catalog, romAccess] = await Promise.all([
        window.launcher.getAppInfo().catch(() => null),
        window.launcher.getStartupTimeline().catch(() => []),
        window.launcher.getSelftest().catch(() => []),
        window.launcher.listMonitors(),
        window.launcher.listAudioSinks(),
        window.launcher.listBtDevices('headset'),
        window.launcher.listBtDevices('controller'),
        window.launcher.listLauncherCatalog(),
        // a fresh query — the user may be looking here right after a permission change
        window.launcher.getRomAccess({ refresh: true }).catch(() => ({ ok: false, items: [] })),
    ]);
    if (settingsView !== 'diagnostics') return; // left the subview meanwhile

    diagSections = [
        {
            title: tr('sv.diagVersion'), ok: true, emptyText: tr('sv.diagUnknown'),
            items: appInfo ? [
                { text: 'Launchers Launcher', tag: 'v' + appInfo.version },
                { text: 'Electron', tag: appInfo.electron },
                { text: 'Node', tag: appInfo.node },
                // GPU acceleration — CPU rendering gets a warning badge.
                {
                    text: tr('sv.diagGpu'),
                    // 'auto' = turned off up front because of an earlier GPU failure at startup (lib/gpu-fallback.js).
                    tag: appInfo.gpu === 'enabled' ? tr('sv.diagGpuOn')
                        : (appInfo.gpuReason === 'auto' ? tr('sv.diagGpuOffAuto') : tr('sv.diagGpuOff')),
                    warn: !!appInfo.gpu && appInfo.gpu !== 'enabled',
                },
                // Graphics platform (lib/ozone-platform.js).
                ...(appInfo.ozone ? [{ text: tr('sv.diagOzone'), tag: appInfo.ozone === 'x11' ? 'X11' : 'Wayland' }] : []),
                // Desktop environment (lib/desktop-env.js).
                ...(appInfo.desktop ? [{ text: tr('sv.diagDesktop'), tag: DIAG_DESKTOP_LABELS[appInfo.desktop] || appInfo.desktop }] : []),
                // Non-fatal main-process errors after startup (lib/fatal-policy.js) — details in the Log.
                ...(appInfo.backgroundErrors && appInfo.backgroundErrors.count > 0 ? [{
                    text: tr('sv.diagBackgroundErrors'), tag: String(appInfo.backgroundErrors.count), warn: true,
                }] : []),
            ] : [],
        },
        {
            // Startup timeline (lib/startup-timeline.js) — ms since process start; the same goes into the log as a `[startup] …` line.
            title: tr('sv.diagStartup'), ok: true, emptyText: tr('sv.diagUnknown'),
            items: (Array.isArray(timeline) ? timeline : []).map((m) => ({
                text: tr(STARTUP_MARK_KEYS[m.name] || 'sv.diagUnknown'),
                tag: `${(m.ms / 1000).toFixed(2)} s`,
            })),
        },
        {
            // Command self-test — are the external commands the launcher calls available. A missing row is `warn` (red badge).
            title: tr('sv.diagCommands'), ok: true, emptyText: tr('sv.diagUnknown'),
            // If something is missing, a last "Install missing" row (✕ = install).
            items: [
                ...(selftest || []).map((r) => ({
                    text: r.cmd,
                    tag: r.ok ? tr('sv.tagOk') : tr('sv.tagMissing'),
                    warn: !r.ok,
                })),
                ...((selftest || []).some((r) => !r.ok)
                    ? [{ text: tr('sv.diagInstallMissing'), action: 'install-host-packages' }] : []),
                // The command succeeded but the parser found nothing in its output (lib/host-deps/format-drift.js) — typically a format change after a
                // distro/DE update.
                ...((appInfo && Array.isArray(appInfo.formatDrift)) ? appInfo.formatDrift : []).map((d) => ({
                    text: d.probe, tag: tr('sv.tagFormatChanged'), warn: true,
                })),
            ],
        },
        {
            title: tr('sv.diagDisplays'), ok: monitors.ok, emptyText: tr('sv.noMonitors'),
            items: (monitors.items || []).map((m) => ({ text: m.label, tag: m.active ? tr('sv.tagActive') : null })),
        },
        {
            title: tr('sv.diagAudio'), ok: sinks.ok, emptyText: tr('sv.noSinks'),
            items: (sinks.items || []).map((s) => ({ text: s.description, tag: s.isDefault ? tr('sv.tagActive') : null })),
        },
        {
            title: tr('menu.bt-headset'), ok: headsets.ok, emptyText: tr('sv.diagNoPaired'),
            items: (headsets.items || []).map((d) => ({ text: d.name, tag: d.connected ? tr('sv.tagConnected') : null })),
        },
        {
            title: tr('sv.diagBtController'), ok: controllers.ok, emptyText: tr('sv.diagNoPaired'),
            items: (controllers.items || []).map((d) => {
                const bat = d.battery != null ? ` ${d.battery}%` : '';
                return { text: d.name, tag: d.connected ? `${tr('sv.tagConnected')}${bat}` : null };
            }),
        },
        {
            // list-launcher-catalog does not return an { ok, items } wrapper (it does not follow the safeList pattern - it is a best-effort
            // Promise.allSettled itself), always "ok".
            title: tr('sv.diagCatalog'), ok: true, emptyText: tr('sv.diagEmptyCatalog'),
            items: (catalog || []).map((e) => ({
                text: e.name,
                tag: e.active ? tr('sv.tagActive') : (e.installed ? tr('sv.tagInstalledBare') : null),
                warn: !e.active && e.installed === false,
            })),
        },
        {
            // Whether the flatpak emulators' ROM folders are visible from the sandbox — what is not, the emulator cannot find either ("file not found"),
            // although the Games panel lists it.
            title: tr('sv.diagRomAccess'), ok: romAccess.ok, emptyText: tr('sv.diagRomAccessNone'),
            items: (romAccess.items || []).map((r) => ({
                text: `${r.name}: ${r.dir}`,
                tag: r.visible ? tr('sv.tagOk') : tr('sv.tagNoAccess'),
                warn: !r.visible,
            })),
        },
    ];

    const total = diagItemCount();
    diagFocusIndex = total ? Math.min(diagFocusIndex, total - 1) : 0;
    renderDiagnostics();
}

function renderDiagItem(item) {
    if (item.action) {
        const tag = hostInstallRunning ? ` ${currentTag(tr('sv.diagInstalling'), { paren: true })}` : '';
        return `<span class="bt-name">＋ ${esc(item.text)}</span>${tag}`;
    }
    const tag = item.warn
        ? ` <span class="tag-warn">${esc(item.tag || tr('sv.tagNotInstalled'))}</span>`
        : (item.tag ? ` ${currentTag(item.tag, { paren: true })}` : '');
    return `<span class="bt-name">${esc(item.text)}</span>${tag}`;
}

function renderDiagnostics() {
    $('settingsContent').innerHTML = renderFlatSections(diagSections, diagFocusIndex, renderDiagItem);
    scrollSettingsFocusIntoView();
}

function diagItemCount() {
    return flatSectionItemCount(diagSections);
}

// The flat focus index → the section item (in the walk order of renderFlatSections).
function diagItemAt(index) {
    let i = 0;
    for (const section of diagSections) {
        if (section.ok === false) continue;
        for (const item of section.items) {
            if (i === index) return item;
            i++;
        }
    }
    return null;
}

function onDiagnosticsSelect() {
    const item = diagItemAt(diagFocusIndex);
    if (item && item.action === 'install-host-packages') {
        runHostPackageInstall(() => {
            if (settingsView === 'diagnostics') refreshDiagnostics().catch(ignoreError);
        }).catch(ignoreError);
        if (settingsView === 'diagnostics') renderDiagnostics(); // the "…" badge
        return;
    }
    refreshDiagnostics().catch(ignoreError);
}

function handleDiagnosticsInput(gp) {
    const count = diagItemCount();
    navList(gp, diagButtonStates, {
        count,
        move: (d, repeated) => { diagFocusIndex = stepIndex(diagFocusIndex, d, count, repeated); renderDiagnostics(); },
        onSelect: onDiagnosticsSelect,
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['diagnostics'] = { open: openDiagnosticsView, handle: handleDiagnosticsInput };

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { hostInstallToast });
}
