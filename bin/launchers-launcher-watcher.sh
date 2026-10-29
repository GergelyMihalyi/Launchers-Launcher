#!/bin/bash
# NOTE: in production the /usr/local/bin/ copy runs (synced by hand) — a change in the
# repo only takes effect after reinstalling. See docs/dev/install-update.md#bin-scripts-and-where-they-run-from.
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
LAUNCHER_LOG="$HOME/.local/share/launchers-launcher-watcher.log"
LAUNCHER_DIR="$HOME/launchers-launcher"
RUNNING_LOCK="$HOME/.local/share/launchers-launcher.lock"
SOCKET_PATH="$XDG_RUNTIME_DIR/launchers-launcher.sock"
# The Node downloaded by install.sh without sudo (when the distro's is too old) takes
# precedence — both `npm start` and the self-update `npm install` use it.
NODE_HOME="$HOME/.local/share/launchers-launcher/node"
if [ -x "$NODE_HOME/bin/node" ]; then PATH="$NODE_HOME/bin:$PATH"; export PATH; fi

# Crash restart: if the launcher exits with a non-zero code (crash), the watcher restarts
# it immediately without waiting for a socket message — but at most CRASH_MAX times
# within a CRASH_WINDOW-second window, so a build broken at startup does not spin in an
# endless restart loop. Past the limit it falls back to the normal socket wait.
CRASH_MAX="${CRASH_MAX:-5}"
CRASH_WINDOW="${CRASH_WINDOW:-60}"

log() { echo "[$(date)] $1" >> "$LAUNCHER_LOG"; }

start_launcher() {
    log "Starting Launchers Launcher..."
    # Refresh the dynamic XAUTHORITY (separate assign + export: `export FOO=$(...)` would swallow
    # the exit code of the right-hand side — shellcheck SC2155).
    XAUTHORITY="$(ls "$XDG_RUNTIME_DIR"/xauth_* 2>/dev/null | head -1)"
    export XAUTHORITY
    xhost +local: >> "$LAUNCHER_LOG" 2>&1
    xhost +local: >> "$LAUNCHER_LOG" 2>&1
    cd "$LAUNCHER_DIR" && npm start >> "$LAUNCHER_LOG" 2>&1 &
    LAUNCHER_PID=$!
    echo "$LAUNCHER_PID" > "$RUNNING_LOCK"
    log "Launchers Launcher started (PID: $LAUNCHER_PID)"

    wait "$LAUNCHER_PID"
    LAUNCHER_RC=$?
    rm -f "$RUNNING_LOCK"
    log "Launchers Launcher exited (exit code: $LAUNCHER_RC)."
}

log "Launchers Launcher Watcher elindult (socket: $SOCKET_PATH)."
rm -f "$SOCKET_PATH"

while true; do
    MSG=$(ncat -l -U "$SOCKET_PATH" 2>/dev/null)

    if [ "$MSG" != "launch" ]; then
        log "Unknown message: skip."
        rm -f "$SOCKET_PATH"
        continue
    fi

    if [ -f "$RUNNING_LOCK" ]; then
        LOCK_PID=$(cat "$RUNNING_LOCK")
        if kill -0 "$LOCK_PID" 2>/dev/null; then
            log "Already running (PID: $LOCK_PID), skip."
            continue
        fi
        rm -f "$RUNNING_LOCK"
    fi

    start_launcher

    # Non-zero exit code = crash → restart immediately without waiting on the socket,
    # with a burst limit against restart loops. Clean exit (0, e.g. PS button / TV-mode
    # exit → app.quit()) → back to the top of the while loop, waiting on the socket.
    crash_count=0
    crash_window_start=$SECONDS
    while [ "$LAUNCHER_RC" -ne 0 ]; do
        now=$SECONDS
        if [ $((now - crash_window_start)) -ge "$CRASH_WINDOW" ]; then
            crash_count=0
            crash_window_start=$now
        fi
        crash_count=$((crash_count + 1))
        if [ "$crash_count" -gt "$CRASH_MAX" ]; then
            log "Too many crashes ($CRASH_MAX/${CRASH_WINDOW}s) — back to waiting on the socket."
            break
        fi
        log "Crash detected (exit code: $LAUNCHER_RC) — restarting immediately ($crash_count/$CRASH_MAX)."
        sleep 2
        start_launcher
    done
done
