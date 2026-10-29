// @ts-check
'use strict';

// Installing missing system commands from the launcher: looks up the distro package for the misses of `selftest.js` and installs it with
// PackageKit (`pkcon`), else `pkexec <package manager>`; the polkit agent asks for the password, the launcher never handles passwords.
// `PACKAGE_MAP` mirrors `pkg_for()` of `install.sh` (`test/contracts/host-packages-mirror.test.js` catches drift).
// Background: docs/dev/infrastructure.md#host-dependencies

const fs = require('node:fs');
const { execFileAsync, EXEC_TIMEOUT_MS } = require('../exec.js');
const { HOST_PACKAGE_INSTALL_TIMEOUT_MS } = require('../timings.js');
const selftest = require('./selftest.js');

/** @typedef {'fedora' | 'arch' | 'debian'} Distro */

/** @type {Record<Distro, Record<string, string>>} command → package(s), space-separated */
const PACKAGE_MAP = {
    fedora: {
        'kscreen-doctor': 'libkscreen',
        pactl: 'pulseaudio-utils',
        bluetoothctl: 'bluez',
        gdbus: 'glib2',
        ncat: 'nmap-ncat',
        flatpak: 'flatpak',
        git: 'git',
        zstd: 'zstd',
        'cec-ctl': 'v4l-utils',
    },
    arch: {
        'kscreen-doctor': 'libkscreen',
        pactl: 'libpulse',
        bluetoothctl: 'bluez-utils',
        gdbus: 'glib2',
        ncat: 'nmap',
        flatpak: 'flatpak',
        git: 'git',
        zstd: 'zstd',
        'cec-ctl': 'v4l-utils',
    },
    debian: {
        'kscreen-doctor': 'libkscreen-bin',
        pactl: 'pulseaudio-utils',
        bluetoothctl: 'bluez',
        gdbus: 'libglib2.0-bin',
        ncat: 'ncat',
        flatpak: 'flatpak',
        git: 'git',
        zstd: 'zstd',
        'cec-ctl': 'v4l-utils',
    },
};

// The distro family from the content of `/etc/os-release` (mirror of `distro_id()` in `install.sh`). Pure. Unknown → null.
/** @returns {Distro | null} */
function detectDistro(osReleaseText) {
    const fields = {};
    for (const line of String(osReleaseText || '').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) fields[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    const ids = ` ${fields.ID || ''} ${fields.ID_LIKE || ''} `;
    if (/ (fedora|rhel) /.test(ids)) return 'fedora';
    if (/ arch /.test(ids)) return 'arch';
    if (/ (debian|ubuntu) /.test(ids)) return 'debian';
    return null;
}

// The packages of the commands (unique, order-preserving) + the commands without a package. Pure.
function packagesFor(distro, commands) {
    const map = (distro && PACKAGE_MAP[distro]) || {};
    const packages = [];
    const unmapped = [];
    for (const cmd of commands) {
        const pkgs = map[cmd];
        if (!pkgs) { unmapped.push(cmd); continue; }
        for (const p of pkgs.split(' ')) if (!packages.includes(p)) packages.push(p);
    }
    return { packages, unmapped };
}

// The install command. `pkcon` (PackageKit, distro-independent, KDE Discover uses it too) first; `pkexec` + the distro's package manager
// as the fallback. Pure. Nothing available → null.
/** @returns {{ cmd: string, args: string[], installer: string } | null} */
function installCommand(distro, packages, { hasPkcon, hasPkexec }) {
    if (!packages.length) return null;
    if (hasPkcon) return { cmd: 'pkcon', args: ['-y', 'install', ...packages], installer: 'pkcon' };
    if (!hasPkexec) return null;
    if (distro === 'debian') return { cmd: 'pkexec', args: ['apt-get', 'install', '-y', ...packages], installer: 'apt-get' };
    if (distro === 'fedora') return { cmd: 'pkexec', args: ['dnf', 'install', '-y', ...packages], installer: 'dnf' };
    if (distro === 'arch') return { cmd: 'pkexec', args: ['pacman', '-S', '--needed', '--noconfirm', ...packages], installer: 'pacman' };
    return null;
}

async function hasCommand(cmd) {
    try {
        await execFileAsync('which', [cmd], { timeout: EXEC_TIMEOUT_MS });
        return true;
    } catch {
        return false;
    }
}

function readOsRelease(file = '/etc/os-release') {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

let inFlight = null;

/**
 * Installs the missing ones of `selftest.REQUIRED_COMMANDS`. Never throws.
 * `error`: `nothing-missing` / `unknown-distro` / `no-installer` / `install-failed`.
 * Success is measured by the fresh selftest (`missingAfter` empty) — the package manager's exit code is only logged, because `pkcon`
 * may return non-zero for "already installed" too.
 * @param {{ log?: (msg: string) => void, osReleasePath?: string }} [opts]
 */
function installMissingCommands(opts = {}) {
    if (!inFlight) {
        inFlight = runInstall(opts).finally(() => { inFlight = null; });
    }
    return inFlight;
}

/** @param {{ log?: (msg: string) => void, osReleasePath?: string }} [opts] */
async function runInstall({ log = () => {}, osReleasePath } = {}) {
    selftest.invalidate();
    const before = await selftest.checkCommands();
    const missing = before.filter((r) => !r.ok).map((r) => r.cmd);
    if (!missing.length) return { ok: true, error: 'nothing-missing', packages: [], unmapped: [], missingAfter: [], selftest: before };

    const distro = detectDistro(readOsRelease(osReleasePath));
    const { packages, unmapped } = packagesFor(distro, missing);
    const base = { packages, unmapped, missingAfter: missing, selftest: before };
    if (!distro || !packages.length) return { ok: false, error: 'unknown-distro', ...base };

    const [hasPkcon, hasPkexec] = await Promise.all([hasCommand('pkcon'), hasCommand('pkexec')]);
    const plan = installCommand(distro, packages, { hasPkcon, hasPkexec });
    if (!plan) return { ok: false, error: 'no-installer', ...base };

    log(`[host-packages] installing (${plan.installer}): ${packages.join(' ')}`);
    let failure = '';
    try {
        await execFileAsync(plan.cmd, plan.args, {
            timeout: HOST_PACKAGE_INSTALL_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, LC_ALL: 'C' },
        });
    } catch (err) {
        const tail = String((err && (err.stderr || err.stdout)) || '').trim().split('\n').slice(-3).join(' | ');
        failure = `${err && err.message ? err.message.split('\n')[0] : err}${tail ? ` — ${tail}` : ''}`;
        log(`[host-packages] ${plan.installer} error: ${failure}`);
    }

    selftest.invalidate();
    const after = await selftest.checkCommands();
    const missingAfter = after.filter((r) => !r.ok).map((r) => r.cmd);
    const ok = missingAfter.length === 0;
    log(`[host-packages] done — ${ok ? 'every command is present' : `still missing: ${missingAfter.join(', ')}`}`);
    return {
        ok,
        error: ok ? undefined : 'install-failed',
        installer: plan.installer,
        detail: failure || undefined,
        packages,
        unmapped,
        missingAfter,
        selftest: after,
    };
}

module.exports = { PACKAGE_MAP, detectDistro, packagesFor, installCommand, installMissingCommands };
