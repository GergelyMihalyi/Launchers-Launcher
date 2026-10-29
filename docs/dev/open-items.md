# Open items

The single live list of what is deferred, undecided or waiting for a machine test. **Finished work and rejected ideas do
not belong here** — finished work lives in the topic pages, rejected ideas in [history.md](history.md#deliberately-rejected-do-not-re-add).
Last reconciled: 2026-10-06.

## Contents

- [Waiting for a machine test](#waiting-for-a-machine-test)
- [Deferred features](#deferred-features)
- [Decisions still open](#decisions-still-open)
- [Known, accepted limits](#known-accepted-limits)

## Waiting for a machine test

Everything below is **implemented and passes `npm test`**; the agent sandbox has no GUI/hardware
(`ELECTRON_RUN_AS_NODE=1` runs `npm start` headless), so a person has to try it from a normal terminal.
The 2026-10-29 manual round (Debian 13 GNOME/X11, Fedora 44 KDE/Wayland, Nobara 44 KDE) found no errors and cleared every other row.

| Area | What to try |
|---|---|
| **Fresh install** | `get-launchers-launcher.sh` (the `curl … \| bash` one-liner) on a fresh machine / VM once the public repo is public, without the private-repo `LAUNCHERS_LAUNCHER_REPO=git@…` workaround |
| **GNOME with a TV** | after CEC power-on's hotplug, Mutter must not restore the stored desktop layout; the same on GNOME **Wayland** (no window move there) |

## Deferred features

Deferred by user decision or because they need hardware/machine measurement. None has code.

- **Kill-watch for more emulators** (PS force-closes the running emulator; today only melonDS). The `launch` descriptor's
  `killable` could come from the catalog/`customLaunchers` (`"killable": true`), and for `meta`-less flatpak emulators
  `spawnGame` could build the kill target from `flatpakRunAppId`. Needs a per-emulator machine trial: PS → `flatpak kill`
  → the launcher returns; and because the window must **not** hide during a killable session, check that the game's
  fullscreen lands above and there is no flicker. `killRequested` is already generic.
- **Hidden launcher window already during the output switch** (the window created `show: false` during
  `applyStartupOutputs` and shown after): would overlap the `outputsApplied` stage (250–500 ms on the T410) with the
  renderer's ~1.7 s load. Risk: the 2026-09-24 "no picture" startup race with a visible, just-opening window — **provable only
  on the author's KDE 2-monitor PC**.
- **Hardware brightness (DDC/CI via `ddcutil`)**: the software dim + night mode exist; DDC does not answer reliably on the
  author's monitors under Wayland. If `ddcutil detect` sees a monitor, an isolated optional code branch.
- **General controller B/C/D**: the Nintendo physical A/B swap, a remap sub-view, a non-standard-mapping fallback +
  "press the confirm button" calibration — all need a real Switch Pro / 8BitDo / generic pad. Today `classifyController`
  never returns `nintendo` and the confirm/back branch is fixed at `buttons[0]`/`[1]`.
  Design notes for when a Nintendo pad is at hand: `classifyController` would gain `nintendo` (vendor `057e`, or a `pad.id` containing `pro controller` /
  `8bitdo` / `switch` / `joycon`); the confirm/back branch of `pollGamepad` would go through a `resolveNavButton(gp, 'confirm'|'back')` layer (playstation/xbox/generic:
  `buttons[0]`/`[1]`; nintendo: the *measured* mapping, expected swapped but unverified — Chromium's standard mapping on those pads often puts the physical B on
  `buttons[0]`); only the confirm/back/menu branches are affected, not the volume buttons. A pad whose `pad.mapping === ""` (old/cheap) has an unpredictable `buttons[]`
  order and today is practically unusable; a "press the button you want as *confirm*" calibration plus a global `controllerMap` would address that.
  Also unverified: that Start really reads `buttons[9]` on every pad (confirmed by the W3C mapping on a DualSense, not measured on PS5/Xbox/generic).
- **Games-panel search v2:** hit counts on the source chips and dimming of zero-hit chips.
- **Phone / web remote** (text entry + D-pad → state/QR/PWA → launch from the list; three rounds planned). First step: a
  10-minute trial of **KDE Connect's** remote keyboard under Wayland — if it types into the launcher, the "text into search"
  need is solved with no code. Principles if built: off by default, PIN/token pairing, LAN-only bind, whitelisted actions, typed
  text never logged. Open questions: pairing (PIN/QR), port, first-round content, `firewalld`.
- **Long-term ideas**: new sources (Xemu, Vita3K — `param-sfo.js` is ready —, mGBA, itch.io [SQLite → needs a CLI read, the
  zero-SQLite rule], Bottles `bottles-cli list programs`, non-Steam shortcuts [the CRC32-based appid needs measuring]),
  RetroAchievements summary (a read integration with an API key; a new network dependency → a `coverDownload`-like switch),
  a second-monitor info window (a second `BrowserWindow`: clock, now playing, playtime, battery; `keepOtherMonitors` exists).
  A new source follows [launchers/README.md](launchers/README.md#adding-an-emulator).
- **Home grid view as an alternative to the carousel**: `layoutCarousel` / `renderRecentBar` / idle-attract all assume the
  carousel; a grid is parallel code, worth it only at N ≥ ~8 launchers.
- **Steam launch v2**: `steam -silent`, the launcher stays in front until the *game's* window appears, a "game running" watcher
  from `~/.steam/registry.vdf` `RunningAppID` (must be measured under Proton first), an optional `steam -shutdown` after
  the game (could interrupt a downloading second game). Only if today's Big Picture transition proves annoying.
- **CI + a "stable" update channel**: GitHub Actions (`npm ci` → test → typecheck → e2e; value = a clean clone catches a
  forgotten `git add`; costs: Ubuntu runner needs skips for machine-dependent tests and Electron libs for e2e; ~3 min per
  run on a private repo) and a `stable` branch for self-update (clone `--branch stable`, promote with `git push origin
  main:stable`; guards against functional errors that rollback does not catch). Wanted once the repo is public / runs on a
  second machine.
- **Release / distribution**: the first public release is `v1.1.0` (`CHANGELOG.md` `[1.1.0] - 2026-10-29`, `package.json` 1.1.0;
  there is no separate `v1.0.0` tag — the public repo gets one squash commit per release, `tools/publish-public.sh <version>`).
  The public repo exists but stays private until the first install test. **While a release is being prepared the topmost
  CHANGELOG section must be a non-empty one** (the "What's new" panel shows the first `##` section): add `## [Unreleased]` only
  together with its first item. An **AppImage**
  (`electron-builder`) conflicts with the "git clone + self-update + repo-run BT trigger and watcher" model (read-only squashfs,
  moving mount path); `install.sh` is the real path.
- **Heroic-GUI-launched games in the quick bar**: Heroic keeps no easily readable "last played" file (playtime is in an
  Electron leveldb); Heroic stays stored-recent (only games started from our panel). Accepted.
- **Custom (hand-added) launchers have no game-level launch** except through a custom ROM source ([launchers/README.md](launchers/README.md#custom-rom-folders)).
- **Automatic launcher reordering by usage**: rejected — see history; the manual pin covers it.

## Decisions still open

None are blocking. The most recent decisions are recorded where the feature lives (e.g. flatpak ROM access = "show, then
grant on confirmation" → [launchers/README.md](launchers/README.md#flatpak-access-to-rom-folders)).

## Known, accepted limits

- Window activation/moving on GNOME (see [platforms.md](platforms.md)); WPA-Enterprise Wi-Fi; PIN-based Bluetooth pairing.
- With `keepOtherMonitors: true`, a crash-restart during TV mode with 2+ active monitors may record the TV layout as the
  desktop snapshot ([output-tv.md](output-tv.md#leaving-tv-mode)).
- Steam's "Exit Big Picture" leaves `steam.pid` alive, so the launcher returns only when Steam is fully closed.
- Non-ISO PS2 images, `.rvz`/`.wia`/`.gcz`, `.pbp` homebrew: file-name titles only, no serial/cover.
- A half-finished `npm install` during a self-update can leave `node_modules` uncertain until the next start.
- Offline metadata for GOG/Nile, Steam descriptions/genres, screenshots and RetroArch `.rdb` is not available.
- The fixed Look → Background scrim is tuned for dark themes.
