#!/usr/bin/env bash
#
# Launchers Launcher — one-line installer:
#
#   curl -fsSL https://raw.githubusercontent.com/GergelyMihalyi/Launchers-Launcher/main/get-launchers-launcher.sh | bash
#
# 1) if `git` is missing, installs it after a confirmation (apt-get / dnf / pacman, sudo);
# 2) clones the repo into ~/launchers-launcher (if already there: `git pull --ff-only`);
# 3) runs ./install.sh — extra flags (e.g. `--yes`) are passed on to it:
#      curl -fsSL …/get-launchers-launcher.sh | bash -s -- --yes
#
# Under `curl | bash` stdin is the script itself, so prompts read from /dev/tty.

set -euo pipefail

REPO_URL="${LAUNCHERS_LAUNCHER_REPO:-https://github.com/GergelyMihalyi/Launchers-Launcher.git}"
DEST="$HOME/launchers-launcher"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in -y|--yes) ASSUME_YES=1 ;; esac
done

TTY=""
if { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi

confirm_yes() {
    # confirm_yes <question> — default answer: yes
    local reply=""
    if [ "$ASSUME_YES" = 1 ] || [ -z "$TTY" ]; then return 0; fi
    read -r -p "$1 [Y/n] " reply <"$TTY" || reply=
    [[ "${reply:-y}" =~ ^[yY] ]]
}

install_git() {
    local id="" like=""
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        id="$(. /etc/os-release && echo "${ID:-}")"
        # shellcheck disable=SC1091
        like="$(. /etc/os-release && echo "${ID_LIKE:-}")"
    fi
    confirm_yes "The installation needs 'git'. Install it (sudo)?" || die "cannot continue without git"
    case " $id $like " in
        *" debian "*|*" ubuntu "*) sudo apt-get update && sudo apt-get install -y git ;;
        *" fedora "*|*" rhel "*)   sudo dnf install -y git ;;
        *" arch "*)                sudo pacman -S --needed --noconfirm git ;;
        *) die "unknown distro ($id) — install git by hand, then run this again" ;;
    esac
}

command -v git >/dev/null 2>&1 || install_git

if [ -d "$DEST/.git" ]; then
    say "already cloned: $DEST — updating (git pull --ff-only)"
    git -C "$DEST" pull --ff-only
elif [ -e "$DEST" ]; then
    die "$DEST exists but is not a git repository — rename it, then run this again"
else
    say "cloning: $REPO_URL → $DEST"
    git clone "$REPO_URL" "$DEST"
fi

say "starting the installer ($DEST/install.sh)"
if [ -n "$TTY" ]; then
    exec "$DEST/install.sh" "$@" <"$TTY"
fi
exec "$DEST/install.sh" "$@"
