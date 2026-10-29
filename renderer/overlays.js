// Full-screen overlays: launch loading bar, TV-mode exit progress, volume bar. DOM manipulation only, minimal state (volume hide timer).
// Load order: after util.js.

// `launcherId` (optional): id of the launched launcher — its icon is highlighted in the icon loader ("what is starting"). For a game launch
// `kind` (steam/heroic/retroarch/…) matches the launcher id; if there is no such launcher, nothing is highlighted, the wave runs anyway.
// `cover` (optional): the cover's local path for a game launch — shown sharp + as a blurred background, so WHAT is starting stays visible
// during a long (Proton) startup.
function showLoading(name, action, launcherId, cover) {
    const overlay = $('loadingOverlay');
    launchSessionName = name || '';
    $('loadingText').textContent = name.toUpperCase() + ' ' + (action || tr('verb.launching')) + '...';
    // Fresh markup on every show → the wave animation starts from the beginning (no separate "animation restart" trick).
    $('loadingLoader').innerHTML = loadingBlock('lg', { activeId: launcherId, immediate: true });
    setLoadingCover(cover);
    $('loadingCancelText').textContent = tr('loading.cancelHold', { btn: btnGlyph('back') });
    setLoadingCancelProgress(0);
    overlay.classList.add('visible');
}

// Local path → file:// URL; a cover already in URL form (file:/data:) is unchanged.
function loadingCoverSrc(cover) {
    if (!cover) return '';
    return /^(file|data):/.test(cover) ? cover : fileUrl(cover);
}

function setLoadingCover(cover) {
    const src = loadingCoverSrc(cover);
    for (const id of ['loadingCover', 'loadingCoverBg']) {
        const img = /** @type {HTMLImageElement} */ ($(id));
        if (!img) continue;
        img.onerror = src ? () => { img.hidden = true; } : null; // broken cover → only the loader remains
        if (src) img.src = src; else img.removeAttribute('src');
        img.hidden = !src;
    }
}

// The session summary toast on return: main's `app-closed` payload (`{ appId, sessionMs, totalMs }`) + the name remembered at showLoading
// → `{ key, name, sessionMs, totalMs }`, or `null` = the plain "BACK TO THE LAUNCHER" stays. A session shorter than 1 minute (typically a
// failed / immediately closed launch) does not count; if the total ≈ the current one (first time), the "total" part is omitted.
const SESSION_SUMMARY_MIN_MS = 60 * 1000;
function sessionSummary(summary, name) {
    const ms = summary ? Number(summary.sessionMs) : NaN;
    if (!name || !Number.isFinite(ms) || ms < SESSION_SUMMARY_MIN_MS) return null;
    const total = summary.totalMs == null ? NaN : Number(summary.totalMs);
    const withTotal = Number.isFinite(total) && total - ms >= SESSION_SUMMARY_MIN_MS;
    return {
        key: withTotal ? 'toast.sessionSummary' : 'toast.sessionSummaryFirst',
        name: String(name).toUpperCase(), sessionMs: ms, totalMs: withTotal ? total : ms,
    };
}

// Playtime reminder: on return, if today's playtime (launched from the launcher) reached the configured hours → a warning text (does not
// block, only notifies); `null` = nothing to do.
function playtimeReminderText(summary, hours, t = (typeof tr === 'function' ? tr : (k) => k), fmt = (typeof formatDuration === 'function' ? formatDuration : (ms) => String(ms))) {
    const h = Number(hours);
    const today = summary && summary.todayMs != null ? Number(summary.todayMs) : NaN;
    if (!(h > 0) || !Number.isFinite(today) || today < h * 3600 * 1000) return null;
    return t('toast.playtimeReminder', { time: fmt(today) });
}

function hideLoading() {
    $('loadingOverlay').classList.remove('visible');
}

// The progress bar of "hold ○ = cancel" on the loading screen (0–1).
function setLoadingCancelProgress(ratio) {
    $('loadingCancelFill').style.width = `${Math.min(100, Math.max(0, ratio) * 100)}%`;
}

function updateExitProgress(ratio) {
    const progress = $('exitProgress');
    progress.classList.add('visible');
    $('exitProgressFill').style.width = Math.min(100, ratio * 100) + '%';
}

function hideExitProgress() {
    const progress = $('exitProgress');
    progress.classList.remove('visible');
    $('exitProgressFill').style.width = '0%';
}

function showExitLabel() {
    $('exitLabel').classList.add('visible');
}

// Volume (L1/R1)
let volumeHideTimeout = null;
// L1/R1 step in % — Settings → Display and audio → "Volume step" (`volumeStep` pref); loaded/refreshed by renderer/ipc.js. The cap
// (`volumeMax`) is applied by main.
let volumeStep = 5;

function showVolumeOverlay(volume) {
    if (volume === null || volume === undefined) return;
    $('volumeFill').style.width = volume + '%';
    $('volumePercent').textContent = volume + '%';
    $('volumeOverlay').classList.add('visible');
    clearTimeout(volumeHideTimeout);
    volumeHideTimeout = setTimeout(() => {
        $('volumeOverlay').classList.remove('visible');
    }, 1500);
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        playtimeReminderText, sessionSummary, SESSION_SUMMARY_MIN_MS, loadingCoverSrc });
}
