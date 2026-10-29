// "What's new" panel after a self-update. The `renderer/main.js` init calls `maybeShowChangelog()`: if main returns `pending: true` (the
// `pendingChangelog` marker is set), shows a one-off panel from the latest CHANGELOG.md section. ✕/○/PS = close → `dismiss-changelog` (the
// marker is cleared).
//
// Load order: AFTER card-menu.js, BEFORE gamepad.js (pollGamepad references the `changelogPanel.isOpen()` flag + `handleChangelogInput`).

// Lifecycle on the shared `createOverlay` (renderer/util.js). It opens by itself at startup (no opening button press) → empty entry state.
const changelogPanel = createOverlay({
    elementId: 'changelogOverlay',
    syncOnClose: () => ({ states: buttonStates, keys: ['cross', 'ps'] }),
    onOpen: (data) => renderChangelog(data),
    onClose: () => window.launcher.dismissChangelog(),
});

async function maybeShowChangelog() {
    let data;
    try {
        data = await window.launcher.getChangelog();
    } catch (err) {
        return;
    }
    if (!data || !data.pending) return;
    changelogPanel.open(data);
}

// The lines of the `## …` section: `### X` → subheader, `- item` → list row, any other non-empty line → plain paragraph. Markdown markers
// (`**`, `` ` ``) are simply stripped.
function stripMd(s) {
    return String(s).replace(/\*\*/g, '').replace(/`/g, '');
}

function renderChangelog(data) {
    $('changelogTitle').textContent = data.heading
        ? tr('changelog.titleWith', { heading: data.heading })
        : tr('changelog.title');
    $('changelogHint').innerHTML = `<span>${btnIcon('back')} ${esc(tr('hint.close'))}</span>`;

    const rows = [];
    for (const raw of (data.lines || [])) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('### ')) {
            rows.push(`<div class="settings-subhead">${esc(stripMd(line.slice(4)))}</div>`);
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
            rows.push(`<div class="settings-item changelog-item">${esc(stripMd(line.slice(2)))}</div>`);
        } else {
            rows.push(`<div class="changelog-para">${esc(stripMd(line))}</div>`);
        }
    }
    $('changelogContent').innerHTML = rows.join('') || emptyState(tr('changelog.empty'));
}

function closeChangelog(gp) { changelogPanel.close(gp); }

function handleChangelogInput(gp) {
    // Any "confirm/back/home" button closes it (the panel is purely informational).
    edge(changelogPanel.states, 'close',
        gp.buttons[BTN.cross]?.pressed || gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed,
        () => { feedback('back'); closeChangelog(gp); });
    // ▲▼ = scroll (with a long changelog the list exceeds the panel's max-height).
    const el = $('changelogContent');
    const page = () => Math.max(40, el.clientHeight * 0.8);
    // Held, it scrolls continuously (edgeRepeat).
    edgeRepeat(changelogPanel.states, 'up', gp.buttons[BTN.up]?.pressed, () => el.scrollBy(0, -page()));
    edgeRepeat(changelogPanel.states, 'down', gp.buttons[BTN.down]?.pressed, () => el.scrollBy(0, page()));
}
