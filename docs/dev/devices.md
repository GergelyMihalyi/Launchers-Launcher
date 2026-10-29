# Devices: Bluetooth, controllers, Wi-Fi

## Contents

- [Bluetooth](#bluetooth)
- [Controller identification and battery](#controller-identification-and-battery)
- [Which pad pressed the PS combo (evdev)](#which-pad-pressed-the-ps-combo-evdev)
- [Wi-Fi (`nmcli`)](#wi-fi-nmcli)

## Bluetooth

Headsets and controllers share one mechanism keyed by `kind` (`headset` → `Icon: audio-headset`,
`controller` → `input-gaming`). `lib/bluetooth/bluetooth.js` returns the fresh device list as a
payload (it does not know about IPC); the IPC layer pushes `bt-device-changed`
(`{ kind, success, action, mac, name, devices }`, `action` ∈ `connect`/`disconnect`/`pair`). The UI
renders from the returned list, not from the `success` flag.

Verified behaviour of `bluetoothctl` (all without sudo, as the normal user):

- `bluetoothctl devices Paired` lists *every* paired device (keyboards, TVs too). **Filter on the
  `Icon:` field of `bluetoothctl info`** — not on `Class:` and not on the name.
- Call `bluetoothctl connect <mac>` as a plain argument (a single command that returns on its own:
  ~1 s on success, ~5 s `br-connection-page-timeout` failure if the device is off). **Never**
  `bluetoothctl --timeout N connect …` (an interactive session that always runs the full N seconds).
  A rarer stuck case (`br-connection-busy`) can hang longer, hence the 12 s `execFile` timeout.
  A powered-off Xbox pad returns quickly with exit 0 while staying `connected: no`.
- Pairing from the UI: `discoverDevices` = `bluetoothctl --timeout 10 scan on` (exits by itself) →
  `devices` → an `info` batch → `isDiscoverCandidate` (`Paired: no` + the kind's `Icon:`);
  `performBtPair` = `pair` → `trust` → `connect`. It is a Just-Works agent — **devices that need a
  PIN fail.**
- The `Battery Percentage:` line has the form `0xNN (NN)` and is parsed with `/Battery Percentage:\s*0x[0-9a-f]+\s*\((\d+)\)/i`; no match → no indicator.
- Listing is cheap (two headsets in parallel < 100 ms), so refresh on every panel open; no cache.
- The BT trigger parses `gdbus monitor --system --dest org.bluez`: `lib/bluetooth/bt-trigger-parse.js`
  `parseConnectEvent(line)` accepts only a `PropertiesChanged` `{'Connected': <true>}` on
  `org.bluez.Device1`. The `matches_connect()` glob in `bin/launchers-launcher-bt-trigger.sh` is its
  bash mirror (the trigger must not depend on `node`); the sample lines are real captures.

## Controller identification and battery

- Type detection is shared between main and renderer in `controller-id.js` (`classifyController`:
  Sony `v054C` → `p0CE6` DualSense else DualShock; Microsoft `v045E` → Xbox; then name fallback).
  Never re-implement the vendor/product logic. Button glyph sets come from `CONTROLLER_SYMBOLS` /
  `controllerSymbols(type)` (Sony and unknown → `playstation`; `nintendo` is a placeholder that
  `classifyController` does not yet return — the A/B swap must be measured on a real pad).
- Battery: `Battery Percentage:` in `bluetoothctl info` exists only for connected devices with a GATT
  Battery Service — the **Xbox** pad has it, the **DualSense over BT does not**. The DualSense battery
  comes from the `hid-playstation` driver via **UPower** (`ps-controller-battery-<mac>`), so
  `listBluetoothDevices('controller')` fills the gap from one `upower -d` dump (`parseUpowerBattery`,
  matching the normalised MAC on the `serial:` line). Neither → no indicator.
- A USB-cabled pad is invisible to `bluetoothctl` but present in the renderer's Gamepad API; the
  Controllers sub-view shows the surplus (`gamepads − connected BT devices`) as a read-only block,
  because a pad without a MAC cannot be matched exactly.

## Which pad pressed the PS combo (evdev)

The Gamepad API gives no MAC, but the kernel puts the BT MAC into the input device's sysfs `uniq`
field (`hid-playstation` / `xpad`), and logind's `uaccess` ACL makes `/dev/input/eventN` readable by
the user (the `/sys/class/leds/*` lightbar is root-only). `lib/evdev-pads.js`:

- `listGamepadInputs()` keeps devices with `BTN_GAMEPAD` + `BTN_MODE` (drops the DualSense motion
  sensors / touchpad sub-devices); `pickComboPad` = PS pressed now + any face button (0x130–0x134)
  within 600 ms on exactly one device (the position ↔ code mapping differs by driver, hence no
  specific button).
- **Read with an `O_NONBLOCK` fd and a main-thread `fs.readSync` drain every 50 ms (until EAGAIN).
  Never `fs.createReadStream` on a char device** — a libuv threadpool thread would sit blocked
  forever. No worker needed. Rescan every 2 s (hotplug); `ENODEV` closes the fd. It never grabs the
  device, so the Chromium Gamepad API is undisturbed.
- Facts verified on the machine (2026-09-24): `/sys/class/input/inputN/uniq` holds the controller's **BT MAC** (hid-playstation; `xpad` / `hid-microsoft`
  do the same for BT Xbox) — also on the `Motion Sensors` / `Touchpad` sub-devices, which must be filtered out; the button node's `/dev/input/eventN` has
  ACL `user:<name>:rw-` (logind `uaccess`), so reading needs no sudo and does not grab the device. evdev codes on hid-playstation: PS = `BTN_MODE` (0x13c),
  Circle = `BTN_EAST` (0x131), Triangle = `BTN_NORTH` (0x133), Square = `BTN_WEST` (0x134); the position ↔ code assignment differs per driver (xpad's X is
  `BTN_NORTH`), which is why the match accepts any face button.
- Alternatives rejected: a worker thread for the reads (a `createReadStream` thread would sit blocked and the default libuv pool has only 4 threads; the
  non-blocking drain needs none); detecting the combo in main and pushing `controller-combo` (the renderer must mask ○/△/□ anyway, so the detection would
  exist twice); Gamepad-API-only identification (two identical DualSenses are indistinguishable there); flashing the physical lightbar
  (`/sys/class/leds/*:rgb:indicator` is root-only and a raw output report over `/dev/hidraw*` is CRC-protected over BT and type-specific — too fragile). The
  pressing pad rumbles instead (`vibrationActuator` on the exact `padIndex`, always accurate).
- Started at app ready and when the launcher is shown; stopped when the window is hidden (a game is
  running — no point draining pad events) and on quit. IPC: `resolve-combo-pad`.

## Wi-Fi (`nmcli`)

`lib/network/wifi.js`, Settings → Energy and network → Wi-Fi. `createWifi({ exec, log })` takes an
injectable `exec` (tests drive the whole connect flow with a fake `nmcli`). IPC: `list-wifi`
(`{ rescan: true }` fresh scan / `{ cached: true }` cached / `{}` auto),
`connect-wifi` (`errorKey` ∈ `badPassword`, `badPasswordFormat`, `needPassword`, `notFound`,
`unsupported`, `denied`, `timeout`, `failed`), `set-wifi-radio`, `forget-wifi`. Verified on NM 1.52:

- **`LC_ALL=C.UTF-8`, not `C`.** The Hungarian locale translates even the terse `ACTIVE` field
  (`igen`/`nem`), but plain `C` mangles accented SSIDs into `?`. (The `pactl` `LC_ALL=C` habit is the
  wrong pattern here.)
- In terse mode (`-t`) `:` inside a field is escaped as `\:` and `\` as `\\` (`splitTerse`); the
  detailed `connection show` values are not escaped.
- **Profile name ≠ SSID.** Saved networks are matched through each profile's `802-11-wireless.ssid`
  (`parseSavedSsids`). A saved network is joined with `connection up uuid <saved>` (stored password);
  if that fails the renderer asks for a password with the on-screen keyboard and runs
  `device wifi connect <ssid> password <pwd>`.
- Permissions (`network-control`, `settings.modify.own`, `enable-disable-wifi`) are granted in the
  active local session with no polkit agent.
- **After a failed connect** the newly created (wrong-password) profile is deleted — autoconnect
  would otherwise keep trying it — and if the previous Wi-Fi connection dropped meanwhile,
  `connection up uuid <previous>` restores it. This matters on a Wi-Fi-only machine.
- **⚠️ The password is a command-line argument**, so an `execFile` error's `err.message` contains it
  verbatim. **Never log `err.message` or the args — only the redacted first line of stderr**
  (`test/network/wifi.test.js` guards this). The brief exposure in `/proc/<pid>/cmdline` is an accepted
  trade-off on a single-user kiosk.
- Hidden network: "＋ Hidden network…" asks for SSID then (masked) password and connects with
  `hidden yes`, skipping the list-based checks. △ on a saved network forgets it (two-step, 3 s):
  every profile of that SSID is deleted, the connection is dropped if active.
- **The focus follows the network, not the row index** (`wifiRowKey`/`wifiFocusIndex`): the list is
  re-sorted on every reload (the active network first), and with an index-based focus a successful
  switch left the focus on the previous, now "saved" network — it looked like the switch did not
  happen, and the next ✕ switched back (seen on the laptop: MB → MB_5GHz → MB … in the log). After a
  successful connect the focus moves to the newly active network.
- **Opening is instant:** the "Searching for networks..." indicator shows immediately, then
  `list-wifi { cached: true }` (`--rescan no`, NetworkManager's last result, ~40 ms), then a background
  refresh (`--rescan auto` — a fresh scan if the last one is older than ~30 s, **~6 s on the laptop**;
  the subview looked empty meanwhile). Navigation works during the background refresh (`refreshing`);
  only the explicit "Rescan" / radio-on is blocking (`scanning`). A `loadSeq` counter drops stale
  responses.
- **Failed connect feedback:** besides the toast, the reason is shown on the network's row for 8 s
  (`.wifi-error-tag`), and a typed password that was wrong / too short / timed out reopens the masked
  keyboard with the error in its title (`wifiRetryWithPassword`). Rejections before any `nmcli`
  connect call (`badPasswordFormat`, `notFound`, `unsupported`, `needPassword`) are logged too
  (`Wi-Fi connect rejected (<ssid>): <key>` — never the password).
- Not supported: WPA-Enterprise (802.1X — the UI says so; profile editing cannot be validated on
  the available machines).
