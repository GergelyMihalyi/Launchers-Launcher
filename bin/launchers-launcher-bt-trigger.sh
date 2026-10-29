#!/bin/bash
# Launchers Launcher — root-less BT controller trigger (BlueZ D-Bus listener).
#
# Listens for the "Connected: true" signals of `gdbus monitor --system --dest org.bluez`; if the
# connected device is a gamepad AND (when configured) the "main controller", it calls
# tv-mode-enter.sh (closes apps + starts the launcher via the watcher socket).
#
# On startup it also runs once over the ALREADY connected devices (sweep_connected) — a
# controller auto-reconnected during boot, before login, produces no transition signal.
#
# Runs from a `systemd --user` unit (systemd/launchers-launcher-bt-trigger.service), DIRECTLY
# from the repo — no /usr/local/bin copy, no sudo, no writes to /etc.
#
# The signal matching (matches_connect) is the bash mirror of the tested contract in
# lib/bluetooth/bt-trigger-parse.js (test/bluetooth/bt-trigger-parse.test.js). If the BlueZ
# signal format changes, both must be updated.
#
# ⚠️ THIS SCRIPT IS A LONG-RUNNING `while true` PROCESS — editing the file does NOT
# reach the already-running process. After a change always run:
#   systemctl --user restart launchers-launcher-bt-trigger.service
# (a plain `git pull`/save is NOT enough — a stale running process keeps the old logic).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ENTER_SCRIPT="$SCRIPT_DIR/tv-mode-enter.sh"
SIDECAR="$HOME/.local/share/launchers-launcher-main-controller"   # the "main controller" MAC (lib/sidecars/main-controller.js)
AUTOSTART_SIDECAR="$HOME/.local/share/launchers-launcher-autostart"  # "controllerAutostart" config key (lib/sidecars/autostart.js)
RUN_LOCK="$HOME/.local/share/launchers-launcher.lock"             # written by the watcher while the launcher runs
LOG="$HOME/.local/share/launchers-launcher-bt-trigger.log"
LOG_MAX=$((1024 * 1024))
DEBOUNCE_SEC="${BT_TRIGGER_DEBOUNCE:-15}"

log() {
    if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX" ]; then
        mv -f "$LOG" "$LOG.1" 2>/dev/null || true
    fi
    printf '[%s] %s\n' "$(date -Is)" "$1" >> "$LOG"
}

norm_mac() { printf '%s' "${1:-}" | tr -d '[:space:]:_-' | tr 'a-f' 'A-F'; }

declare -A LAST_SEEN   # MAC -> last trigger epoch seconds (debounce, for the lifetime of the process)

# Bash mirror of CONNECT_RE in lib/bluetooth/bt-trigger-parse.js.
matches_connect() {
    case "$1" in
        /org/bluez/*/dev_*": org.freedesktop.DBus.Properties.PropertiesChanged ('org.bluez.Device1',"*"'Connected': <true>"*)
            return 0 ;;
        *)
            return 1 ;;
    esac
}

handle_connect() {
    local mac="$1" now prev info want pid

    # 0. "start on controller" guard — the user can turn it off in Settings
    # (lib/sidecars/autostart.js sidecar; missing file = enabled). The watcher and this
    # listener keep running — only the actual launcher start is skipped.
    if [ "$(cat "$AUTOSTART_SIDECAR" 2>/dev/null)" = "disabled" ]; then
        log "auto-start is off — $mac skipped"
        return
    fi

    now=$(date +%s)

    # 1. debounce — same MAC within DEBOUNCE_SEC: skip (Connected=true sometimes arrives twice)
    prev="${LAST_SEEN[$mac]:-0}"
    if [ $((now - prev)) -lt "$DEBOUNCE_SEC" ]; then
        return
    fi
    LAST_SEEN["$mac"]=$now

    # 2. is the launcher already running? (the watcher's lock)
    if [ -f "$RUN_LOCK" ]; then
        pid="$(cat "$RUN_LOCK" 2>/dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            log "launcher already running (PID $pid) — $mac skipped"
            return
        fi
    fi

    # 3. is it a gamepad? (the BlueZ Icon field is the most reliable — see lib/bluetooth/bluetooth.js)
    info="$(bluetoothctl info "$mac" 2>/dev/null || true)"
    if ! printf '%s' "$info" | grep -q 'Icon: input-gaming'; then
        log "$mac is not a gamepad (Icon != input-gaming) — skipped"
        return
    fi

    # 4. "main controller" guard — empty/missing sidecar = any pad may start it
    want="$(norm_mac "$(cat "$SIDECAR" 2>/dev/null || true)")"
    if [ -n "$want" ] && [ "$(norm_mac "$mac")" != "$want" ]; then
        log "$mac is not the main controller ($want) — skipped"
        return
    fi

    log "$mac → TV-mode entry"
    if [ -x "$ENTER_SCRIPT" ]; then
        "$ENTER_SCRIPT" || log "tv-mode-enter.sh exited non-zero ($?)"
    else
        log "ERROR: $ENTER_SCRIPT is not executable"
    fi
}

command -v gdbus >/dev/null 2>&1 || { log "ERROR: gdbus is missing — the listener exits"; exit 1; }
command -v bluetoothctl >/dev/null 2>&1 || { log "ERROR: bluetoothctl is missing — the listener exits"; exit 1; }

log "BT trigger listener started (dir: $SCRIPT_DIR, debounce: ${DEBOUNCE_SEC}s)"

# Startup sweep: if the main controller is ALREADY connected when this listener starts
# (BlueZ auto-reconnect during boot, BEFORE login), there is no `Connected: <true>` transition
# for `gdbus monitor` to catch → we would stay in desktop mode. So run one manual trigger round
# over the currently connected devices — the `handle_connect` guards (gamepad / main
# controller / launcher already running / debounce) apply here too.
sweep_connected() {
    local dev mac name
    while read -r dev mac name; do
        [ "$dev" = "Device" ] && [ -n "$mac" ] || continue
        log "start-up sweep: $mac connected ($name) — trigger round"
        handle_connect "$mac"
    done < <(bluetoothctl devices Connected 2>/dev/null || true)
}

sweep_connected

# `gdbus monitor` exits when dbus-daemon / bluetooth.service restarts → respawn loop.
# `stdbuf -oL`: GLib would block-buffer stdout on a pipe, so signals would sit for seconds.
while true; do
    while IFS= read -r line; do
        if matches_connect "$line"; then
            path="${line%%:*}"          # /org/bluez/hci0/dev_02_00_00_00_00_B2
            dev="${path##*/dev_}"       # 02_00_00_00_00_B2
            handle_connect "${dev//_/:}"
        fi
    done < <(stdbuf -oL gdbus monitor --system --dest org.bluez 2>/dev/null)
    log "gdbus monitor stopped — restarting in 2s"
    sleep 2
done
