# Developer documentation

The distilled, topic-by-topic description of how Launchers Launcher works: what each part does, how it is built, what was verified on
a real machine, which gotchas bit us, and what is deliberately **not** done. It contains no plans, task lists or Q&A — only the lasting knowledge.

For the end-user guide see [../user-guide/README.md](../user-guide/README.md). The project rules (folder organisation, IPC,
testing) are in [architecture.md](architecture.md) and [testing.md](testing.md).

## Where to look

| I want to… | Read |
|---|---|
| understand the process/file layout, IPC rules, folder conventions | [architecture.md](architecture.md) |
| touch `lib/` infra: config store, exec/log, timeouts, paths, validation, sidecars, scans, safe mode, GPU | [infrastructure.md](infrastructure.md) |
| add or change a config key | [config-keys.md](config-keys.md) |
| change launching, window hiding, running detection, kill-watch, launch options | [launching.md](launching.md) |
| change the Games panel, recently played, favorites, covers, search | [games-panel.md](games-panel.md) |
| **add an emulator**, or change one | [launchers/README.md](launchers/README.md) + the emulator's file |
| change monitors, audio, CEC, TV mode | [output-tv.md](output-tv.md) |
| Bluetooth, controllers, Wi-Fi | [devices.md](devices.md) |
| KDE vs GNOME, Wayland vs X11, distros | [platforms.md](platforms.md) |
| install script, systemd units, `bin/` scripts, self-update | [install-update.md](install-update.md) |
| renderer rules (script order, overlays, i18n, loaders, accessibility) | [renderer/overview.md](renderer/overview.md) |
| the home screen: carousel, bars, card menu, screensaver | [renderer/home.md](renderer/home.md) |
| gamepad mapping, PS combos, edge-trigger gotchas, on-screen keyboard | [renderer/input.md](renderer/input.md) |
| Settings panel, setup wizard, directory browser | [renderer/settings.md](renderer/settings.md) |
| add or tweak a theme or background | [themes.md](themes.md) |
| run tests, e2e, offscreen layout debugging | [testing.md](testing.md) |
| find out why something was removed or rejected | [history.md](history.md) |
| see what is still open or waiting for a machine test | [open-items.md](open-items.md) |

## Pages

- [architecture.md](architecture.md) · [infrastructure.md](infrastructure.md) · [config-keys.md](config-keys.md)
- [launching.md](launching.md) · [games-panel.md](games-panel.md)
- [launchers/](launchers/README.md): [steam](launchers/steam.md) · [heroic](launchers/heroic.md) · [lutris](launchers/lutris.md) ·
  [retroarch](launchers/retroarch.md) · [ryujinx](launchers/ryujinx.md) · [cemu](launchers/cemu.md) · [rpcs3](launchers/rpcs3.md) ·
  [pcsx2](launchers/pcsx2.md) · [duckstation](launchers/duckstation.md) · [ppsspp](launchers/ppsspp.md) ·
  [dolphin](launchers/dolphin.md) · [melonds](launchers/melonds.md)
- [output-tv.md](output-tv.md) · [devices.md](devices.md) · [platforms.md](platforms.md) · [install-update.md](install-update.md)
- renderer: [overview](renderer/overview.md) · [home](renderer/home.md) · [input](renderer/input.md) · [settings](renderer/settings.md);
  [themes.md](themes.md)
- [testing.md](testing.md) · [history.md](history.md) · [open-items.md](open-items.md)

## Conventions for these pages

- English, one topic per page; a page states *what it does → how it works → verified facts and gotchas → known limits*.
- Code identifiers and paths are in backticks; **do not write counts that go stale** (file/test numbers) — write rules.
- Mark what is **verified on a machine** and what is **not** (a flag derived from `--help`, a layout never tried live).
- A new lasting fact goes into the page of its topic; a decision that was rejected goes into [history.md](history.md); an
  unfinished item goes into [open-items.md](open-items.md). There is no per-feature plan file any more.
