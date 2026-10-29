# systemd/ — user units for the launcher's start-up chain

**These files do not run from the repo automatically.** Same pattern as the `bin/*.sh` scripts (see
[docs/dev/install-update.md](../docs/dev/install-update.md#bin-scripts-and-where-they-run-from)): the repo is the versioned
source, but on the machine the copy under `~/.config/systemd/user/` runs, which the user syncs and activates by hand
(`./install.sh` does it for you after a confirmation).

## What starts the launcher

The launcher is started by a socket watcher: `bin/launchers-launcher-watcher.sh` listens in an endless loop on
`ncat -l -U .../launchers-launcher.sock` and, on a `"launch"` message (sent by `bin/tv-mode-enter.sh` when a controller
connects / TV mode is entered), starts the launcher with `npm start`. The lifecycle of the **watcher** itself is supervised by
this systemd user unit (`Restart=always`) — if the `ncat`/bash process dies, systemd restarts it a few seconds later and the
socket is alive again.

## The two user units

| Unit | Role | ExecStart |
| --- | --- | --- |
| `launchers-launcher-watcher.service` | the socket watcher (launcher lifecycle, crash restart) | `/usr/local/bin/launchers-launcher-watcher.sh` (copied by hand) |
| `launchers-launcher-bt-trigger.service` | the **root-free** Bluetooth-controller trigger (BlueZ D-Bus listener) | `%h/launchers-launcher/bin/launchers-launcher-bt-trigger.sh` (**straight from the repo**) |

The `bt-trigger` replaced an older udev → root chain (`99-dualsense-tv-mode.rules` + `dualsense-tv-mode.sh`). It needs no `/etc`
write, no `sudo` and no `/usr/local/bin` copy: the `systemd --user` unit runs the script straight from the repo (so a `git pull`
needs no separate copy; only the `.service` file is manual). The start-up `sweep_connected` round also covers a cold boot (a
controller that was connected before the login).

**⚠️ Important: a `git pull` / an edit alone is NOT enough for a live update.** `launchers-launcher-bt-trigger.sh` is a long-running
`while true` listener — systemd starts it once and the process may then run for days, and a change to the file does not reach the
already-running bash process. After any change, always:

```bash
systemctl --user restart launchers-launcher-bt-trigger.service
```

Without it the old logic keeps running (this caused a real bug: the `controllerAutostart` guard was in the repo, but the already
running listener kept the old code, so the launcher started even though the setting was off).

### Installing `launchers-launcher-bt-trigger.service` (no root)

```bash
cp ~/launchers-launcher/systemd/launchers-launcher-bt-trigger.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now launchers-launcher-bt-trigger.service
systemctl --user status launchers-launcher-bt-trigger          # active (running)
tail -f ~/.local/share/launchers-launcher-bt-trigger.log       # log of the listener + tv-mode-enter
```

Check: connect and disconnect a controller → the log shows `<MAC> → TV-mode entry`. A cold boot (a trigger before the login)
needs `loginctl enable-linger $USER` — not with kiosk autologin.

### The old udev chain

If you are updating an old installation, the "Manual (sudo) cleanup" block of `install.sh --uninstall` prints the `sudo rm`
commands that remove the old root chain (`99-dualsense-tv-mode.rules`, `dualsense-tv-mode.sh`, `tv-mode-exit.sh`) and reload udev.

**Crash restart of the launcher itself:** handled by the watcher script (not by systemd) — if the launcher exits with a non-zero
code (a crash), the watcher restarts it immediately, without waiting for a socket message, at most `CRASH_MAX` (5) times within a
`CRASH_WINDOW` (60 s) window. After a clean exit (PS button / TV-mode exit → `app.quit()`, exit code 0) it goes back to normal
socket waiting.

## Installation (on the machine, by hand)

```bash
# 1. the watcher script into /usr/local/bin/ (the pattern of the bin/ gotcha)
sudo cp ~/launchers-launcher/bin/launchers-launcher-watcher.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/launchers-launcher-watcher.sh

# 2. the user unit into ~/.config/systemd/user/
mkdir -p ~/.config/systemd/user
cp ~/launchers-launcher/systemd/launchers-launcher-watcher.service ~/.config/systemd/user/

# 3. activate
systemctl --user daemon-reload
systemctl --user enable --now launchers-launcher-watcher.service
```

## Checking

```bash
systemctl --user status launchers-launcher-watcher     # active (running), no restart loop
journalctl --user -u launchers-launcher-watcher -f     # at start-up / on a crash restart
pkill -f launchers-launcher-watcher.sh                 # comes back by itself after RestartSec
tail -f ~/.local/share/launchers-launcher-watcher.log  # the script's own log (launch / crash)
```

After that the physical trigger (DualSense connect / TV mode) starts the launcher through the socket as before.

## Updating

If `bin/launchers-launcher-watcher.sh` or this unit changes in the repo, repeat the copy steps above, then:

```bash
systemctl --user daemon-reload
systemctl --user restart launchers-launcher-watcher.service
```
