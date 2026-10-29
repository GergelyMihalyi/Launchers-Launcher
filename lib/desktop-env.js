// @ts-check
'use strict';

// Which desktop environment the launcher runs under; the DE-dependent host integrations (monitor switch, window activate/move,
// do-not-disturb, command self-test) pick their backend from it. From `XDG_CURRENT_DESKTOP` (colon-separated list), else
// `DESKTOP_SESSION`; override: `LAUNCHERS_LAUNCHER_DESKTOP=kde|gnome`. An env-based decision is fine here (≠ ozone: a wrong value only
// picks a wrong backend, not a SIGTRAP). `unknown` → the old KDE behavior. Background: docs/dev/platforms.md

/** @typedef {'kde' | 'gnome' | 'unknown'} DesktopEnv */

// GNOME Shell/Mutter-based environments (Budgie/Cinnamon do NOT expose the Mutter D-Bus API).
const GNOME_TOKENS = ['gnome', 'gnome-classic', 'gnome-flashback', 'ubuntu', 'pop', 'zorin', 'unity'];
const KDE_TOKENS = ['kde', 'plasma'];

/**
 * Pure: the DE from the env. `LAUNCHERS_LAUNCHER_DESKTOP` overrides.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DesktopEnv}
 */
function detectDesktopEnv(env = process.env) {
    const forced = String(env.LAUNCHERS_LAUNCHER_DESKTOP || '').trim().toLowerCase();
    if (forced === 'kde' || forced === 'gnome') return forced;
    const tokens = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase().split(':').map((t) => t.trim()).filter(Boolean);
    if (tokens.some((t) => KDE_TOKENS.includes(t))) return 'kde';
    // An `ubuntu`/`pop` token alone also means GNOME (`ubuntu:GNOME`), but a value like
    // `ubuntu:KDE` was already classified as KDE above.
    if (tokens.some((t) => GNOME_TOKENS.includes(t))) return 'gnome';
    const session = String(env.DESKTOP_SESSION || env.XDG_SESSION_DESKTOP || '').toLowerCase();
    if (/plasma|kde/.test(session)) return 'kde';
    if (/gnome|ubuntu/.test(session)) return 'gnome';
    return 'unknown';
}

/** @type {DesktopEnv|null} */
let cached = null;

/** The process's DE (computed once). @returns {DesktopEnv} */
function desktopEnv() {
    if (!cached) cached = detectDesktopEnv();
    return cached;
}

// Tests only.
function _resetDesktopEnv() { cached = null; }

module.exports = { detectDesktopEnv, desktopEnv, _resetDesktopEnv };
