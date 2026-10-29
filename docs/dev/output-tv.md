# Displays, audio, TV (CEC) and TV mode

Code: `lib/output/*`, `lib/ipc/output-ipc.js`, `lib/ipc/tv-mode-ipc.js`, `lib/sidecars/tv-mode-enter.js`,
`bin/launchers-launcher-bt-trigger.sh`, `bin/tv-mode-enter.sh`. Config: the `display` and `tvMode`
keys ([config-keys.md](config-keys.md)).

## Contents

- [The TV-mode lifecycle](#the-tv-mode-lifecycle)
- [Monitor backends](#monitor-backends)
- [Audio](#audio)
- [CEC](#cec)
- [Leaving TV mode](#leaving-tv-mode)
- [Machine facts](#machine-facts)

## The TV-mode lifecycle

1. A Bluetooth controller connects → the root-free `systemd --user` unit
   (`launchers-launcher-bt-trigger.service`, `ExecStart` straight from the repo) sees
   `Connected: <true>` on `gdbus monitor --system --dest org.bluez`
   ([devices.md](devices.md#bluetooth)). A one-off startup sweep (`sweep_connected`) also walks
   `bluetoothctl devices Connected`, because a controller that auto-reconnects during boot, before
   login, produces no transition signal.
2. Guards, in order: automatic start enabled (`controllerAutostart` sidecar), 15 s per-MAC
   debounce, launcher not already running (`launchers-launcher.lock`), the device is a gamepad
   (`Icon: input-gaming`), and it is the main controller (sidecar MAC; empty = any).
3. `bin/tv-mode-enter.sh` closes the configured programs (from the `tvMode` sidecar) and sends
   `launch` to the watcher socket (`printf 'launch' | ncat --send-only -U <socket>`).
4. The launcher starts, **before creating its window** applies the startup monitor and sink
   (`applyStartupOutputs`, `lib/output/startup-outputs.js`) and — only when the startup monitor *is* the TV — powers the TV on over
   CEC (`maybePowerOnTv`). **Monitor/audio switching and CEC are done by the launcher itself; no
   `bin/` script does them any more.**
5. Leaving: hold ○ (default 5 s, `tvExitHold`) → `exit-tv-mode`.

`launchers-launcher-bt-trigger.sh` is a long-running `while true` watcher: **editing it does not
affect the running process** — restart it with
`systemctl --user restart launchers-launcher-bt-trigger.service`. `tv-mode-enter.sh` starts fresh on
every trigger, so an edit is live at the next one. The old udev → root chain was removed in
September 2026 (it needed root and a `sudo` call that silently failed from a user process).

## Monitor backends

`lib/output/displays.js` is DE-independent. A switch is a `LayoutPlan` `{ order, disable }`
(`order` enabled, first = primary; `disable` turned off; everything else untouched). The backend is
chosen with `lib/desktop-env.js`:

- **KDE** (`displays-kde.js`): `kscreen-doctor -j` → `parseMonitors`; `kscreenArgs(plan)` builds
  `output.<n>.enable` + `priority.<i>` / `output.<n>.disable`. `priority` is an **int, 1-based**
  (1 = primary), `0` for a disabled output (sorted last in snapshots).
- **GNOME** (`displays-gnome.js`): Mutter `org.gnome.Mutter.DisplayConfig` over
  **`busctl --user --json=short`** with **`LC_ALL=C`** (`strtod` in the Hungarian locale does not read
  `1.25`). The GVariant text is never parsed. Verified on GNOME Shell 48.7 (X11 session plus a
  headless virtual-monitor shell): the smallest x/y must be 0 ("positions are offset"), logical
  monitors must touch ("not adjacent"), scale must come from the mode's `supported_scales`, a disabled
  monitor has no `is-current` mode (use `is-preferred`), the serial does not change after apply,
  `layout-mode` 1 = logical (Wayland), 2 = physical (X11, `global-scale-required`).
  `applyLayout` uses **method 1 (temporary) on purpose**: the persistent method would raise GNOME
  Shell's own "Keep these display settings?" dialog, which a controller cannot answer — the
  launcher's own "Keep this display?" countdown covers it. Cost: after a hotplug Mutter may reload a
  stored layout. A stale serial gives `Access denied` → one retry. A freshly enabled monitor takes
  the preferred mode and scale; existing ones keep theirs; if nothing is disabled the existing layout
  stays and the new monitor goes to the right edge.
- Window moves between outputs: KDE via a KWin script (`lib/launch/window-to-output.js`); GNOME on
  X11 via Electron `setBounds` using the Mutter geometry mapped to an Electron display (the `label`
  is *not* the connector); GNOME on Wayland is skipped (accepted limit, see
  [platforms.md](platforms.md)).

Monitor switching is serialised; "Keep this display?" runs a main-side countdown
(`MONITOR_CONFIRM_MS`, 15 s) and restores the previous layout without confirmation (with a second
attempt after the TV's CEC wake-up). With `keepOthers` the window is moved as well.

## Audio

`lib/output/audio.js` — `pactl` sink handling. **The system locale may be Hungarian, so always run
`pactl` with `LC_ALL=C`** (otherwise field names are `Név:`/`Leírás:` and parsing silently yields an
empty list). The default sink is addressed as `@DEFAULT_SINK@`; volume is stored per sink by
PipeWire, so a different percentage after switching device is expected. `applyStartupSink` is a
logged no-op for a sink that is not present. `changeVolume(delta)` steps with the `volumeMax` ceiling
(`stepVolume`); the renderer supplies the step size in `delta`.

## CEC

`lib/output/cec.js`. Most desktop GPUs have **no HDMI-CEC**, so everything is behind
`cecAvailable()` (cached: a `/dev/cec*` node exists **and** `cec-ctl` is on `PATH`);
`get-tv-capabilities` → `{ cec, ddc }` (`ddc` is always false — DDC/CI is deferred). The user is in
the `video` group, so no sudo.

- **Power on:** `powerOnTv(target)` is **fallback-only**: first `cec-toolbox on` (present on the
  author's machine), otherwise raw `cec-ctl -s -t<target> --image-view-on`. `standbyTv` sends
  `--standby`.
- **Which connector is the TV:** `kscreen-doctor` gives **no** connector type (all outputs are `type: 14`, `model: null`, all `DP-*`), so a TV cannot be recognised from it; the
  `Adapter Name : <connector>` line of a bare `cec-ctl` says on which connector the CEC device — the TV — hangs, which makes the rule self-configuring and free of hard-coded names
  (the old `tv-mode` script woke the TV unconditionally, even when the user wanted the desktop monitor). The wake-up now happens ~2–4 s later (Electron boot) than the old udev script.
- **When** (`maybePowerOnTv`, at `whenReady` before the window and when the user picks the TV as
  the active monitor — fire-and-forget there, because `cec-ctl` can take up to 8 s): (1) no CEC →
  logged no-op; (2) `cecPowerOn === false` → skip; (3) `tvIsStartupMonitor` → power on at once;
  (4) otherwise the `Adapter Name : <connector>` line of a bare `cec-ctl` is compared with
  `display.monitor` — the adapter's connector is where the TV hangs — and only on equality the TV is
  woken (in desktop mode the startup monitor is the ultrawide, not the TV). Switching back to a
  desktop monitor does **not** send standby (intentional).
- **TV volume/mute:** `cec-ctl -s -t<target> --user-control-pressed ui-cmd=volume-up|volume-down|mute
  --user-control-released`; `mute` is a **toggle** on the TV. `--give-audio-status` is unreliable on a
  plain TV, so there is no numeric bar, only a toast. The `tv-volume` / `tv-mute` IPC handlers exist
  but **no UI calls them since the main-menu Square/L2/R2 binding was dropped**.
- **Standby on exit:** `display.standbyOnExit` → `standbyTv` after the cleanup (4 s, best effort).

## Leaving TV mode

`exit-tv-mode` (`lib/ipc/tv-mode-ipc.js`; the orchestration is `lib/output/tv-mode.js` — not to be confused with the *entry*
sidecar `lib/sidecars/tv-mode-enter.js`; there is no hard-wired sink/connector fallback) restores the desktop **directly from the main process**
(no sudo, no script — an earlier `sudo tv-mode-exit.sh` silently failed because a user process
cannot answer the password prompt). Three independent best-effort steps run with
`Promise.allSettled` + `withTimeout`; failures go to the log; finally `app.quit()` (injected as a
`quit()` callback, so the lib stays Electron-free):

- **Monitors** (`restoreMonitors`): from `display.desktop.monitors` only — connected outputs listed
  there get `enable` + `priority.<i+1>`; if none of the saved monitors is connected → no-op (the
  screen must not go dark); `disableOthers` (default true) disables connected outputs not in the list
  (typically the TV). **No hard-coded connector fallback**: no `desktop` profile → logged no-op.
- **Audio** (`restoreDesktopAudio`): from `desktop.sink` only; missing → logged no-op.
  `resolveDesktopSink` matches the exact sink name, or — when device numbering shifted because the
  TV connected meanwhile (`…extra2` → `…extra3`) — the saved name minus its trailing digits
  (≥ 12 chars, escaped regex; derived from the saved name, never machine-specific). The switch itself
  is `setAudioSink` (default sink + moving `sink-input`s).
- **Controllers** (`disconnectGamepads`): `bluetoothctl disconnect` for every connected `input-gaming`
  device; it cannot power a pad off over BT; USB pads are untouched.

**Desktop snapshot:** at *every* start `captureDesktopSnapshot()` (first thing in
`applyStartupOutputs`, before switching to the TV) overwrites `desktop` with the currently active
monitors (sorted by priority) and `pactl get-default-sink`, so exit always restores the state from
before *this* session (TV-mode entry is always a fresh process start). `sink` defaults to the
previously saved value (a transient `pactl` failure must not null it); `disableOthers` is inherited.
Two guards prevent a wrong overwrite: `desktop.pinned === true`, and "the only active monitor is
the saved TV monitor" (the launcher restarted while in TV mode — crash-restart / `second-instance`).
**Known, unfixed edge case:** with `keepOtherMonitors: true`, a crash-restart during TV mode with 2+
active monitors defeats the second guard (it only checks `active.length === 1`) and would record
the TV layout as the desktop one; `keepOtherMonitors` is not on on the author's machine.

## Machine facts

The author's desktop: DP-1 = 4K (priority 2), DP-3 = LG ultrawide 2560×1080 (priority 1),
DP-2 (priority 3). These are examples only — nothing is hard-coded; a `desktop` profile and the
connectors always come from the live machine.
