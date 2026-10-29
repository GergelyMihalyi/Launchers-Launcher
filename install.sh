#!/usr/bin/env bash
#
# Launchers Launcher — installer / uninstaller.
#
#   ./install.sh               install: missing packages + Node + npm install + launcher icon
#                              (+ optionally the auto-start chain) — each with a confirmation
#   ./install.sh --yes         yes to every question (hands-free install)
#   ./install.sh --no-packages installs NO package, only lists the missing ones (the old behavior)
#   ./install.sh --dry-run     prints every state-changing command without running it
#   ./install.sh --uninstall   removes the systemd user units (config + node_modules stay)
#   ./install.sh --help
#
# Missing distro packages (apt-get / dnf / pacman) are installed with sudo after ONE confirmation;
# if Node is missing or older than package.json `engines.node`, the official Node is downloaded
# WITHOUT sudo under ~/.local/share/launchers-launcher/node (SHA-256 verified). Does not touch the
# autologin/SDDM config.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
WATCHER_DEST="/usr/local/bin/launchers-launcher-watcher.sh"
DESKTOP_SRC="$REPO_DIR/share/launchers-launcher.desktop"
DESKTOP_DEST="$HOME/.local/share/applications/launchers-launcher.desktop"
# Location of the per-user (sudo-less) Node — bin/launchers-launcher-watcher.sh and
# bin/launchers-launcher-show.sh also put it first on PATH if it exists.
NODE_HOME="$HOME/.local/share/launchers-launcher/node"
NODE_DIST_URL="${LAUNCHERS_LAUNCHER_NODE_DIST:-https://nodejs.org/dist}"
# Overridable for tests (test/contracts/install-sh.test.js).
OS_RELEASE="${LAUNCHERS_LAUNCHER_OS_RELEASE:-/etc/os-release}"
FLATHUB_URL="https://dl.flathub.org/repo/flathub.flatpakrepo"

DRY_RUN=0
ASSUME_YES=0
NO_PACKAGES=0
MODE=install

# --- output -------------------------------------------------------------------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
say()  { printf '%s\n' "${B}==>${N} $*"; }
ok()   { printf '%s\n' "  ${G}✓${N} $*"; }
warn() { printf '%s\n' "  ${Y}!${N} $*"; }
die()  { printf '%s\n' "${R}ERROR:${N} $*" >&2; exit 1; }

# run <command...> — in dry-run mode only prints it, otherwise runs it.
run() {
    if [ "$DRY_RUN" = 1 ]; then printf '    %s\n' "+ $*"; else "$@"; fi
}
# run_sudo — marks the steps that need privileges.
run_sudo() {
    printf '%s\n' "  ${Y}sudo${N} $*"
    if [ "$DRY_RUN" = 1 ]; then printf '    %s\n' "+ sudo $*"; else sudo "$@"; fi
}
# confirm <question> [y|n] — the second argument is the default answer (Enter / non-interactive stdin).
confirm() {
    local prompt="$1" default="${2:-n}" reply
    if [ "$DRY_RUN" = 1 ]; then printf '%s\n' "$prompt ${B}[dry-run: yes]${N}"; return 0; fi
    if [ "$ASSUME_YES" = 1 ]; then printf '%s\n' "$prompt ${B}[--yes: yes]${N}"; return 0; fi
    if [ ! -t 0 ]; then [ "$default" = y ]; return; fi
    read -r -p "$prompt " reply || reply=
    reply="${reply:-$default}"
    [[ "$reply" =~ ^[yY] ]]
}

# --- arguments ------------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --dry-run)     DRY_RUN=1 ;;
        -y|--yes)      ASSUME_YES=1 ;;
        --no-packages) NO_PACKAGES=1 ;;
        --uninstall)   MODE=uninstall ;;
        -h|--help)
            cat <<'EOF'
Launchers Launcher — installer / uninstaller.

  ./install.sh               install: missing packages + Node + npm install + launcher icon
                             (+ optionally the auto-start chain) — each with a confirmation
  ./install.sh --yes         yes to every question (hands-free install)
  ./install.sh --no-packages installs NO package, only lists the missing ones
  ./install.sh --dry-run     prints every state-changing command without running it
  ./install.sh --uninstall   removes the systemd user units (config + node_modules stay)
  ./install.sh --help

Missing distro packages (apt-get / dnf / pacman) are installed with sudo after ONE confirmation.
A missing or too old Node is downloaded WITHOUT sudo under ~/.local/share/launchers-launcher/node.
Does not touch the autologin/SDDM config.
EOF
            exit 0 ;;
        *) die "unknown option: $arg (see --help)" ;;
    esac
done

# A previously downloaded per-user Node takes precedence (the distro's may be too old).
if [ -x "$NODE_HOME/bin/node" ]; then PATH="$NODE_HOME/bin:$PATH"; export PATH; fi

# --- distro → package names ---------------------------------------------------
distro_id() {
    [ -r "$OS_RELEASE" ] || { echo unknown; return; }
    local ID="" ID_LIKE=""
    # shellcheck disable=SC1090
    . "$OS_RELEASE"
    case " $ID ${ID_LIKE:-} " in
        *" fedora "*|*" rhel "*) echo fedora ;;
        *" arch "*)              echo arch ;;
        *" debian "*|*" ubuntu "*) echo debian ;;
        *) echo "${ID:-unknown}" ;;
    esac
}
DISTRO="$(distro_id)"
# The launcher-side mirror: lib/host-deps/host-packages.js `PACKAGE_MAP` (except node/npm/curl/xz)
# — test/contracts/host-packages-mirror.test.js keeps them in sync.
pkg_for() {
    # pkg_for <tool> — the distro package name, or empty
    case "$DISTRO:$1" in
        fedora:node|fedora:npm)  echo "nodejs npm" ;;
        fedora:kscreen-doctor)   echo "libkscreen" ;;
        fedora:pactl)            echo "pulseaudio-utils" ;;
        fedora:bluetoothctl)     echo "bluez" ;;
        fedora:gdbus)            echo "glib2" ;;
        fedora:ncat)             echo "nmap-ncat" ;;
        fedora:flatpak)          echo "flatpak" ;;
        fedora:git)              echo "git" ;;
        fedora:zstd)             echo "zstd" ;;
        fedora:cec-ctl)          echo "v4l-utils" ;;
        fedora:curl)             echo "curl" ;;
        fedora:xz)               echo "xz" ;;
        arch:node|arch:npm)      echo "nodejs npm" ;;
        arch:kscreen-doctor)     echo "libkscreen" ;;
        arch:pactl)              echo "libpulse" ;;
        arch:bluetoothctl)       echo "bluez-utils" ;;
        arch:gdbus)              echo "glib2" ;;
        arch:ncat)               echo "nmap" ;;
        arch:flatpak)            echo "flatpak" ;;
        arch:git)                echo "git" ;;
        arch:zstd)               echo "zstd" ;;
        arch:cec-ctl)            echo "v4l-utils" ;;
        arch:curl)               echo "curl" ;;
        arch:xz)                 echo "xz" ;;
        debian:node|debian:npm)  echo "nodejs npm" ;;
        debian:kscreen-doctor)   echo "libkscreen-bin" ;;
        debian:pactl)            echo "pulseaudio-utils" ;;
        debian:bluetoothctl)     echo "bluez" ;;
        debian:gdbus)            echo "libglib2.0-bin" ;;
        debian:ncat)             echo "ncat" ;;
        debian:flatpak)          echo "flatpak" ;;
        debian:git)              echo "git" ;;
        debian:zstd)             echo "zstd" ;;
        debian:cec-ctl)          echo "v4l-utils" ;;
        debian:curl)             echo "curl" ;;
        debian:xz)               echo "xz-utils" ;;
        *) echo "" ;;
    esac
}
has_pkg_manager() {
    case "$DISTRO" in
        debian) command -v apt-get >/dev/null 2>&1 ;;
        fedora) command -v dnf >/dev/null 2>&1 ;;
        arch)   command -v pacman >/dev/null 2>&1 ;;
        *) return 1 ;;
    esac
}

# --- prerequisite check -------------------------------------------------------
# Result of one check round: packages to install (required / optional), required tools missing
# without a package, and whether a per-user Node is needed.
PKGS_REQ=()
PKGS_OPT=()
UNMAPPED_REQ=()
NODE_LOCAL=0
QUIET=0

add_pkgs() {
    # add_pkgs <req|opt> <package...> — uniquely into the matching list
    local kind="$1" p; shift
    for p in "$@"; do
        if [[ " ${PKGS_REQ[*]:-} ${PKGS_OPT[*]:-} " == *" $p "* ]]; then continue; fi
        if [ "$kind" = req ]; then PKGS_REQ+=("$p"); else PKGS_OPT+=("$p"); fi
    done
}

need() {
    # need <command> <label> [optional] — always returns 0 (only collects)
    local cmd="$1" label="$2" opt="${3:-}" p
    if command -v "$cmd" >/dev/null 2>&1; then
        [ "$QUIET" = 1 ] || ok "$label ($(command -v "$cmd"))"
        return 0
    fi
    p="$(pkg_for "$cmd")"
    if [ -n "$opt" ]; then
        [ "$QUIET" = 1 ] || warn "$label is missing (optional)${p:+ — package: $p}"
        # shellcheck disable=SC2086
        [ -z "$p" ] || add_pkgs opt $p
    else
        [ "$QUIET" = 1 ] || warn "$label is missing${p:+ — package: $p}"
        if [ -n "$p" ]; then
            # shellcheck disable=SC2086
            add_pkgs req $p
        else
            UNMAPPED_REQ+=("$label")
        fi
    fi
    return 0
}

# The Node version is measured against the package.json `engines.node` (`>=X.Y[.Z]`) minimum —
# Electron's install script fails on older ones.
node_min_required() {
    sed -n 's/.*"node"[[:space:]]*:[[:space:]]*">=\([0-9.]*\)".*/\1/p' "$REPO_DIR/package.json" | head -1
}

version_ge() {
    # version_ge <have> <need> — true if have >= need (sort -V)
    [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

has_cec_device() {
    compgen -G '/dev/cec*' >/dev/null
}

# check_node — is Node present and new enough; if not → NODE_LOCAL=1 (per-user Node), which needs
# the download tools (curl, xz). npm ships with the Node package.
check_node() {
    local have need_v
    need_v="$(node_min_required)"
    if command -v node >/dev/null 2>&1; then
        have="$(node -v | sed 's/^v//')"
        if [ -z "$need_v" ] || version_ge "$have" "$need_v"; then
            [ "$QUIET" = 1 ] || ok "Node $have${need_v:+ (at least $need_v is needed)}"
            need npm "npm"
            return 0
        fi
        [ "$QUIET" = 1 ] || warn "Node $have is too old — at least $need_v is needed (package.json engines)"
    else
        [ "$QUIET" = 1 ] || warn "Node.js is missing"
    fi
    NODE_LOCAL=1
    need curl "curl (downloading Node)"
    need xz "xz (unpacking Node)"
}

is_gnome() {
    # Mirror of lib/desktop-env.js `detectDesktopEnv()` (simplified): on GNOME the monitor switch goes
    # through Mutter D-Bus, kscreen-doctor is not needed.
    case "${LAUNCHERS_LAUNCHER_DESKTOP:-}" in
        gnome) return 0 ;;
        kde)   return 1 ;;
    esac
    case ":${XDG_CURRENT_DESKTOP:-}:" in
        *[Kk][Dd][Ee]*) return 1 ;;
        *[Gg][Nn][Oo][Mm][Ee]*|*:ubuntu:*|*:pop:*) return 0 ;;
    esac
    return 1
}

collect_prereqs() {
    PKGS_REQ=(); PKGS_OPT=(); UNMAPPED_REQ=(); NODE_LOCAL=0
    check_node
    need git "git (updates)"
    if ! is_gnome; then need kscreen-doctor "kscreen-doctor (monitor switching)"; fi
    need pactl "pactl (audio output)"
    need bluetoothctl "bluetoothctl (Bluetooth)"
    need gdbus "gdbus (BT trigger, window activation)"
    need ncat "ncat (auto-start socket)" optional
    need flatpak "flatpak (Heroic/RetroArch/flatpak launchers)" optional
    need zstd "zstd (compressing save backups)" optional
    if has_cec_device; then need cec-ctl "cec-ctl (TV power-on over CEC)" optional; fi
}

install_packages() {
    # install_packages <package...>
    case "$DISTRO" in
        debian)
            run_sudo apt-get update
            run_sudo apt-get install -y "$@" ;;
        fedora) run_sudo dnf install -y "$@" ;;
        arch)   run_sudo pacman -S --needed --noconfirm "$@" ;;
    esac
}

# The official Node (latest of the package.json `engines.node` major) into $NODE_HOME, without
# sudo. Tarball verified with SHASUMS256.txt; the old copy is only replaced on success.
install_local_node() {
    local need_v major arch base tmp file
    need_v="$(node_min_required)"
    major="${need_v%%.*}"
    [ -n "$major" ] || die "cannot read engines.node from package.json"
    case "$(uname -m)" in
        x86_64)        arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) die "unsupported CPU architecture for the Node download: $(uname -m)" ;;
    esac
    base="$NODE_DIST_URL/latest-v${major}.x"
    say "Downloading Node $major.x → $NODE_HOME (no sudo)"
    if [ "$DRY_RUN" = 1 ]; then
        printf '    %s\n' "+ curl -fsSL $base/SHASUMS256.txt" \
            "+ curl -fL $base/node-v$major.*-linux-$arch.tar.xz" \
            "+ sha256sum -c (SHASUMS256.txt)" \
            "+ tar -xJf … -C $NODE_HOME --strip-components=1"
        return 0
    fi
    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "cannot download the Node version list ($base)"
    file="$(grep -oE "node-v[0-9.]+-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
    [ -n "$file" ] || die "no linux-$arch Node package at $base"
    curl -fL --progress-bar "$base/$file" -o "$tmp/$file" || die "the Node download failed ($file)"
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) \
        || die "the Node package checksum does not match ($file)"
    mkdir -p "$(dirname "$NODE_HOME")"
    rm -rf "$NODE_HOME.new"
    mkdir -p "$NODE_HOME.new"
    tar -xJf "$tmp/$file" -C "$NODE_HOME.new" --strip-components=1
    rm -rf "$NODE_HOME"
    mv "$NODE_HOME.new" "$NODE_HOME"
    rm -rf "$tmp"
    trap - EXIT
    PATH="$NODE_HOME/bin:$PATH"; export PATH
    ok "Node $(node -v) installed ($NODE_HOME)"
}

ensure_prereqs() {
    say "Prerequisites"
    collect_prereqs

    if [ "${XDG_SESSION_TYPE:-}" = wayland ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
        ok "Wayland session"
    else
        warn "not a Wayland session — the launcher was built for KDE Plasma/Wayland"
    fi
    case "${XDG_CURRENT_DESKTOP:-}" in
        *KDE*) ok "KDE Plasma" ;;
        *)     warn "not KDE Plasma (${XDG_CURRENT_DESKTOP:-?}) — the monitor/theme integration is KDE-dependent" ;;
    esac

    local all=("${PKGS_REQ[@]}" "${PKGS_OPT[@]}")
    if [ "${#all[@]}" -gt 0 ]; then
        echo
        if [ "$NO_PACKAGES" = 1 ]; then
            say "Missing packages (--no-packages — install them by hand): ${all[*]}"
        elif ! has_pkg_manager; then
            say "Missing packages (unknown distro: $DISTRO — install them by hand): ${all[*]}"
        elif confirm "Install the missing packages? (sudo, $DISTRO: ${all[*]}) [Y/n]" y; then
            say "Installing packages"
            install_packages "${all[@]}"
        else
            say "package installation skipped"
        fi
    fi

    if [ "${#UNMAPPED_REQ[@]}" -gt 0 ]; then
        say "No package name known (distro: $DISTRO) — install by hand: $(IFS=','; echo "${UNMAPPED_REQ[*]}")"
    fi

    if [ "$NODE_LOCAL" = 1 ]; then
        echo
        if confirm "Download the official Node.js to $NODE_HOME (no sudo)? [Y/n]" y; then
            install_local_node
        fi
    fi

    # Recheck after installing (nothing was installed in dry-run — nothing to measure there).
    [ "$DRY_RUN" = 1 ] && return 0
    QUIET=1
    collect_prereqs
    QUIET=0
    local still=("${PKGS_REQ[@]}" "${UNMAPPED_REQ[@]}")
    if [ "$NODE_LOCAL" = 1 ]; then still+=("Node.js >= $(node_min_required)"); fi
    [ "${#still[@]}" = 0 ] || die "still missing (required): ${still[*]} — install it, then run this again"
    ok "all required dependencies are present"
}

# --- flathub + CEC (optional system steps) ------------------------------------
setup_flathub() {
    command -v flatpak >/dev/null 2>&1 || return 0
    say "Flathub (user remote — for installing launchers)"
    run flatpak remote-add --user --if-not-exists flathub "$FLATHUB_URL"
}

setup_cec_group() {
    has_cec_device || return 0
    if id -nG | tr ' ' '\n' | grep -qx video; then
        ok "CEC: the user is in the video group"
        return 0
    fi
    if confirm "A CEC device exists (/dev/cec*): add you to the 'video' group (sudo, needs a re-login)? [y/N]" n; then
        run_sudo usermod -aG video "$(id -un)"
        warn "the group membership takes effect at the next login"
    fi
}

# --- .desktop launcher icon ---------------------------------------------------
# A launcher icon for the app itself in the KDE menu / desktop. `Exec=` points to
# bin/launchers-launcher-show.sh (running → bring to front, not running → watcher socket / npm start).
# Writes only into the user's home, no sudo.
setup_desktop_entry() {
    say "Launcher icon (.desktop) — $DESKTOP_DEST"
    run mkdir -p "$(dirname "$DESKTOP_DEST")"
    run chmod +x "$REPO_DIR/bin/launchers-launcher-show.sh"
    if [ "$DRY_RUN" = 1 ]; then
        printf '    %s\n' "+ sed 's|@REPO@|$REPO_DIR|g' $DESKTOP_SRC > $DESKTOP_DEST"
    else
        sed "s|@REPO@|$REPO_DIR|g" "$DESKTOP_SRC" > "$DESKTOP_DEST"
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
        run update-desktop-database "$(dirname "$DESKTOP_DEST")"
    fi
    ok "appears in the application menu as 'Launchers Launcher' (a click starts it / brings it to the front)"
}

# --- auto-start chain ---------------------------------------------------------
setup_autostart() {
    command -v ncat >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || die "auto-start needs 'ncat' ($(pkg_for ncat))"

    say "Installing the watcher script ($WATCHER_DEST) — this needs sudo"
    run_sudo cp "$REPO_DIR/bin/launchers-launcher-watcher.sh" "$WATCHER_DEST"
    run_sudo chmod +x "$WATCHER_DEST"

    say "systemd --user unitok ($SYSTEMD_USER_DIR)"
    run mkdir -p "$SYSTEMD_USER_DIR"
    run cp "$REPO_DIR/systemd/launchers-launcher-watcher.service" "$SYSTEMD_USER_DIR/"
    run cp "$REPO_DIR/systemd/launchers-launcher-bt-trigger.service" "$SYSTEMD_USER_DIR/"
    run systemctl --user daemon-reload
    run systemctl --user enable --now launchers-launcher-watcher.service
    run systemctl --user enable --now launchers-launcher-bt-trigger.service

    ok "auto-start enabled"
    warn "for a cold boot (trigger before login): loginctl enable-linger $USER  — not needed with kiosk autologin"
    warn "removing the old udev chain (if present): sudo rm -f /etc/udev/rules.d/99-dualsense-tv-mode.rules /usr/local/bin/dualsense-tv-mode.sh && sudo udevadm control --reload"
}

# --- install ------------------------------------------------------------------
do_install() {
    # Compare resolved paths: a symlinked ~/launchers-launcher is fine too (the units' `%h/launchers-launcher`
    # path reaches the repo through it; test/contracts/install-sh.test.js runs with an isolated HOME this way).
    [ "$REPO_DIR" = "$(readlink -f "$HOME/launchers-launcher")" ] \
        || die "the repo is NOT under ~/launchers-launcher ($REPO_DIR) — the systemd units expect that path; clone it there, or edit the units by hand"

    ensure_prereqs

    echo
    say "Dependencies (npm install)"
    run npm --prefix "$REPO_DIR" install

    echo
    setup_flathub
    setup_cec_group

    say "Configuration"
    ok "config.json is created on the first start (~/.config/launchers-launcher/)"

    echo
    setup_desktop_entry

    echo
    if confirm "Enable auto-start (the launcher starts when a controller connects)? [y/N]" n; then
        setup_autostart
    else
        say "auto-start skipped — start the launcher by hand: cd ~/launchers-launcher && npm start"
    fi

    echo
    say "Done."
    echo "  Start:     the 'Launchers Launcher' icon in the application menu — or: cd ~/launchers-launcher && npm start"
    echo "  Setup:     the first start runs a setup wizard (monitor, audio, controller, theme)"
    echo "  Log:       ~/.local/share/launchers-launcher*.log"
}

# --- uninstall ----------------------------------------------------------------
do_uninstall() {
    say "Stopping / removing the systemd --user units"
    run systemctl --user disable --now launchers-launcher-bt-trigger.service || true
    run systemctl --user disable --now launchers-launcher-watcher.service || true
    run rm -f "$SYSTEMD_USER_DIR/launchers-launcher-bt-trigger.service" "$SYSTEMD_USER_DIR/launchers-launcher-watcher.service"
    run systemctl --user daemon-reload || true
    ok "user units removed"

    say "Removing the launcher icon (.desktop)"
    run rm -f "$DESKTOP_DEST"
    if command -v update-desktop-database >/dev/null 2>&1; then
        run update-desktop-database "$(dirname "$DESKTOP_DEST")" || true
    fi
    ok "launcher icon removed"

    echo
    say "Manual (sudo) cleanup, if needed:"
    echo "  sudo rm -f $WATCHER_DEST"
    echo "  sudo rm -f /etc/udev/rules.d/99-dualsense-tv-mode.rules /usr/local/bin/dualsense-tv-mode.sh && sudo udevadm control --reload"
    echo
    ok "kept: ~/.config/launchers-launcher/  (settings), node_modules/ and the per-user Node ($NODE_HOME)"
}

if [ "$DRY_RUN" = 1 ]; then say "DRY-RUN — nothing is executed"; fi
case "$MODE" in
    install)   do_install ;;
    uninstall) do_uninstall ;;
esac
