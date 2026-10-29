// Settings → Launcher order subview: a "drag and drop" pattern. `orderGrabbedIndex` != null: the item is "picked up", ▲▼ then moves it in the
// array instead of the focus. The order is written when stepping back to the menu (commitOrder), not on every move. Load order: after
// settings.js.

let orderList = [];
let orderFocusIndex = 0;
let orderGrabbedIndex = null;
let orderButtonStates = {};

function openLauncherOrderView() {
    $('settingsPanelTitle').textContent = tr('menu.launcher-order');
    orderList = launchers.map((l) => ({ id: l.id, name: l.name }));
    orderFocusIndex = 0;
    orderGrabbedIndex = null;
    // We entered the subview with X (menu); while it is held, handleLauncherOrderInput must not mistake it for an immediate "pick up". Cleared
    // on release.
    orderButtonStates = { cross: true };
    renderLauncherOrderList();
}

function renderLauncherOrderList() {
    $('settingsContent').innerHTML = orderList.map((item, i) => {
        const cls = ['settings-item'];
        if (i === orderFocusIndex) cls.push('focused');
        if (i === orderGrabbedIndex) cls.push('grabbed');
        const marker = i === orderGrabbedIndex ? ' <span class="audio-current-tag">⇅</span>' : '';
        return `<div class="${cls.join(' ')}"><span class="bt-name">${i + 1}. ${esc(item.name)}</span>${marker}</div>`;
    }).join('');
    scrollSettingsFocusIntoView();
    const grabbed = orderGrabbedIndex !== null;
    $('settingsPanelHint').innerHTML = grabbed
        ? `
        <span>▲▼ ${esc(tr('hint.move'))}</span>
        <span>${btnIcon('confirm')} ${esc(tr('hint.drop'))}</span>
        <span>${btnIcon('back')} ${esc(tr('hint.back'))}</span>
    `
        : subviewHint('hint.grab');
}

// Only writes the file / rerenders the cards if the order actually changed.
function commitOrder() {
    const nextIds = orderList.map((o) => o.id);
    const curIds = launchers.map((l) => l.id);
    if (nextIds.length === curIds.length && nextIds.every((id, i) => id === curIds[i])) return;
    window.launcher.setLauncherOrder(nextIds);
}

function moveGrabbed(dir) {
    const j = orderGrabbedIndex + dir;
    if (j < 0 || j >= orderList.length) return;
    [orderList[orderGrabbedIndex], orderList[j]] = [orderList[j], orderList[orderGrabbedIndex]];
    orderGrabbedIndex = j;
    orderFocusIndex = j;
    renderLauncherOrderList();
}

// "Drag and drop": in the grabbed state ▲▼ moves in the array, not the focus — hence not navList but a manual edgeRepeat().
function handleLauncherOrderInput(gp) {
    const bs = orderButtonStates;
    const step = (d, repeated) => {
        if (orderGrabbedIndex !== null) {
            moveGrabbed(d);
        } else if (orderList.length) {
            orderFocusIndex = stepIndex(orderFocusIndex, d, orderList.length, repeated);
            renderLauncherOrderList();
        }
    };
    edgeRepeat(bs, 'up', gp.buttons[BTN.up]?.pressed, (rep) => { step(-1, rep); feedback('nav', { repeated: rep }); });
    edgeRepeat(bs, 'down', gp.buttons[BTN.down]?.pressed, (rep) => { step(1, rep); feedback('nav', { repeated: rep }); });
    edge(bs, 'cross', gp.buttons[BTN.cross]?.pressed, () => {
        orderGrabbedIndex = orderGrabbedIndex === null ? orderFocusIndex : null;
        feedback('nav');
        renderLauncherOrderList();
    });
    edge(bs, 'cancel', gp.buttons[BTN.circle]?.pressed || gp.buttons[BTN.ps]?.pressed, () => {
        feedback('back');
        if (orderGrabbedIndex !== null) {
            orderGrabbedIndex = null; // put it down first, do not step back yet
            renderLauncherOrderList();
        } else {
            commitOrder();
            backToSettingsMenu(gp);
        }
    });
}

SETTINGS_VIEWS['launcher-order'] = { open: openLauncherOrderView, handle: handleLauncherOrderInput };
