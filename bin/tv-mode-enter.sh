#!/bin/bash
# Launchers Launcher — enter TV mode (close apps + start the launcher via the watcher socket).
#
# Runs in the user's session (called by bin/launchers-launcher-bt-trigger.sh, a
# `systemd --user` unit) — so there is NO `sudo -u` / `su -l` hop. Monitor/audio switching
# AND CEC power-on are done by the launcher at startup (main.js applyStartupOutputs /
# maybePowerOnTv) — this script only closes programs and messages the watcher.
#
# The programs to close come from the SIDECAR FILE (~/.local/share/launchers-launcher-tvmode),
# written by the launcher from the config.json `tvMode` key (lib/sidecars/tv-mode-enter.js).
# Missing/empty sidecar → closes nothing, only starts.
#
# Sidecar format (one per line):
#   flatpak <app-id>         flatpak kill <id>   (stops the whole flatpak sandbox)
#   native  <process-name>   pkill -TERM -x <name>   (EXACT name match, never -f!)
#   cmd     <shell-command>  bash -lc '<command>'
#
# ⚠️ There is INTENTIONALLY NO `pkill -f <pattern>` fallback: a user pattern (e.g. "vscode")
# would also match system (non-flatpak) apps and kill them. `flatpak kill` stops the
# flatpak app's whole cgroup — that is enough.

set -uo pipefail

LOG="$HOME/.local/share/launchers-launcher-bt-trigger.log"
SIDECAR="$HOME/.local/share/launchers-launcher-tvmode"
SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/launchers-launcher.sock"
UID_NUM="$(id -u)"

log() { printf '[%s] tv-mode-enter: %s\n' "$(date -Is)" "$1" >> "$LOG"; }

# `cmd` lines run a shell command: only if the sidecar is ours (owned by the user) and
# neither group nor others can write it. flatpak/native lines
# (app ID / exact process name) run regardless.
sidecar_trusted() {
    local owner mode
    read -r owner mode < <(stat -c '%u %a' "$SIDECAR" 2>/dev/null) || return 1
    [ "$owner" = "$UID_NUM" ] || return 1
    [ $(( 8#$mode & 8#022 )) -eq 0 ]
}

close_flatpak() {
    local app="$1"
    if flatpak ps --columns=application 2>/dev/null | grep -qx "$app"; then
        flatpak kill "$app" 2>/dev/null || true
        log "flatpak kill $app"
    fi
}

close_native() {
    # -x: EXACT process-name match (never -f/pattern matching — that would catch system apps too).
    local proc="$1"
    if pgrep -u "$UID_NUM" -x "$proc" >/dev/null 2>&1; then
        pkill -u "$UID_NUM" -TERM -x "$proc" 2>/dev/null && log "stopped: $proc" || true
    fi
}

if [ -s "$SIDECAR" ]; then
    log "entering — closing programs ($SIDECAR)"
    ALLOW_CMD=1
    sidecar_trusted || { ALLOW_CMD=0; log "the sidecar is not trusted (not ours / writable by others) — cmd lines are skipped"; }
    while IFS= read -r line || [ -n "$line" ]; do
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac
        kind="${line%% *}"
        rest="${line#"$kind"}"; rest="${rest# }"
        case "$kind" in
            flatpak)
                close_flatpak "${rest%% *}"
                ;;
            native)
                close_native "${rest%% *}"
                ;;
            cmd)
                if [ "$ALLOW_CMD" != 1 ]; then log "cmd skipped (untrusted sidecar): $rest"; continue; fi
                # `bash -lc` for the login shell's PATH/functions (e.g. `dev` from .bashrc) —
                # NOT `su`, that would ask for a password from a non-root process.
                bash -lc "$rest" >> "$LOG" 2>&1 \
                    && log "cmd OK: $rest" || log "cmd failed / did not run: $rest"
                ;;
            *)
                log "unknown sidecar line: $line"
                ;;
        esac
    done < "$SIDECAR"
else
    log "entering — no program to close (empty/missing sidecar)"
fi

# --- Start the launcher via the watcher socket ---
sleep 1
if pgrep -u "$UID_NUM" -f "launchers-launcher\|electron.*gaming" >/dev/null 2>&1; then
    log "the launcher is already running — nothing to do"
    exit 0
fi
if command -v ncat >/dev/null 2>&1; then
    if echo "launch" | ncat --send-only -U "$SOCKET" 2>>"$LOG"; then
        log "launch message sent ($SOCKET)"
    else
        log "ERROR: the watcher socket failed ($SOCKET)"
    fi
else
    log "ERROR: ncat is missing — the launch message cannot be sent"
fi
