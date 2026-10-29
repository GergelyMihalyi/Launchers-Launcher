# Changelog

Notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning aims for
[SemVer](https://semver.org/spec/v2.0.0.html) but the project has had no external
users, so pre-1.0.0 history lives only in git.

The running version is shown in **Settings → System → Diagnostics** and comes
from `package.json`.

## [1.1.0] - 2026-10-29

### Changed

- **English everywhere outside the UI tables:** the installer and its prompts, the log file (and the watcher / BT-trigger logs), error
  reasons, the user guide (with new English screenshots), the developer docs, the catalog hints and the theme names. The interface
  itself is still available in Hungarian and English. The log-line classifier keeps recognising the older Hungarian lines.
- Loading states now share one animation: the icons of your active launchers ripple
  in a row (launching a game, Settings and Games panel loads, updating, installing
  a Flatpak, Bluetooth scanning, and the startup skeleton). While launching, the
  icon of the launcher being started is highlighted. Replaces the fake progress
  bar and the grey placeholder rows; static under reduced motion.
- Empty lists across Settings, the Games panel and the setup wizard now share
  one look (`emptyState` helper) — a centred title plus an optional hint line.
- Carousel polish: cards settle with a slight spring, and the blurred card
  background lags behind for a bit of depth (both off under reduced motion).

### Fixed

- With the interface language set to English, the home cards could still show their labels (the "Games" card name, the
  favorite badge, the launch hint) in the default language, Hungarian: the cards were drawn before the language setting had arrived and were not redrawn. The language is now known before the
  first card render.
- On a PC without a Bluetooth adapter, `bluetoothctl` answers "No default controller available", which was read as a paired
  device called "default" (and queried with `bluetoothctl info default`). Only real `Device <MAC> …` lines count now.

### Added

- **Hands-off install:** `install.sh` now installs the missing distro packages
  after one question (`--yes` for none, `--no-packages` for the old list-only
  behaviour), and downloads the official Node.js into your home without `sudo`
  when the distro's is too old. New one-line bootstrap:
  `get-launchers-launcher.sh` (clone + install).
- **Install missing system commands from the launcher:** Settings → System →
  Diagnostics → *Install missing*, or □ on the setup wizard's last step
  (PackageKit / `pkexec`; the system asks for the password).
- **Refresh** button in the Games panel: press Start/Options to rescan every game
  source now (e.g. after copying new ROMs into a folder while playing), without
  restarting the launcher or waiting for the 10-minute cache to expire. Coming
  back from a game now only rescans that game's launcher plus Steam / Heroic /
  Lutris (where you might have installed something), instead of every source —
  so the first seconds after returning are smoother.
- The Games panel opens fast the first time: the launcher now scans your game
  folders (Steam, Heroic, Lutris, RetroArch and the emulators) in the background
  shortly after it starts, and again after you come back from a game. A small
  spinning launcher icon in the bottom-left corner shows while it works (only if
  it takes a moment; hidden while a panel is open). Scan results are now kept for
  10 minutes instead of 1.
- Live search in the Games panel: press Select/View to open a compact on-screen
  keyboard docked to the bottom; from 3 characters the list narrows as you type,
  within the active tab (Steam tab searches only Steam games; the ALL tab
  searches everything). On the RetroArch tab it searches every ROM of every
  system at once; inside a system it searches that system. Matching ignores
  case/accents and word order, and titles where the word *starts* with your
  text come first. Back clears the search before it closes the panel; a
  physical keyboard can type into the search too. On-screen keyboards also got
  Square = backspace and Triangle = space.
- In-app install for not-installed launchers: selecting one in **Settings →
  Launchers** offers a "Install" button that runs `flatpak install` from Flathub
  with a progress bar, then adds the launcher automatically.
- "＋ Flatpak app" in **Settings → Launchers** browses installed flatpak apps so
  you can add one as a launcher without typing a command.
- Flatpak Steam is supported: game discovery and launching find the flatpak
  install (`~/.var/app/com.valvesoftware.Steam`) when there's no native Steam.
- Launchers are no longer fixed: there are no built-in launcher cards. On first
  run the wizard's "Launchers" step lets you pick which launchers you want (the
  installed common ones — Steam / Heroic / RetroArch — are pre-selected), and
  every launcher can be removed in **Settings → Launchers**. Existing installs
  keep the three they had. A manually added flatpak launcher that matches the
  catalogue inherits its name / icon / colour.
- Desktop launcher icon: `./install.sh` now adds a "Launchers Launcher" entry to
  the KDE menu (`bin/launchers-launcher-show.sh` — starts the launcher if it isn't
  running, brings it to the front if it is).
- "What's new" panel after a self-update: on the next start the launcher shows
  the latest CHANGELOG section once, then clears the marker. Any button closes it.
- Launcher card quick actions: **hold** the confirm button on a launcher card
  to open a small menu — "Move to front", "Accent colour" (a fixed palette), and
  "Remove" (custom launchers only). A short press still launches. The chosen
  accent colour is stored per launcher (`launcherAccents` config key).
- Pin favourite games in the Games panel: press ▲ (the menu button) on any game
  cell or ROM to pin/unpin it; pinned games get a "★ Favourites" filter chip at
  the top so they're one press away. Works across Steam, Heroic and RetroArch
  (the pin key matches the recent-games format).
- Custom-command launchers — **Settings → Launchers → "＋ Custom command"**:
  type a name, a command (e.g. `firefox` or `flatpak`) and arguments on the
  on-screen keyboard, pick an icon from the bundled set, and it's added as a
  launcher card. First real use of the on-screen keyboard component.
- Global "▶ Continue" bar at the top of the home screen: the 3 most recently
  played games across **all** sources (Steam, Heroic, RetroArch) merged by last
  played time — not just the focused launcher's. Press ▲ from a card to enter it,
  ◀▶ to pick, the confirm button to launch. The per-launcher quick-launch bar
  below the cards stays as before.
- Playtime statistics — **Settings → System → Statistics** (read-only): total time
  and launch count per launcher and per identified game (Steam / Heroic titles
  resolved by name; RetroArch stays aggregated). The launch state machine now
  records each session's length into the `usage` config key (`totalMs` /
  `lastSessionMs`, additive and backward compatible). Steam time covers the whole
  Big Picture client session, not just the game.
- English UI language, selectable in **Settings → Appearance → Language** or the
  first-run wizard (which now has a Language step). The whole interface is
  translated — hint bar, Settings menu and all subviews, toasts, setup wizard,
  Games panel, carousel — and switches live without a restart.
- On-screen keyboard (controller-driven ABC grid) — the reusable text-input
  component; first user will be the Wi-Fi password prompt.
- Two-column Settings panel on wide (4K) screens: the menu stays visible on the
  left, the subview on the right. Can be turned off in **Settings → Feedback →
  Wide settings panel (4K)**.

## [1.0.0] - 2026-09-08

First release meant to be handed to someone else. Everything before this was
untracked — see `git log` for the full trail.

### Launcher

- Full-screen, controller-navigable carousel for Steam, Heroic (GOG / Epic /
  Amazon) and RetroArch, plus user-added launchers. Keyboard fallback for the
  main carousel.
- Game-level launching: browse installed Steam & Heroic titles and RetroArch ROM
  playlists — cover-art grid, source filter, page / letter jump — and launch a
  specific game.
- "Switch to running": a second launch of an already-running launcher raises its
  window instead of starting a new instance.
- Quick-launch bar with the last 3 games under the focused launcher card
  (Steam / RetroArch recents derived from each launcher's own last-played data).
- Usage badge on frequently-used cards; carousel opens focused on the most
  recently launched app.
- Idle screensaver — bouncing launcher icons + a drifting clock (OLED burn-in).
- Per-controller icon + battery chips on the main screen.
- 15 themes with live preview, reduced-motion and high-contrast options,
  synthesized navigation sound + controller rumble.

### TV mode

- On Bluetooth controller connect: close configured apps, start the launcher,
  switch monitor + audio output, and power the TV on over HDMI-CEC — the last
  only when the startup monitor *is* the TV.
- Circle-hold to exit: restores the desktop monitor layout + audio sink and
  disconnects gamepads.
- **Rootless trigger.** A `systemd --user` BlueZ D-Bus listener
  (`gdbus monitor`) replaces the old udev → root-script chain. No `/etc`, no
  `sudo`, no `/usr/local/bin` copy for the trigger; it runs straight from the
  repo, so `git pull` updates it. The old udev rule stays as a documented
  cold-boot fallback.

### Settings & first run

- All settings screens are controller-driven: startup output, themes, feedback,
  Bluetooth headset & controller pairing, main-controller filter, launcher
  order, per-launcher accent colour, diagnostics, log viewer.
- **First-run setup wizard** — startup monitor, audio sink, main controller,
  theme. Every step skippable; re-runnable from Settings → System →
  Reconfigure. The monitor choice is written but not applied mid-wizard, so a
  wrong pick can't black out first launch.

### Config & packaging

- Single `~/.config/launchers-launcher/config.json`. A file that exists but no
  longer parses is moved aside to `config.json.corrupt-<timestamp>` and the
  launcher starts clean.
- `tvMode` config key holds the TV-mode app-close list + pre-commands (was
  hardcoded in a shell script). `flatpak kill` only for apps `flatpak ps`
  confirms running; `pkill -x` (exact name) for native processes; no
  pattern-based `pkill -f`.
- Machine-specific audio-sink fallback removed from the exit path — it uses the
  saved `desktop.sink` or a prefix match derived from that name, never a
  hardcoded device.
- `install.sh` — prerequisite check with distro-aware package hints (never
  installs anything), `npm install`, optional systemd auto-start behind a
  confirmation. `--dry-run`, `--uninstall`, `--help`.
- `README.md`, MIT `LICENSE`, `package.json` `engines: node >=18`.

### Tested on

The author's hardware only: Fedora KDE Plasma on Wayland, AMD GPU, an LG TV over
HDMI-CEC, DualSense / DualShock / Xbox controllers. CEC behaviour in particular
is vendor-specific.

[Unreleased]: https://github.com/GergelyMihalyi/Launchers-Launcher/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/GergelyMihalyi/Launchers-Launcher/releases/tag/v1.1.0
