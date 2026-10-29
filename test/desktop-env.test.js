'use strict';

// lib/desktop-env.js — DE detection (pure, with a mock env).

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectDesktopEnv } = require('../lib/desktop-env.js');

test('detectDesktopEnv — KDE variants', () => {
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'KDE' }), 'kde');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'ubuntu:KDE' }), 'kde');
    assert.equal(detectDesktopEnv({ DESKTOP_SESSION: 'plasma' }), 'kde');
    assert.equal(detectDesktopEnv({ DESKTOP_SESSION: 'plasmawayland' }), 'kde');
});

test('detectDesktopEnv — GNOME variants (on the T410: XDG_CURRENT_DESKTOP=GNOME)', () => {
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'GNOME' }), 'gnome');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), 'gnome');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'pop:GNOME' }), 'gnome');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'GNOME-Classic:GNOME' }), 'gnome');
    assert.equal(detectDesktopEnv({ DESKTOP_SESSION: 'gnome-xorg' }), 'gnome');
});

test('detectDesktopEnv — unknown / empty env', () => {
    assert.equal(detectDesktopEnv({}), 'unknown');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'XFCE' }), 'unknown');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }), 'unknown');
});

test('detectDesktopEnv — LAUNCHERS_LAUNCHER_DESKTOP overrides', () => {
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'KDE', LAUNCHERS_LAUNCHER_DESKTOP: 'gnome' }), 'gnome');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'GNOME', LAUNCHERS_LAUNCHER_DESKTOP: 'KDE' }), 'kde');
    assert.equal(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'GNOME', LAUNCHERS_LAUNCHER_DESKTOP: 'something' }), 'gnome');
});
