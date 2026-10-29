# Platforms: KDE, GNOME, X11, Wayland, distros

The project started as a single-machine kiosk (KDE Plasma on Wayland) and now supports GNOME as well. The selection
mechanism is in [infrastructure.md](infrastructure.md#environment-detection) (`desktopEnv()`, `pickOzonePlatform()`);
this page records what differs per platform and what has been verified where.

## What depends on the desktop environment

| Feature | KDE (and `unknown`) | GNOME |
|---|---|---|
| Monitor switching | `kscreen-doctor` (`displays-kde.js`) | Mutter `DisplayConfig` via `busctl` (`displays-gnome.js`), **temporary** apply |
| Activating a foreign window (switch to a running launcher / resume) | KWin `WindowsRunner` over `gdbus` | **not possible** (no public API) — falls back to a normal launch; single-instance apps (Steam, Heroic, Lutris) raise themselves |
| Moving the launcher window to an output | KWin script | X11: Electron `setBounds` with the Mutter geometry; **Wayland: skipped** (no client positioning) |
| Do not disturb | `kde-inhibit --notifications` | `show-banners` gsetting (+ marker file and startup `recover()`) |
| Self-test required commands | + `kscreen-doctor` | no `kscreen-doctor` (`busctl` is part of systemd) |

`unknown` takes the KDE path. Logged as `[desktop] <de> (XDG_CURRENT_DESKTOP=…)`; shown in Diagnostics → Desktop environment.
`install.sh` `is_gnome()` also skips `kscreen-doctor`.

**Details worth remembering:**
- `systemd-inhibit` is **not** a Do-not-disturb alternative: it blocks sleep/idle only, not notifications (the original
  GNOME plan assumed it and was corrected).
- GNOME's persistent apply (method 2) would raise GNOME Shell's own "Keep these display settings?" dialog, which a
  controller cannot answer (reported live on the T410, 2026-09-26); the temporary apply (method 1) is therefore used and the
  launcher's own "Keep this display?" covers the confirmation. **The price:** after a hotplug (e.g. the TV woken over CEC)
  Mutter may reload the layout *stored* in `~/.config/monitors.xml` — to be tried on GNOME with a TV.
- A GNOME Shell extension would be a possible extension later but needs an install step and may break per Shell version —
  not built.
- On GNOME/X11 the Electron `label` of a display is **not** the connector name (on the T410 "Built-in display" / "VP201b"),
  but `bounds` equals the Mutter logical position exactly (measured), so the move maps by geometry
  (`pickDisplayForGeometry`). The move: leave fullscreen (waits for `leave-full-screen`) → `setBounds` → fullscreen again;
  it waits for a just-enabled monitor to appear in Electron.

## Wayland vs X11 (ozone)

The Wayland **socket's existence** decides (`$WAYLAND_DISPLAY`, else `$XDG_RUNTIME_DIR/wayland-0`), then `DISPLAY` /
`/tmp/.X11-unix/X*` → `x11` (and it fills a missing `DISPLAY`), nothing → `wayland`; `LAUNCHERS_LAUNCHER_OZONE=wayland|x11`
overrides. **Never decide from `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`, never hard-code `--ozone-platform` in `package.json`**
(on an X11 machine, e.g. GNOME on Xorg, that is an immediate SIGTRAP; `test/contracts/window-hardening.test.js` guards it).
**Chromium picks the ozone platform before any JS runs**, so a `main.js` `appendSwitch('ozone-platform')` is too late (a
watcher start with no environment chose x11 → `Missing X server or $DISPLAY` → SIGTRAP, 2026-09-29): `npm start` is
`node bin/start.js`, which passes the decision as a CLI switch. Log: `[ozone] <platform> — <reason>`; Diagnostics → Graphical
platform. The 11 September SIGSEGV was caused by the missing `ozone-platform=wayland`, not by the GPU.

## Distros

- `install.sh` / `host-packages.js` package maps cover Debian (apt), Fedora (dnf; **Nobara** reports `ID=nobara` with
  `ID_LIKE` containing `fedora`, which `distro_id()` maps to `fedora`), Arch (pacman). The Debian 13 packaged Node is 20.x,
  below `engines.node`, so the installer fetches an official Node into `~/.local/share/launchers-launcher/node` (no sudo).
  `LAUNCHERS_LAUNCHER_OS_RELEASE` overrides the os-release for tests.
- Fedora: flathub is often only a **system** remote, so in-app `flatpak install --user` first runs
  `flatpak remote-add --user --if-not-exists flathub …`.
- Debian: NTFS/FAT mount options and the `libfuse2` requirement for AppImages are machine setup, not launcher code.
- A GPU on old Intel hardware (ThinkPad T410, OpenGL 2.1) triggers the automatic GPU fallback
  ([infrastructure.md](infrastructure.md#stability-safe-mode-fatal-errors-gpu-fallback)).

## Verified where (as of the last record)

- **KDE / Wayland (author's desktop):** the full path, including KWin scripts (6.7.5), CEC, TV mode, the BT trigger.
- **GNOME 48 / X11 (T410, Debian 13)**, one then two monitors: startup monitor switching to VGA-1 and back with "Keep
  this display?" confirmation; `keepOtherMonitors: true` (GNOME's dialog does not appear; the launcher window moves to the
  chosen monitor); expiry of the countdown restores the old layout; TV-mode exit restores the desktop layout; the flatpak
  Steam shown as running after the `flatpak ps` fix. Multi-monitor logic was also exercised against a **headless GNOME Shell on
  a private D-Bus** (`dbus-run-session -- env XDG_RUNTIME_DIR=/tmp/gsrt gnome-shell --headless --wayland --no-x11
  --virtual-monitor 1920x1080 --virtual-monitor 1280x720`; a short runtime dir is needed because the Wayland socket path
  is limited to 108 bytes; `dbus-launch` is absent — without it the commands would hit the real session bus).
- **Not yet verified:** GNOME on **Wayland** (switching, expiry restore, TV-mode exit, Do not disturb, raising a running
  launcher), GNOME with a real TV (hotplug behaviour of the temporary apply), the KDE `kscreen-doctor` host-output sample, the
  `get-launchers-launcher.sh` one-liner (the GitHub repo is private as of 2026-09-25), and a hands-off install.
  The open checks are tracked in [open-items.md](open-items.md).
