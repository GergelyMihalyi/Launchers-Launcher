'use strict';

// lib/ozone-platform.js — the Wayland/X11 platform choice.
// The decision depends on whether the Wayland SOCKET exists, not on the session env variables.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickOzonePlatform, waylandSocketPath } = require('../lib/ozone-platform.js');

const RUN = '/run/user/1001';

// [name, env, existing paths, contents of /tmp/.X11-unix, expected platform, expected display]
const CASES = [
    ['Wayland socket (wayland-0), no env — the empty env of the watcher', { XDG_RUNTIME_DIR: RUN }, [`${RUN}/wayland-0`], [], 'wayland', undefined],
    ['Wayland socket by the name in WAYLAND_DISPLAY', { XDG_RUNTIME_DIR: RUN, WAYLAND_DISPLAY: 'wayland-1' }, [`${RUN}/wayland-1`], [], 'wayland', undefined],
    ['absolute WAYLAND_DISPLAY', { WAYLAND_DISPLAY: '/tmp/wl' }, ['/tmp/wl'], [], 'wayland', undefined],
    ['stale XDG_SESSION_TYPE=x11, but there is a Wayland socket → wayland', { XDG_RUNTIME_DIR: RUN, XDG_SESSION_TYPE: 'x11' }, [`${RUN}/wayland-0`], [], 'wayland', undefined],
    ['GNOME on Xorg: no socket, DISPLAY=:2', { XDG_RUNTIME_DIR: RUN, DISPLAY: ':2' }, [], ['X2'], 'x11', undefined],
    ['no socket, no DISPLAY, but an X socket → DISPLAY filled in', { XDG_RUNTIME_DIR: RUN }, [], ['X1', 'X0'], 'x11', ':0'],
    ['nothing → wayland (the old default)', { XDG_RUNTIME_DIR: RUN }, [], ['README'], 'wayland', undefined],
    ['manual override x11 (even with a Wayland socket)', { XDG_RUNTIME_DIR: RUN, LAUNCHERS_LAUNCHER_OZONE: 'X11' }, [`${RUN}/wayland-0`], [], 'x11', undefined],
    ['manual override wayland', { XDG_RUNTIME_DIR: RUN, DISPLAY: ':0', LAUNCHERS_LAUNCHER_OZONE: 'wayland' }, [], [], 'wayland', undefined],
    ['unknown override → ignored', { XDG_RUNTIME_DIR: RUN, DISPLAY: ':0', LAUNCHERS_LAUNCHER_OZONE: 'foo' }, [], [], 'x11', undefined],
];

for (const [name, env, paths, xDir, platform, display] of CASES) {
    test(`pickOzonePlatform — ${name}`, () => {
        const res = pickOzonePlatform({
            env,
            exists: (p) => paths.includes(p),
            listDir: (d) => (d === '/tmp/.X11-unix' ? xDir : []),
        });
        assert.equal(res.platform, platform);
        assert.equal(res.display, display);
        assert.ok(res.reason);
    });
}

test('waylandSocketPath — runtime dir + name / absolute / default', () => {
    assert.equal(waylandSocketPath({ XDG_RUNTIME_DIR: RUN }), `${RUN}/wayland-0`);
    assert.equal(waylandSocketPath({ XDG_RUNTIME_DIR: RUN, WAYLAND_DISPLAY: 'wayland-3' }), `${RUN}/wayland-3`);
    assert.equal(waylandSocketPath({ WAYLAND_DISPLAY: '/x/y' }), '/x/y');
    assert.equal(waylandSocketPath({}), `/run/user/${process.getuid()}/wayland-0`);
});
