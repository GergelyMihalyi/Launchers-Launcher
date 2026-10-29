'use strict';

// lib/ipc/launcher-manage-ipc.js — body of the launcher-list maintenance IPC handlers (order/
// accent/catalog/add-remove/flatpak install). Tested with fake `deps` (modeled on
// `lib/ipc/finish-setup.js`/`test/ipc/finish-setup.test.js`) — no real file system / flatpak call,
// `lib/launcher-list.js` is mocked. `listIcons()` is the EXCEPTION: it reads the real
// `assets/icons/` folder (it has no logic that would need mocking).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLauncherManageHandlers } = require('../../lib/ipc/launcher-manage-ipc.js');
const path = require('node:path');
const realLib = require('../../lib/launcher-list.js');
const { fakeDeps } = require('../helpers/launcher-list-deps.js');

test('setLauncherOrder — filters out an unknown/duplicate id, writes + launchers-changed', () => {
    const deps = fakeDeps();
    deps.seedRaw([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const handlers = createLauncherManageHandlers(deps);
    handlers.setLauncherOrder(['b', 'bogus', 'a', 'a']);
    assert.deepEqual(deps.launchersLib.readLauncherOrder(), ['b', 'a']);
    assert.deepEqual(deps.launchersPayload().map((l) => l.id), ['b', 'a', 'c']); // 'c' stays at the end
    assert.equal(deps.sent.length, 1);
    assert.equal(deps.sent[0].channel, 'launchers-changed');
});

test('setLauncherAccent — unknown id: logs, sends nothing', () => {
    const deps = fakeDeps();
    deps.seedRaw([{ id: 'a' }]);
    const handlers = createLauncherManageHandlers(deps);
    handlers.setLauncherAccent({ id: 'nope', accent: '#ff0000' });
    assert.equal(deps.sent.length, 0);
    assert.ok(deps.logs.some((l) => l.includes('unknown launcher id')));
});

test('setLauncherAccent — valid hex: saves + reload + launchers-changed', () => {
    const deps = fakeDeps();
    deps.seedRaw([{ id: 'a' }]);
    const handlers = createLauncherManageHandlers(deps);
    handlers.setLauncherAccent({ id: 'a', accent: '#ff0000' });
    assert.equal(deps.config.get('launcherAccents', {}).a, '#ff0000');
    assert.equal(deps.reloadCalls.length, 1);
    assert.equal(deps.sent[0].channel, 'launchers-changed');
});

test('setLauncherAccent — null/invalid: deletes the saved accent', () => {
    const deps = fakeDeps();
    deps.seedRaw([{ id: 'a' }]);
    deps.config.set('launcherAccents', { a: '#00ff00' });
    const handlers = createLauncherManageHandlers(deps);
    handlers.setLauncherAccent({ id: 'a', accent: null });
    assert.equal('a' in deps.config.get('launcherAccents', {}), false);
});

test('listInstalledApps — flatpak + native .desktop merged, with icon; known; a native one that fails the gate is dropped', async () => {
    const deps = fakeDeps({
        desktopEntries: {
            listDesktopApps: async () => [
                { id: 'firefox', name: 'Firefox', cmd: 'firefox', args: [], icon: 'firefox' },
                { id: 'term', name: 'Shell', cmd: 'bash', args: ['-l'], icon: '' },
                { id: 'mygame', name: 'Aaa Game', cmd: '/opt/game/run.sh', args: ['--full'], icon: '/missing.png' },
            ],
        },
        appIcons: {
            buildIconIndex: async () => new Map(),
            resolveIconFile: (name) => (name === 'firefox' ? '/icons/firefox.png' : name === 'org.foo.Bar' ? '/icons/bar.svg' : null),
        },
    });
    deps.seedRaw([{ id: 'x', cmd: 'flatpak', args: ['run', 'org.foo.Bar'] }, { id: 'ff', cmd: '/usr/bin/firefox', args: [] }]);
    const handlers = createLauncherManageHandlers(deps);
    const res = await handlers.listInstalledApps();
    assert.equal(res.ok, true);
    assert.deepEqual(res.items.map((a) => [a.key, a.kind, a.cmd, a.args, a.icon, a.known]), [
        ['desktop:mygame', 'native', '/opt/game/run.sh', ['--full'], null, false],
        ['flatpak:org.foo.Bar', 'flatpak', 'flatpak', ['run', 'org.foo.Bar'], '/icons/bar.svg', true],
        ['desktop:firefox', 'native', 'firefox', [], '/icons/firefox.png', true],
    ]);
});

test('listInstalledApps — the failure of one source does not sink the list', async () => {
    const deps = fakeDeps({
        desktopEntries: { listDesktopApps: async () => { throw new Error('boom'); } },
        appIcons: { buildIconIndex: async () => new Map(), resolveIconFile: () => null },
    });
    const res = await createLauncherManageHandlers(deps).listInstalledApps();
    assert.deepEqual(res.items.map((a) => a.key), ['flatpak:org.foo.Bar']);
});

test('listLauncherCatalog — active from the raw ids, installed from isLauncherInstalled', async () => {
    const deps = fakeDeps();
    deps.seedRaw([{ id: 'steam' }]);
    const handlers = createLauncherManageHandlers(deps);
    const rows = await handlers.listLauncherCatalog();
    assert.deepEqual(rows.map((r) => [r.id, r.active, r.installed]), [
        ['steam', true, true],
        ['heroic', false, false],
    ]);
});

test('listIcons — reads the real assets/icons/ folder, with a relative path', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    const icons = handlers.listIcons();
    assert.ok(icons.length > 0);
    assert.ok(icons.every((f) => f.startsWith('assets/icons/')));
    assert.ok(icons.includes('assets/icons/cemu.png'));
});

test('addLauncher — catalog id: copies it, custom:true, reload + launchers-changed', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher('steam');
    assert.equal(deps.customLaunchers.length, 1);
    assert.equal(deps.customLaunchers[0].id, 'steam');
    assert.equal(deps.customLaunchers[0].custom, true);
    assert.equal(deps.customLaunchers[0].accent, '#112233');
    assert.equal(deps.reloadCalls.length, 1);
    assert.equal(deps.sent[0].channel, 'launchers-changed');
});

test('addLauncher — does not duplicate an already added id', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher('steam');
    handlers.addLauncher('steam');
    assert.equal(deps.customLaunchers.length, 1);
});

test('addLauncher — invalid payload: logs, does not write, sends an app-error toast', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher({ bogus: true });
    assert.equal(deps.customLaunchers.length, 0);
    assert.deepEqual(deps.sent.map((s) => s.channel), ['app-error']);
    assert.equal(deps.sent[0].payload.errorKey, 'err.launcherRejected');
    assert.ok(deps.logs.some((l) => l.includes('add-launcher')));
});

test('addLauncher — unknown catalog id: logs, does not write', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher('no-such');
    assert.equal(deps.customLaunchers.length, 0);
    assert.equal(deps.sent.length, 0);
});

test('addLauncher — browsed flatpak (`flatpak run <appid>`): adds it', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher({ id: 'flatpak-bar', name: 'Bar', cmd: 'flatpak', args: ['run', 'org.foo.Bar'] });
    assert.deepEqual(deps.customLaunchers.map((l) => l.id), ['flatpak-bar']);
    assert.equal(deps.sent[0].channel, 'launchers-changed');
});

test('addLauncher — a program that is also in the catalog, from the wizard: gets the catalog id, no duplicate', () => {
    const deps = fakeDeps();
    deps.launchersLib.matchCatalogEntry = realLib.matchCatalogEntry;
    deps.launcherCatalog.push({ id: 'lutris', name: 'Lutris', icon: 'assets/icons/lutris.png', cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'], nativeCmd: 'lutris' });
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher({ id: 'flatpak-net-lutris-lutris', name: 'Lutris', cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'] });
    handlers.addLauncher({ id: 'custom-lutris', name: 'Lutris', cmd: 'lutris', args: [] });
    assert.deepEqual(deps.customLaunchers.map((l) => [l.id, l.cmd, l.icon]), [['lutris', 'flatpak', 'assets/icons/lutris.png']]);
});

test('addLauncher — flatpak option between `run` and the appid (`--command=sh`): rejects it', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher({ id: 'x', name: 'X', cmd: 'flatpak', args: ['run', '--command=sh', 'org.foo.Bar'] });
    handlers.addLauncher({ id: 'y', name: 'Y', cmd: 'flatpak', args: ['override', '--filesystem=host', 'org.foo.Bar'] });
    assert.equal(deps.customLaunchers.length, 0);
    assert.deepEqual(deps.sent.map((s) => s.channel), ['app-error', 'app-error']);
});

test('addLauncher — catalog `nativeCmd` without arguments: adds it (without which too)', () => {
    const deps = fakeDeps();
    deps.launcherCatalog = [...deps.launcherCatalog, {
        id: 'lutris', name: 'Lutris', hint: '', icon: '', cmd: 'flatpak',
        args: ['run', 'net.lutris.Lutris'], nativeCmd: 'lutris',
    }];
    const handlers = createLauncherManageHandlers(deps);
    const ret = handlers.addLauncher({ id: 'lutris', name: 'Lutris', cmd: 'lutris', args: [] });
    assert.equal(ret, undefined); // synchronous branch
    assert.deepEqual(deps.customLaunchers.map((l) => l.cmd), ['lutris']);
});

test('addLauncher — custom command: an existing binary is added, a nonexistent one rejected', async () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    await handlers.addLauncher({ id: 'custom-ff', name: 'FF', cmd: 'firefox', args: ['--kiosk'] });
    await handlers.addLauncher({ id: 'custom-game', name: 'Game', cmd: '/opt/game/run.sh', args: [] });
    await handlers.addLauncher({ id: 'custom-nope', name: 'Nope', cmd: 'missingilyen', args: [] });
    assert.deepEqual(deps.customLaunchers.map((l) => l.id), ['custom-ff', 'custom-game']);
    const errs = deps.sent.filter((s) => s.channel === 'app-error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].payload.errorKey, 'err.launcherNotFound');
});

test('addLauncher — shell/interpreter/wrapper as a custom command: rejects it, does not even call which', async () => {
    const deps = fakeDeps();
    let whichCalls = 0;
    deps.launchersLib.commandExists = async () => { whichCalls++; return true; };
    const handlers = createLauncherManageHandlers(deps);
    for (const cmd of ['bash', '/bin/sh', 'python3', 'python3.12', 'env', 'sudo', 'pkexec', 'perl', 'node', 'rm -rf', 'a;b']) {
        await handlers.addLauncher({ id: 'custom-x', name: 'X', cmd, args: ['-c', 'id'] });
    }
    assert.equal(deps.customLaunchers.length, 0);
    assert.equal(whichCalls, 0);
});

// The wizard sends the installed app's icon file (`iconFile`) → it goes into our own icon folder.
test('addLauncher — iconFile: imports from under the icon root (file:// URL), deletes it on removal', async () => {
    const { withTempHome, writeFile } = require('../helpers/fs.js');
    const fs = require('node:fs');
    const appIcons = require('../../lib/apps/app-icons.js');
    await withTempHome(async (home) => {
        const src = writeFile(home, '.local/share/icons/hicolor/256x256/apps/firefox.png', 'PNG');
        const deps = fakeDeps({ undoMs: 5 });
        const handlers = createLauncherManageHandlers(deps);
        await handlers.addLauncher({ id: 'custom-firefox', name: 'Firefox', cmd: 'firefox', args: [], iconFile: src });
        const icon = deps.customLaunchers[0].icon;
        assert.ok(appIcons.isUserIconUrl(icon), icon);
        const file = path.join(appIcons.userIconDir(home), 'custom-firefox.png');
        assert.equal(fs.readFileSync(file, 'utf8'), 'PNG');
        handlers.removeLauncher('custom-firefox');
        // During the undo window the icon still exists, it is deleted afterwards.
        assert.equal(fs.existsSync(file), true);
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(fs.existsSync(file), false);

        // file not under an icon root: the launcher is added, without an icon
        const secret = writeFile(home, 'secret.png', 'x');
        await handlers.addLauncher({ id: 'custom-firefox-2', name: 'Firefox', cmd: 'firefox', args: [], iconFile: secret });
        assert.equal(deps.customLaunchers.find((l) => l.id === 'custom-firefox-2').icon, '');
        // the nonexistent command is rejected — the imported icon does not stay either
        await handlers.addLauncher({ id: 'custom-nope', name: 'Nope', cmd: 'nope', args: [], iconFile: src });
        assert.equal(fs.existsSync(path.join(appIcons.userIconDir(home), 'custom-nope.png')), false);
    });
});

test('addLauncher — the icon field of the payload: only a built-in or own-icon-folder file:// URL', async () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    await handlers.addLauncher({ id: 'a', name: 'A', cmd: 'firefox', args: [], icon: 'file:///etc/passwd.png' });
    await handlers.addLauncher({ id: 'b', name: 'B', cmd: 'firefox', args: [], icon: 'assets/icons/steam.svg' });
    assert.deepEqual(deps.customLaunchers.map((l) => [l.id, l.icon]), [['a', ''], ['b', 'assets/icons/steam.svg']]);
});

test('removeLauncher — removes from customLaunchers + the order, reload + launchers-changed', () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher('steam');
    handlers.addLauncher('heroic');
    deps.launchersLib.writeLauncherOrder(['steam', 'heroic']);
    handlers.removeLauncher('steam');
    assert.deepEqual(deps.customLaunchers.map((l) => l.id), ['heroic']);
    assert.deepEqual(deps.launchersLib.readLauncherOrder(), ['heroic']);
});

// The path of the "△ UNDO" toast.
function withConfigStore(deps, initial = {}) {
    const store = { ...initial };
    deps.config = {
        get: (key, fallback) => (key in store ? store[key] : fallback),
        set: (key, value) => { store[key] = value; },
    };
    return store;
}

test('undoRemoveLauncher — restores the entry to its place in the order + its custom ROM source', () => {
    const deps = fakeDeps();
    const store = withConfigStore(deps, {
        customGameSources: [{ launcherId: 'heroic', dirs: ['/r'] }, { launcherId: 'x', dirs: ['/y'] }],
    });
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher('steam');
    handlers.addLauncher('heroic');
    deps.launchersLib.writeLauncherOrder(['heroic', 'steam']);
    handlers.removeLauncher('heroic');
    assert.deepEqual(deps.customLaunchers.map((l) => l.id), ['steam']);
    assert.deepEqual(store.customGameSources.map((s) => s.launcherId), ['x']);

    assert.equal(handlers.undoRemoveLauncher('heroic'), true);
    assert.deepEqual(deps.customLaunchers.map((l) => l.id).sort(), ['heroic', 'steam']);
    assert.deepEqual(deps.launchersLib.readLauncherOrder(), ['heroic', 'steam']);
    assert.deepEqual(store.customGameSources.map((s) => s.launcherId).sort(), ['heroic', 'x']);
    assert.equal(deps.sent.at(-1).channel, 'launchers-changed');
    // the second time there is nothing to undo
    assert.equal(handlers.undoRemoveLauncher('heroic'), false);
});

test('undoRemoveLauncher — only the most recently removed one, and only within the window', async () => {
    const deps = fakeDeps({ undoMs: 5 });
    withConfigStore(deps);
    const handlers = createLauncherManageHandlers(deps);
    handlers.addLauncher('steam');
    handlers.addLauncher('heroic');
    handlers.removeLauncher('steam');
    handlers.removeLauncher('heroic'); // steam's trash becomes final
    assert.equal(handlers.undoRemoveLauncher('steam'), false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(handlers.undoRemoveLauncher('heroic'), false);
    assert.deepEqual(deps.customLaunchers, []);
});

test('installFlatpak — unknown catalog entry / one without flathubId: immediate error', async () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    await handlers.installFlatpak({ id: 'steam' }); // the `steam` entry has no flathubId
    assert.equal(deps.sent.length, 1);
    assert.equal(deps.sent[0].channel, 'flatpak-install-done');
    assert.equal(deps.sent[0].payload.ok, false);
});

test('installFlatpak — success: remote-add + install, calls addLauncher, sends progress lines', async () => {
    const deps = fakeDeps();
    deps.flatpak.runFlatpak = async (args, onLine) => {
        if (args[0] === 'install' && onLine) {
            onLine('something 40% something');
            onLine('something 90% something');
        }
        return { code: 0, out: '' };
    };
    const handlers = createLauncherManageHandlers(deps);
    await handlers.installFlatpak({ id: 'heroic' });
    assert.deepEqual(deps.customLaunchers.map((l) => l.id), ['heroic']); // addLauncher ran
    const progress = deps.sent.filter((s) => s.channel === 'flatpak-install-progress').map((s) => s.payload.pct);
    assert.deepEqual(progress, [40, 90]);
    const done = deps.sent.find((s) => s.channel === 'flatpak-install-done');
    assert.equal(done.payload.ok, true);
});

test('installFlatpak — failed exit code: gives flatpakErrorLine as the error message', async () => {
    const deps = fakeDeps();
    deps.flatpak.runFlatpak = async () => ({ code: 1, out: 'error: nope' });
    deps.flatpak.flatpakErrorLine = () => 'error: nope';
    const handlers = createLauncherManageHandlers(deps);
    await handlers.installFlatpak({ id: 'heroic' });
    const done = deps.sent.find((s) => s.channel === 'flatpak-install-done');
    assert.equal(done.payload.ok, false);
    assert.equal(done.payload.error, 'error: nope');
    assert.equal(deps.customLaunchers.length, 0); // addLauncher did NOT run
});

test('installFlatpak — only one install runs at a time, the second immediately gets an "already running" error', async () => {
    const deps = fakeDeps();
    const handlers = createLauncherManageHandlers(deps);
    const first = handlers.installFlatpak({ id: 'heroic' }); // starts, not awaited
    await handlers.installFlatpak({ id: 'heroic' }); // sees it synchronously: flatpakInstallInFlight=true
    await first;
    const done = deps.sent.filter((s) => s.channel === 'flatpak-install-done');
    assert.ok(done.some((s) => s.payload.ok === false && /already running/.test(s.payload.error)));
    assert.ok(done.some((s) => s.payload.ok === true));
});
