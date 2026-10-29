#!/bin/bash
# Launchers Launcher — bring to front from the menu icon (the `Exec=` of share/launchers-launcher.desktop).
#
#   - RUNNING     → a second `npm start`: the main.js `second-instance` handler brings the
#                   first instance's window to front, the second exits at once (single-instance lock).
#   - NOT RUNNING → message the watcher socket (`launch`), so the watcher supervises it (crash restart);
#                   without `ncat` / a running watcher → plain `npm start`.

set -uo pipefail

LAUNCHER_DIR="$HOME/launchers-launcher"
LOCK="$HOME/.local/share/launchers-launcher.lock"
SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/launchers-launcher.sock"
LOG="$HOME/.local/share/launchers-launcher-watcher.log"
# The Node downloaded by install.sh without sudo (when the distro's is too old) takes
# precedence — both `npm start` and the self-update `npm install` use it.
NODE_HOME="$HOME/.local/share/launchers-launcher/node"
if [ -x "$NODE_HOME/bin/node" ]; then PATH="$NODE_HOME/bin:$PATH"; export PATH; fi

log() { printf '[%s] show: %s\n' "$(date -Is)" "$1" >> "$LOG" 2>/dev/null || true; }

is_running() {
    local pid
    if [ -f "$LOCK" ]; then
        pid="$(cat "$LOCK" 2>/dev/null)"
        [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0
    fi
    pgrep -u "$(id -u)" -f "$LAUNCHER_DIR/node_modules/electron" >/dev/null 2>&1
}

start_direct() {
    ( cd "$LAUNCHER_DIR" && nohup npm start >> "$LOG" 2>&1 & )
    log "npm start (direct)"
}

if is_running; then
    log "already running — bringing it to the front (second-instance)"
    start_direct
    exit 0
fi

if command -v ncat >/dev/null 2>&1 && [ -S "$SOCKET" ]; then
    if printf 'launch' | ncat --send-only -U "$SOCKET" 2>>"$LOG"; then
        log "launch message sent ($SOCKET)"
        exit 0
    fi
    log "the watcher socket did not answer — starting directly"
fi
start_direct
