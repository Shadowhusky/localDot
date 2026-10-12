#!/usr/bin/env bash
# Installs localDot on macOS, Linux and WSL 2: checks prerequisites, installs a signed package
# or builds an authorized source checkout, starts services and prints a sign-in link. Run it
# again to upgrade; --uninstall removes the app. The installed `localdot` command uses this script.
# On Windows, install.ps1 sets up WSL 2 and runs this inside it. See docs/install.md.
set -euo pipefail

NODE_VERSION=24.21.0
GO_VERSION=1.27.1
MIN_DOCKER_MAJOR=28
DEFAULT_REPO=https://github.com/Shadowhusky/localdot.git
DEFAULT_REF=main
DEFAULT_PACKAGE_CHANNEL=""
PACKAGE_BOOTSTRAP_SHA256=""
MARKER="Managed by localDot's install.sh"
IMAGE_ROLES="gate brain desktop browser"
KEYD_LABEL=dev.localdot.keyd
DAEMON_LABEL=dev.localdot.daemon
KEYD_UNIT=localdot-keyd.service
DAEMON_UNIT=localdot-daemon.service

node_sha256() {
  case "$1" in
  darwin-arm64) echo bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
  darwin-x64) echo 1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
  linux-arm64) echo 724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 ;;
  linux-x64) echo 6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff ;;
  esac
}

go_sha256() {
  case "$1" in
  darwin-amd64) echo 8f8f52c6649542cf027bbc9b9c68d1ec042f9f34808a40413f0b8b3f66f3caa4 ;;
  darwin-arm64) echo ee215d57e0ec269c60cc9ceca68e6bda321ba9ee5afe24f4b0988703c2d87d12 ;;
  linux-amd64) echo 63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445 ;;
  linux-arm64) echo 3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec ;;
  esac
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install or upgrade localDot on macOS, Linux or WSL 2.

Usage: install.sh [options]
  --package-channel <https-url> Install a signed, prebuilt testing release (no repository access)
  --ref <branch, tag or commit>  Version to install (default: main, or the one installed)
  --repo <url or path>           Where to get localDot from
  --port <port>                  Local port for the app (default 4750)
  --home <folder>                Where localDot keeps your data (default ~/.localdot)
  --prefix <folder>              Where the app is installed (default ~/.local/share/localdot)
  --tailscale                    Reach localDot from your other devices through Tailscale Serve
  --no-tailscale                 Stop serving localDot through Tailscale
  --passphrase-vault             Linux: keep saved keys in a file only your passphrase opens
  --registry <registry/owner>    Pull published computer images instead of building them.
                                 Only for a registry you trust: they run as published.
  --install-prerequisites        Install supported missing prerequisites without a setup prompt
  --no-prerequisites             Only check prerequisites; do not install or launch them
  --skip-images                  Use the computer images already in Docker
  --uninstall                    Remove localDot; keeps your data
  --help                         Show this help

Run it again at any time to upgrade; it keeps your settings and data.
EOF
}

command_usage() {
  cat <<'EOF'
localdot: start and manage localDot

  localdot up                  Start localDot and print a sign-in link
  localdot down                Stop localDot until you start it again or restart this computer
  localdot start-at-login on|off|status  Choose whether localDot starts at login
  localdot restart             Restart localDot
  localdot open [--qr]         Print a fresh, single-use sign-in link (--qr: draw it for your phone)
  localdot doctor              Check Docker, the images, the key service and the app
  localdot unlock              Enter the passphrase that protects your saved keys
  localdot logs [--follow]     Show recent logs
  localdot stop [--all]        Stop dot's actions (--all: every task and computer)
  localdot update [options]    Upgrade and keep your data (options as for install.sh, e.g. --ref)
  localdot uninstall           Remove localDot; keeps your data
EOF
}

with_timeout() {
  local seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    perl -e 'alarm shift; exec @ARGV or exit 127' "$seconds" "$@"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Paths end up in service files and the shim unquoted by those formats, so only plain characters.
check_path() {
  case "$2" in
  /*) ;;
  *) die "$1 must be an absolute path: $2" ;;
  esac
  case "$2" in
  *[!A-Za-z0-9._/@+,:~-]*) die "$1 has characters the services can't use: $2. Choose a path with letters, digits and . _ - / only." ;;
  esac
}

detect_platform() {
  local kernel machine release
  kernel=$(uname -s)
  machine=$(uname -m)
  case "$kernel" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) die "On Windows, run install.ps1 in PowerShell instead. It sets up WSL 2 and runs this installer inside it." ;;
  *) die "localDot runs on macOS, Linux and Windows (through WSL 2), not on $kernel." ;;
  esac
  case "$machine" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) die "localDot needs a 64-bit Intel, AMD or ARM processor, not $machine." ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple silicon.
  if [ "$OS" = macos ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    ARCH=arm64
  fi
  WSL=""
  if [ "$OS" = linux ]; then
    release=$(uname -r)
    case "$release" in
    *[Mm]icrosoft* | *WSL*)
      case "$release" in
      *WSL2* | *microsoft-standard*) WSL=2 ;;
      *) die "This is WSL 1, and localDot needs WSL 2. In PowerShell, run: wsl --set-version <distro> 2 (or use install.ps1)." ;;
      esac
      ;;
    esac
    case "$(ldd --version 2>&1 || true)" in
    *[Mm]usl*)
      die "This Linux uses musl (for example Alpine). localDot needs a glibc distribution such as Ubuntu, Debian or Fedora."
      ;;
    esac
  fi
  if [ "$(id -u)" = 0 ]; then
    die "Run the installer as your own user, not as root. localDot runs as that user's services; only prerequisite setup may request sudo. On a fresh server, create a user with Docker access first; see docs/install.md."
  fi
}

package_hint() {
  if command -v apt-get >/dev/null 2>&1; then
    say "sudo apt-get update && sudo apt-get install -y $*"
  elif command -v dnf >/dev/null 2>&1; then
    say "sudo dnf install -y $*"
  elif command -v pacman >/dev/null 2>&1; then
    say "sudo pacman -S --needed $*"
  elif command -v zypper >/dev/null 2>&1; then
    say "sudo zypper install -y $*"
  else
    say "your package manager"
  fi
}

# Docker Desktop's command may be missing from the PATH of a non-login shell on a Mac.
find_docker() {
  command -v docker >/dev/null 2>&1 && return 0
  [ "$OS" = macos ] || return 1
  local candidate
  for candidate in "$HOME/.docker/bin/docker" /usr/local/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do
    if [ -x "$candidate" ]; then
      PATH="${candidate%/*}:$PATH"
      export PATH
      return 0
    fi
  done
  return 1
}

# Prints what is wrong with Docker, or nothing when it is ready.
docker_problem() {
  local engine="Docker Engine $MIN_DOCKER_MAJOR or newer"
  if ! find_docker; then
    if [ "$OS" = macos ]; then
      say "Docker Desktop. Install it from https://www.docker.com/products/docker-desktop/ and start it."
    elif [ -n "$WSL" ]; then
      say "Docker. Install Docker Desktop for Windows and turn on Settings > Resources > WSL integration for this distro, or follow https://docs.docker.com/engine/install/ for a native engine."
    else
      say "$engine. Rerun interactively to install it on Ubuntu or Debian, or follow https://docs.docker.com/engine/install/"
    fi
    return
  fi
  local out major
  if ! out=$(with_timeout 30 docker info --format '{{.ServerVersion}}' 2>&1); then
    case "$out" in
    *[Pp]ermission\ denied*)
      say "Permission to use Docker. Run: sudo usermod -aG docker $(id -un), then sign out and back in."
      ;;
    *)
      if [ "$OS" = macos ]; then
        say "Docker is installed but not running. Start Docker Desktop and wait until it says it is running."
      elif [ -n "$WSL" ]; then
        say "Docker is installed but not running. Start Docker Desktop for Windows, or for Docker Engine in this distro run: sudo systemctl enable --now docker"
      else
        say "Docker is installed but not running. Run: sudo systemctl enable --now docker"
      fi
      ;;
    esac
    return
  fi
  out=$(printf '%s\n' "$out" | tail -n 1)
  major=${out%%.*}
  case "$major" in
  '' | *[!0-9]*) say "$engine. This Docker reports version '$out'." ;;
  *) [ "$major" -ge "$MIN_DOCKER_MAJOR" ] || say "$engine. This one is $out; update Docker." ;;
  esac
}

user_systemd() {
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export XDG_RUNTIME_DIR
  fi
  systemctl --user show-environment >/dev/null 2>&1
}

# A fresh WSL shell may have Docker's group while the long-lived user manager does not.
# Probe from a transient service before touching an existing installation.
service_docker_problem() {
  local docker_bin result
  local -a environment=("HOME=$HOME" "PATH=$PATH")
  docker_bin=$(command -v docker) || return 0
  [ -z "${DOCKER_HOST:-}" ] || environment+=("DOCKER_HOST=$DOCKER_HOST")
  [ -z "${DOCKER_CONTEXT:-}" ] || environment+=("DOCKER_CONTEXT=$DOCKER_CONTEXT")
  [ -z "${DOCKER_CONFIG:-}" ] || environment+=("DOCKER_CONFIG=$DOCKER_CONFIG")
  if result=$(with_timeout 20 systemd-run --user --quiet --wait --pipe --collect \
      --property=RuntimeMaxSec=15s -- env "${environment[@]}" "$docker_bin" info --format '{{.ServerVersion}}' 2>&1); then
    return 0
  fi
  if [ -n "$WSL" ]; then
    say "Docker works in this terminal but not in Ubuntu's background services. Restart this WSL distribution from PowerShell (wsl --terminate <distro>), reopen it, and rerun setup. This stops its running Linux apps; their data is kept."
  else
    say "Docker works in this terminal but not in your background services. Sign out of all sessions and sign back in, or restart Linux, then rerun setup. Docker and your data are kept."
  fi
}

# Read consent from the terminal: stdin may be the curl | bash script itself.
approve_prerequisites() {
  case "${PREREQUISITES:-ask}" in
  no) return 1 ;;
  yes) return 0 ;;
  esac
  local answer
  if ! ( : </dev/tty ) 2>/dev/null; then return 1; fi
  say "localDot can install missing build tools and Docker. Administrator permission may be needed."
  say "Existing engines are kept. Docker Desktop presents its own first-run terms."
  [ "$OS" != linux ] || say "Native Linux setup gives your user Docker access, which grants administrator-equivalent control."
  printf 'Install missing prerequisites and continue? [Y/n] ' >/dev/tty
  IFS= read -r answer </dev/tty || return 1
  case "$answer" in
  '' | y | Y | yes | Yes) PREREQUISITES=yes ;;
  *) PREREQUISITES=no; return 1 ;;
  esac
}

wait_for_docker() {
  local started=$SECONDS deadline=$((SECONDS + 1200)) notice=$((SECONDS + 15)) problem
  step "Waiting for Docker"
  say "Finish Docker's first-run setup in its window. Installation continues here when it is ready."
  while [ "$SECONDS" -lt "$deadline" ]; do
    find_docker || true
    problem=$(docker_problem)
    [ -n "$problem" ] || { say "Docker is ready. Continuing installation."; return 0; }
    if [ "$SECONDS" -ge "$notice" ]; then
      say "Still waiting for Docker ($((SECONDS - started)) seconds). ${problem%%$'\n'*}"
      notice=$((SECONDS + 15))
    fi
    sleep 3
  done
  die "Docker is not ready yet. $problem Rerun this installer after resolving it; completed setup is kept."
}

install_mac_docker() (
  # A subshell confines cleanup traps to this download and mounted installer.
  set -e
  # Bash 3.2 unwinds function-local variables before an errexit EXIT trap.
  # These variables are already isolated by the subshell.
  platform= digest= folder= mountpoint= mounted=0
  case "$ARCH" in
  arm64) platform=arm64; digest=02147e4d559ff41e1d9d7be63a554101340237064c7b6df234548aa111ebf04c ;;
  x64) platform=amd64; digest=44a9c8524c6f5cc6ba51cec7fd6343b2a744ff4cb5126f7d3d5b6f4da06fd905 ;;
  *) die "Unsupported Docker Desktop architecture: $ARCH" ;;
  esac
  folder=$(mktemp -d "${TMPDIR:-/tmp}/localdot-docker.XXXXXX")
  mountpoint="$folder/volume"
  cleanup_docker_download() {
    if [ "$mounted" = 1 ] && ! hdiutil detach "$mountpoint" -quiet >/dev/null 2>&1; then
      warn "Docker's installer volume is still mounted at $mountpoint. Eject it in Finder."
      return
    fi
    rm -rf "$folder"
  }
  trap cleanup_docker_download EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  step "Downloading Docker Desktop 4.94.0"
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 30 --max-time 1800 \
    "https://desktop.docker.com/mac/main/$platform/241994/Docker.dmg" -o "$folder/Docker.dmg"
  step "Verifying Docker Desktop"
  [ "$(sha256_of "$folder/Docker.dmg")" = "$digest" ] || die "Docker download verification failed. Nothing was installed; rerun setup to retry."
  step "Opening the verified Docker installer"
  hdiutil attach "$folder/Docker.dmg" -mountpoint "$mountpoint" -nobrowse -quiet
  mounted=1
  # Do not accept Docker's terms on the user's behalf or bypass macOS security checks.
  say "Installing Docker Desktop. Approve the administrator prompt if macOS asks."
  sudo "$mountpoint/Docker.app/Contents/MacOS/install" --user="$(id -un)"
)

linux_distribution() {
  . /etc/os-release
  printf '%s %s\n' "$ID" "${VERSION_CODENAME:-}"
}

install_linux_prerequisites() {
  # Only native Ubuntu/Debian use this route. WSL is managed by install.ps1 to avoid
  # installing an independent engine alongside Docker Desktop's WSL integration.
  local distro codename need_docker=$1 tool owned_repo=no
  read -r distro codename < <(linux_distribution)
  case "$distro" in ubuntu | debian) ;; *) return 0 ;; esac
  case "$codename" in '' | *[!a-zA-Z0-9.-]*) return 0 ;; esac
  command -v apt-get >/dev/null 2>&1 || return 0
  if [ "$need_docker" = yes ]; then
    if [ -f /etc/apt/sources.list.d/docker.sources ] && grep -qx '# Configured by localDot prerequisite setup' /etc/apt/sources.list.d/docker.sources; then
      owned_repo=yes
    fi
    # Never remove or replace another container runtime's packages automatically.
    for tool in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc docker-ce docker-ce-cli; do
      if [ "$owned_repo" = yes ]; then
        case "$tool" in containerd | runc | docker-ce | docker-ce-cli) continue ;; esac
      fi
      if dpkg-query -W -f='${Status}' "$tool" 2>/dev/null | grep -q 'install ok installed'; then
        die "Existing container package '$tool' found. Follow https://docs.docker.com/engine/install/$distro/ to configure it, then rerun setup. No packages were replaced."
      fi
    done
    if { [ -e /etc/apt/sources.list.d/docker.sources ] && [ "$owned_repo" != yes ]; } || [ -e /etc/apt/sources.list.d/docker.list ]; then
      die "An existing Docker package repository needs attention. Follow https://docs.docker.com/engine/install/$distro/ and rerun setup. Its configuration was kept."
    fi
  fi
  step "Installing Linux prerequisites"
  sudo bash -s -- "$distro" "$codename" "$need_docker" <<'ROOT'
set -euo pipefail
apt-get update
apt-get install -y git curl tar gzip ca-certificates
if [ "$3" = yes ]; then
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 30 --max-time 120 \
    "https://download.docker.com/linux/$1/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf '# Configured by localDot prerequisite setup\nTypes: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
    "$1" "$2" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
ROOT
  if [ "$need_docker" = yes ]; then
    say "Docker is installed. Giving your user Docker access (this grants administrator-equivalent control)."
    sudo usermod -aG docker "$(id -un)"
    # Both the shell AND systemd's user manager need refreshed group membership.
    # sg/newgrp refresh only the shell and can leave the installed app unable to connect.
    die "One sign-out is needed to activate Docker access. Sign out of all sessions and sign back in (or restart), then rerun the same installer command. Docker and the downloaded packages are kept."
  fi
}

prepare_prerequisites() {
  [ "${PREREQUISITES:-ask}" != no ] || return 0
  local missing=0 need_docker=no deadline problem
  # A background updater must never launch interactive system installers.
  if [ "${PREREQUISITES:-ask}" = ask ] && ! ( : </dev/tty ) 2>/dev/null; then return 0; fi
  [ -n "${PACKAGE_CHANNEL:-}" ] || git --version >/dev/null 2>&1 || missing=1
  for tool in curl tar gzip; do command -v "$tool" >/dev/null 2>&1 || missing=1; done
  find_docker || need_docker=yes
  if [ "$OS" = macos ]; then
    if [ "$missing" = 1 ]; then
      approve_prerequisites || return 0
      step "Installing Apple's command line tools"
      xcode-select --install || true
      say "Finish Apple's installer. localDot will continue here afterward."
      deadline=$((SECONDS + 1800))
      until git --version >/dev/null 2>&1; do
        [ "$SECONDS" -lt "$deadline" ] || die "Command line tools are not ready. Finish Apple's setup, then rerun this installer."
        sleep 5
      done
    fi
    if [ "$need_docker" = yes ] && [ ! -d /Applications/Docker.app ]; then
      # A configured remote or alternate engine must never be replaced by a local Desktop.
      [ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ] || return 0
      approve_prerequisites || return 0
      install_mac_docker
    fi
    problem=$(docker_problem)
    case "$problem" in *"update Docker."*) return 0 ;; esac
    if [ -n "$problem" ] && [ -d /Applications/Docker.app ] && [ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ]; then
      # Respect an existing alternate context even when its engine is unavailable.
      case "$(docker context show 2>/dev/null || true)" in '' | default | desktop-linux) ;; *) return 0 ;; esac
      [ "${PREREQUISITES:-ask}" != no ] || return 0
      open /Applications/Docker.app
      wait_for_docker
    fi
  elif [ -z "$WSL" ] && { [ "$missing" = 1 ] || [ "$need_docker" = yes ]; }; then
    [ "$need_docker" = no ] || [ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ] || return 0
    approve_prerequisites || return 0
    install_linux_prerequisites "$need_docker"
  fi
}

check_prerequisites() {
  local problems="" missing="" tool problem
  [ -n "${PACKAGE_CHANNEL:-}" ] || git --version >/dev/null 2>&1 || missing="git"
  for tool in curl tar gzip df; do
    command -v "$tool" >/dev/null 2>&1 || missing="${missing:+$missing }$tool"
  done
  if [ -n "$missing" ]; then
    if [ "$OS" = macos ]; then
      problems="  - $missing. Install Apple's command line tools: xcode-select --install"$'\n'
    else
      problems="  - $missing. Install with: $(package_hint "$missing")"$'\n'
    fi
  fi
  problem=$(docker_problem)
  [ -z "$problem" ] || problems="$problems  - $problem"$'\n'
  if [ "$OS" = linux ] && ! user_systemd; then
    if [ -n "$WSL" ]; then
      problems="$problems  - systemd. Add these lines to /etc/wsl.conf (sudo nano /etc/wsl.conf), run wsl --shutdown in PowerShell, then open this distro again:"$'\n'"      [boot]"$'\n'"      systemd=true"$'\n'
    else
      problems="$problems  - A systemd user session. Sign in as $(id -un) over SSH or on the desktop (not with su), or run: sudo loginctl enable-linger $(id -un)"$'\n'
    fi
  fi
  if [ "$OS" = linux ] && [ -z "$problems" ]; then
    problem=$(service_docker_problem)
    [ -z "$problem" ] || problems="$problems  - $problem"$'\n'
  fi
  if [ -n "$problems" ]; then
    printf 'localDot needs a few things first:\n%sThen run the installer again.\n' "$problems" >&2
    exit 1
  fi
}

parse_args() {
  OPT_PACKAGE_CHANNEL="" OPT_PACKAGE_VERSION=""
  OPT_REF="" OPT_REPO="" OPT_PORT="" OPT_HOME="" OPT_TAILSCALE="" OPT_REGISTRY="" OPT_VAULT=""
  PREREQUISITES=ask
  SKIP_IMAGES=0 UNINSTALL=0 AS_COMMAND=0
  COMMAND="" COMMAND_ARGS=()
  PREFIX="${LOCALDOT_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/localdot}"
  while [ $# -gt 0 ]; do
    case "$1" in
    --ref | --repo | --port | --home | --prefix | --registry | --package-channel | --package-version)
      [ $# -ge 2 ] || die "$1 needs a value. Run install.sh --help for usage."
      case "$1" in
      --ref) OPT_REF=$2 ;;
      --repo) OPT_REPO=$2 ;;
      --port) OPT_PORT=$2 ;;
      --home) OPT_HOME=$2 ;;
      --prefix) PREFIX=$2 ;;
      --registry) OPT_REGISTRY=$2 ;;
      --package-channel) OPT_PACKAGE_CHANNEL=$2 ;;
      --package-version) OPT_PACKAGE_VERSION=$2 ;;
      esac
      shift 2
      ;;
    --install-prerequisites) [ "$PREREQUISITES" != no ] || die "Choose one prerequisite mode."; PREREQUISITES=yes; shift ;;
    --no-prerequisites) [ "$PREREQUISITES" != yes ] || die "Choose one prerequisite mode."; PREREQUISITES=no; shift ;;
    --tailscale) OPT_TAILSCALE=on && shift ;;
    --no-tailscale) OPT_TAILSCALE=off && shift ;;
    --passphrase-vault) OPT_VAULT=passphrase && shift ;;
    --skip-images) SKIP_IMAGES=1 && shift ;;
    --uninstall) UNINSTALL=1 && shift ;;
    --as-command)
      AS_COMMAND=1
      shift
      COMMAND=${1:-help}
      [ $# -eq 0 ] || shift
      COMMAND_ARGS=("$@")
      return
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1. Run install.sh --help for usage." ;;
    esac
  done
}

read_state() {
  local file="$PREFIX/install.env" line key value
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}
    value=${line#*=}
    value=${value#\"}
    value=${value%\"}
    case "$key" in
    LOCALDOT_REPO) REPO=$value ;;
    LOCALDOT_PACKAGE_CHANNEL) PACKAGE_CHANNEL=$value ;;
    LOCALDOT_REF) REF=$value ;;
    LOCALDOT_HOME) LD_HOME=$value ;;
    LOCALDOT_PORT) PORT=$value ;;
    LOCALDOT_TAILSCALE) TAILSCALE=$value ;;
    LOCALDOT_PUBLIC_ORIGIN) PUBLIC_ORIGIN=$value ;;
    LOCALDOT_REGISTRY) REGISTRY=$value ;;
    LOCALDOT_VAULT) VAULT=$value ;;
    LOCALDOT_COMMIT) BUILT_COMMIT=$value ;;
    esac
  done <"$file"
}

write_state() {
  cat >"$PREFIX/install.env.new" <<EOF
# $MARKER
LOCALDOT_REPO="$REPO"
LOCALDOT_PACKAGE_CHANNEL="$PACKAGE_CHANNEL"
LOCALDOT_REF="$REF"
LOCALDOT_HOME="$LD_HOME"
LOCALDOT_PORT="$PORT"
LOCALDOT_TAILSCALE="$TAILSCALE"
LOCALDOT_PUBLIC_ORIGIN="$PUBLIC_ORIGIN"
LOCALDOT_REGISTRY="$REGISTRY"
LOCALDOT_VAULT="$VAULT"
LOCALDOT_COMMIT="$COMMIT"
EOF
  mv "$PREFIX/install.env.new" "$PREFIX/install.env"
}

# Recorded settings win over the environment, and options win over both.
resolve_settings() {
  REPO=$DEFAULT_REPO REF=$DEFAULT_REF PACKAGE_CHANNEL=$DEFAULT_PACKAGE_CHANNEL
  LD_HOME=${LOCALDOT_HOME:-$HOME/.localdot} PORT=${LOCALDOT_PORT:-4750}
  TAILSCALE=off PUBLIC_ORIGIN="" REGISTRY="" VAULT="" BUILT_COMMIT="" INSTALLED=0
  check_path "The install folder" "$PREFIX"
  if read_state; then INSTALLED=1; fi
  # A published installer must not silently fall back to a private Git checkout on upgrade.
  [ -z "$DEFAULT_PACKAGE_CHANNEL" ] || [ -n "$PACKAGE_CHANNEL" ] || PACKAGE_CHANNEL=$DEFAULT_PACKAGE_CHANNEL
  [ -z "$OPT_PACKAGE_CHANNEL" ] || PACKAGE_CHANNEL=$OPT_PACKAGE_CHANNEL
  # The legacy channel is frozen at the repository-migration release.
  if [ "$PACKAGE_CHANNEL" = https://downloads.localdot.dev/channels/testing.json ]; then
    PACKAGE_CHANNEL=https://downloads.localdot.dev/channels/releases.json
  fi
  case "$PACKAGE_CHANNEL" in
  "" | https://downloads.localdot.dev/channels/releases.json | https://downloads.localdot.dev/channels/stable.json) ;;
  *) die "Use an official localDot package channel." ;;
  esac
  WAS_TAILSCALE=$TAILSCALE OLD_PORT=$PORT
  [ -z "$OPT_REPO" ] || REPO=$OPT_REPO
  [ -z "$OPT_REF" ] || REF=$OPT_REF
  [ -z "$OPT_HOME" ] || LD_HOME=$OPT_HOME
  [ -z "$OPT_PORT" ] || PORT=$OPT_PORT
  [ -z "$OPT_TAILSCALE" ] || TAILSCALE=$OPT_TAILSCALE
  [ -z "$OPT_REGISTRY" ] || REGISTRY=$OPT_REGISTRY
  [ -z "$OPT_VAULT" ] || VAULT=$OPT_VAULT
  case "$VAULT" in
  '' | passphrase) ;;
  *) die "install.env names an unknown key vault: $VAULT" ;;
  esac
  check_path "Your home folder" "$HOME"
  check_path "The data folder" "$LD_HOME"
  case "$PORT" in
  '' | *[!0-9]*) die "--port wants a number from 1024 to 65535." ;;
  esac
  [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "--port wants a number from 1024 to 65535."
  case "$REF" in
  -* | *[!A-Za-z0-9._/-]*) die "--ref wants a branch, tag or commit name: $REF" ;;
  esac
  case "$REPO" in
  '' | -* | *[[:space:]\"]*) die "--repo wants a Git URL or path: $REPO" ;;
  esac
  case "$REGISTRY" in
  *[!a-z0-9.:/_-]*) die "--registry wants a registry and owner such as ghcr.io/owner: $REGISTRY" ;;
  esac
}

set_paths() {
  APP=$PREFIX/app
  RUNTIME=$PREFIX/runtime
  TOOLS=$RUNTIME/bin
  local node_os go_os go_arch
  if [ "$OS" = macos ]; then node_os=darwin go_os=darwin; else node_os=linux go_os=linux; fi
  if [ "$ARCH" = x64 ]; then go_arch=amd64; else go_arch=arm64; fi
  NODE_PLATFORM=$node_os-$ARCH
  GO_PLATFORM=$go_os-$go_arch
  NODE_DIR=$RUNTIME/node-v$NODE_VERSION-$NODE_PLATFORM
  GO_DIR=$RUNTIME/go$GO_VERSION
  LAUNCH_DIR=$HOME/Library/LaunchAgents
  UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  if [ "$OS" = macos ]; then
    KEYD_FILE=$LAUNCH_DIR/$KEYD_LABEL.plist DAEMON_FILE=$LAUNCH_DIR/$DAEMON_LABEL.plist
  else
    KEYD_FILE=$UNIT_DIR/$KEYD_UNIT DAEMON_FILE=$UNIT_DIR/$DAEMON_UNIT
  fi
}

owned() { [ -f "$1" ] && grep -qF "$MARKER" "$1"; }

# Uninstall removes what the installer made in the prefix, so a prefix must be localDot's own: an
# earlier install's, or holding nothing but what an unfinished one left.
check_prefix() {
  [ -e "$PREFIX" ] || return 0
  [ -d "$PREFIX" ] || die "$PREFIX isn't a folder. Choose another one with --prefix."
  ! owned "$PREFIX/install.env" || return 0
  local other
  other=$(cd "$PREFIX" && find . -mindepth 1 -maxdepth 2 \
    ! -path ./app.previous ! -path './app.previous/*' ! -path ./.package-install.lock ! -path './.package-install.lock/*' \
    ! -path ./app ! -path './app/*' ! -path ./app.new ! -path './app.new/*' \
    ! -path ./runtime ! -path './runtime/*' ! -path ./install.env.new ! -path ./bin \
    ! -path ./bin/keyd ! -path ./bin/keyd.new ! -path ./bin/localdot ! -path ./bin/localdot.new \
    -print -quit)
  [ -z "$other" ] || die "$PREFIX already holds other files (such as ${other#./}). localDot needs a folder of its own: choose a new or empty one with --prefix, such as ~/.local/share/localdot."
}

# Removes only what the installer makes, and the prefix itself once nothing else is in it.
remove_installed() {
  rm -rf "$PREFIX/app" "$PREFIX/app.new" "$PREFIX/app.previous" "$PREFIX/runtime"
  rm -f "$PREFIX/install.env" "$PREFIX/install.env.new" "$PREFIX/bin/keyd" "$PREFIX/bin/keyd.new" \
    "$PREFIX/bin/localdot" "$PREFIX/bin/localdot.new"
  rmdir "$PREFIX/bin" 2>/dev/null || true
  rmdir "$PREFIX" 2>/dev/null || true
  [ ! -d "$PREFIX" ] || say "Kept $PREFIX: it holds files localDot didn't make."
}

check_services_are_ours() {
  local file
  for file in "$KEYD_FILE" "$DAEMON_FILE"; do
    if [ -e "$file" ] && ! owned "$file"; then
      die "$file was not made by this installer and may run another copy of localDot. Stop and remove it first, then run the installer again."
    fi
  done
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

check_port() {
  if [ "$INSTALLED" = 1 ] && [ "$PORT" = "$OLD_PORT" ]; then return; fi
  if port_busy "$PORT"; then
    die "Something else is using port $PORT on this computer. Stop it, or choose another port with --port."
  fi
}

sync_source() {
  step "Getting localDot ($REF)"
  local dir=$APP origin
  if [ -d "$APP/.git" ]; then
    origin=$(git -C "$APP" remote get-url origin 2>/dev/null || true)
    [ "$origin" = "$REPO" ] || die "$APP was installed from $origin, not $REPO. Pass --repo $origin to keep using it."
    if [ -n "$(git -C "$APP" status --porcelain --untracked-files=no)" ]; then
      die "Files in $APP were changed by hand. Undo that (git -C $APP stash) and run the installer again."
    fi
  else
    [ ! -e "$APP" ] || die "$APP exists but isn't a localDot checkout. Move it away, or choose another --prefix."
    mkdir -p "$PREFIX"
    dir=$PREFIX/app.new
    rm -rf "$dir"
    git -c init.defaultBranch=main init --quiet "$dir"
    git -C "$dir" remote add origin "$REPO"
  fi
  local target=${LOCALDOT_UPDATE_COMMIT:-$REF}
  if [ -n "${LOCALDOT_UPDATE_COMMIT:-}" ]; then
    [[ "$LOCALDOT_UPDATE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Invalid prepared update."
  fi
  git -C "$dir" fetch --quiet --depth 1 origin "$target" || die "Couldn't get $REF from $REPO."
  git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
  [ "$dir" = "$APP" ] || mv "$dir" "$APP"
  [ -f "$APP/install.sh" ] || die "localDot $REF has no installer. Choose a newer version with --ref."
}

install_archive() {
  local url=$1 sum=$2 destination=$3 work=$RUNTIME/.download
  rm -rf "$work"
  mkdir -p "$work/out"
  curl -fL --retry 3 -o "$work/archive.tar.gz" "$url" || die "Couldn't download $url."
  say "Download complete. Verifying the archive..."
  if [ "$(sha256_of "$work/archive.tar.gz")" != "$sum" ]; then
    rm -rf "$work"
    die "The download from $url doesn't match its pinned checksum, so nothing was installed."
  fi
  say "Verified. Extracting the runtime..."
  tar -xzf "$work/archive.tar.gz" -C "$work/out" --strip-components 1
  rm -rf "$destination"
  mv "$work/out" "$destination"
  rm -rf "$work"
}

remove_other_versions() {
  local keep=$1 old
  shift
  for old in "$@"; do
    [ ! -e "$old" ] || [ "$old" = "$keep" ] || rm -rf "$old"
  done
}

ensure_node() {
  if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    step "Getting Node.js $NODE_VERSION"
    mkdir -p "$RUNTIME"
    install_archive "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_PLATFORM.tar.gz" \
      "$(node_sha256 "$NODE_PLATFORM")" "$NODE_DIR"
    [ -n "${PACKAGE_CHANNEL:-}" ] || remove_other_versions "$NODE_DIR" "$RUNTIME"/node-v*
  fi
  [ -z "${PACKAGE_CHANNEL:-}" ] || return 0
  mkdir -p "$TOOLS"
  [ -x "$TOOLS/pnpm" ] || tools corepack enable --install-directory "$TOOLS" pnpm ||
    die "Couldn't set up pnpm with Node.js's corepack."
}

ensure_go() {
  case "$("$GO_DIR/bin/go" version 2>/dev/null || true)" in
  *"go$GO_VERSION "*) return ;;
  esac
  step "Getting Go $GO_VERSION to build the key service"
  install_archive "https://go.dev/dl/go$GO_VERSION.$GO_PLATFORM.tar.gz" "$(go_sha256 "$GO_PLATFORM")" "$GO_DIR"
  remove_other_versions "$GO_DIR" "$RUNTIME"/go1.*
}

tools() {
  PATH="$TOOLS:$NODE_DIR/bin:$GO_DIR/bin:$PATH" COREPACK_HOME="$RUNTIME/corepack" \
    GOTOOLCHAIN=local GOPATH="$RUNTIME/gopath" GOCACHE="$RUNTIME/gocache" GOFLAGS=-modcacherw \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_AUTO_PIN=0 npm_config_update_notifier=false "$@"
}

build_app() {
  DAEMON_CHANGED=0
  [ "$COMMIT" != "$BUILT_COMMIT" ] || [ ! -f "$APP/apps/web/dist/index.html" ] || return 0
  step "Building localDot"
  (cd "$APP" && tools pnpm install --frozen-lockfile --config.confirmModulesPurge=false \
    --store-dir "$RUNTIME/pnpm-store" &&
    tools pnpm --filter @localdot/web build) || die "The build failed; see the messages above."
  DAEMON_CHANGED=1
}

build_keyd() {
  KEYD_CHANGED=0
  local binary=$PREFIX/bin/keyd
  [ "$COMMIT" != "$BUILT_COMMIT" ] || [ ! -x "$binary" ] || return 0
  grep -q "^toolchain go$GO_VERSION\$" "$APP/keyd/go.mod" ||
    die "This installer pins Go $GO_VERSION, but this version of the key service wants another. Use the install.sh from the same version."
  ensure_go
  step "Building the key service"
  mkdir -p "$PREFIX/bin"
  (cd "$APP/keyd" && GOTOOLCHAIN=local GOPATH="$RUNTIME/gopath" GOCACHE="$RUNTIME/gocache" \
    GOFLAGS=-modcacherw "$GO_DIR/bin/go" build -trimpath -buildvcs=false -o "$binary.new" ./cmd/keyd) ||
    die "Building the key service failed; see the messages above."
  # The same key service from a newer version is left running, so its vault stays unlocked.
  if [ -x "$binary" ] && cmp -s "$binary" "$binary.new"; then
    rm -f "$binary.new"
  else
    mv "$binary.new" "$binary"
    KEYD_CHANGED=1
  fi
}

images_present() {
  local role
  for role in $IMAGE_ROLES; do
    docker image inspect "localdot/$role:dev" >/dev/null 2>&1 || return 1
  done
}

# Commit tags are mutable and nothing here checks an image against the source, so --registry
# trusts that registry with the computers.
pull_image() {
  local remote="$REGISTRY/localdot-$1:$COMMIT"
  docker pull "$remote" && docker tag "$remote" "localdot/$1:dev"
}

prepare_images() {
  [ "$SKIP_IMAGES" = 0 ] || return 0
  if [ "$COMMIT" = "$BUILT_COMMIT" ] && images_present; then return; fi
  step "Preparing the computer images (the first build takes 10 to 30 minutes)"
  local role
  for role in $IMAGE_ROLES; do
    if [ -n "$REGISTRY" ]; then
      if pull_image "$role"; then continue; fi
      say "No published $role image for this version, so it is built here."
    fi
    # The gate compiles ldgate on the host. Keyd may already be built on a retry,
    # so ensure the managed compiler exists even when build_keyd skipped its build.
    if [ "$role" = gate ]; then ensure_go; fi
    say "Building the $role image"
    (cd "$APP" && run_setup_stage "$role" tools bash "cells/$role/build.sh") || return $?
  done
}

# Keep the original build output in the terminal, but persist only a classified diagnostic:
# build output may contain registry credentials or signed URLs. Never log it verbatim.
run_setup_stage() {
  local role=$1 capture code=0 reason recovery
  shift
  capture=$(mktemp "$RUNTIME/.image-build.XXXXXX") || return 1
  chmod 600 "$capture"
  "$@" 2>&1 | awk -v diagnostic="$capture" '
    { print; fflush(); line=tolower($0)
      if (line ~ /read-only file system/) print "read-only file system" >> diagnostic
      if (line ~ /no space left on device|disk quota exceeded|not enough space/) print "no space left on device" >> diagnostic
      if (line ~ /permission denied|access is denied/) print "permission denied" >> diagnostic
      if (line ~ /could not resolve|temporary failure resolving|connection timed out|tls handshake timeout/) print "could not resolve" >> diagnostic
      close(diagnostic)
    }' || code=$?
  if [ "$code" = 0 ]; then rm -f "$capture"; return 0; fi
  reason="image-build-failed"
  recovery="Read the build output above, fix the reported issue, then rerun the same installer."
  if grep -qi 'read-only file system' "$capture"; then
    reason="docker-storage-read-only"
    recovery="Docker storage is read-only. Check free space on the disk holding Docker data, then restart Docker and rerun setup. If it persists, collect Docker diagnostics. Do not reset Docker or delete its data."
  elif grep -qiE 'no space left on device|disk quota exceeded|not enough space' "$capture"; then
    reason="docker-storage-full"
    recovery="Docker ran out of storage. Check both the host disk and Docker disk allocation, free space without deleting your computer data, then rerun setup."
  elif grep -qiE 'permission denied|access is denied' "$capture"; then
    reason="docker-permission-denied"
    recovery="The image build was denied access. Check Docker access for your user and the denied path printed above, then rerun setup."
  elif grep -qiE 'could not resolve|temporary failure resolving|connection timed out|TLS handshake timeout' "$capture"; then
    reason="image-download-unavailable"
    recovery="An image dependency could not be downloaded. Check your connection, DNS and proxy settings, then rerun setup; Docker keeps completed layers."
  fi
  rm -f "$capture"
  (umask 077; printf 'stage=image-%s\ncode=%s\nreason=%s\n' "$role" "$code" "$reason" > "$RUNTIME/install-failure.txt")
  printf '\nCould not prepare the %s image: %s\n%s\nDiagnostic: %s/install-failure.txt\n' "$role" "$reason" "$recovery" "$RUNTIME" >&2
  return "$code"
}

check_docker_storage() {
  local probe tag code=0
  probe=$(mktemp -d "$RUNTIME/.storage-probe.XXXXXX") || return 1
  tag="localdot-install-probe:$(basename "$probe" | tr '[:upper:]' '[:lower:]' | tr -d '.')"
  printf 'FROM scratch\nCOPY marker /localdot-storage-probe\n' > "$probe/Dockerfile"
  printf 'localDot installation storage check\n' > "$probe/marker"
  step "Checking Docker can write an image layer"
  run_setup_stage storage-check with_timeout 60 docker build --label localdot.install-probe=true -q -t "$tag" "$probe" || code=$?
  # Remove only this invocation's random tag; never prune shared Docker resources.
  with_timeout 10 docker image rm "$tag" >/dev/null 2>&1 || true
  rm -rf "$probe"
  [ "$code" = 0 ] || return "$code"
  say "Docker storage is writable now. Downloads can still fail if storage fills later."
}

check_install_storage() {
  local available
  available=$(LC_ALL=C df -Pk "$PREFIX" | awk 'NR == 2 { print $4 }') ||
    die "Could not measure the installation filesystem. Check its mount and free space before retrying."
  case "$available" in
    '' | *[!0-9]*) die "Could not read the installation filesystem's available space." ;;
  esac
  [ "$available" -gt 0 ] || die "The installation filesystem has no free space. Free space, then rerun setup."
  printf 'Installation filesystem available: %s KiB.\n' "$available"
  [ -n "${PACKAGE_CHANNEL:-}" ] || say "Source-build peak usage is not yet measured."
  if [ -n "$WSL" ]; then
    say "This is Ubuntu's filesystem space, not Windows physical disk space. Check free space on the Windows drive holding Docker/WSL data too."
  else
    say "Docker may store its data on another disk; its free space is a separate requirement."
  fi
}

tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    say /Applications/Tailscale.app/Contents/MacOS/Tailscale
  else
    return 1
  fi
}

# Tailscale Serve puts an HTTPS name on this computer that only your own tailnet devices can
# reach. Funnel, which would publish it to the internet, is never used.
setup_tailscale() {
  step "Setting up Tailscale Serve"
  local ts status name log=$RUNTIME/tailscale.log
  ts=$(tailscale_cli) || die "Tailscale isn't installed. Install it from https://tailscale.com/download, sign in, then run the installer again."
  status=$("$ts" status --json 2>/dev/null | tr -d ' \t\n') || true
  case "$status" in
  *'"BackendState":"Running"'*) ;;
  *) die "Tailscale isn't connected. Sign in with: tailscale up, then run the installer again." ;;
  esac
  name=$(printf '%s' "$status" | sed -n 's/.*"CertDomains":\["\([a-z0-9.-]*\)".*/\1/p')
  [ -n "$name" ] || die "Your tailnet has no HTTPS certificates yet. Turn on MagicDNS and HTTPS Certificates at https://login.tailscale.com/admin/dns, then run the installer again."
  mkdir -p "$RUNTIME"
  if ! with_timeout 180 "$ts" serve --bg --https="$PORT" "http://127.0.0.1:$PORT" 2>&1 | tee "$log"; then
    if grep -qi "denied\|operator\|permission" "$log"; then
      die "Tailscale needs your permission to serve. Run: sudo tailscale set --operator=$(id -un), then run the installer again."
    fi
    die "Tailscale Serve didn't start; see its message above."
  fi
  if [ "$PORT" = 443 ]; then PUBLIC_ORIGIN="https://$name"; else PUBLIC_ORIGIN="https://$name:$PORT"; fi
}

stop_tailscale() {
  local ts
  ts=$(tailscale_cli) || return 0
  "$ts" serve --https="$1" off >/dev/null 2>&1 || warn "Couldn't turn off Tailscale Serve on port $1. Check it with: tailscale serve status"
}

configure_remote_access() {
  if [ "$TAILSCALE" = on ]; then
    [ "$WAS_TAILSCALE" != on ] || [ "$OLD_PORT" = "$PORT" ] || stop_tailscale "$OLD_PORT"
    setup_tailscale
  else
    [ "$WAS_TAILSCALE" != on ] || stop_tailscale "$OLD_PORT"
    PUBLIC_ORIGIN=""
  fi
}

service_path() {
  local docker_dir
  docker_dir=$(command -v docker 2>/dev/null || true)
  docker_dir=${docker_dir%/*}
  case "$docker_dir" in
  *[!A-Za-z0-9._/@+,:~-]*) docker_dir="" ;;
  esac
  say "$NODE_DIR/bin${docker_dir:+:$docker_dir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

daemon_environment() {
  printf '%s\n' "HOME=$HOME" "PATH=$(service_path)" "LOCALDOT_HOME=$LD_HOME" "LOCALDOT_PORT=$PORT" "LOCALDOT_INSTALL_PREFIX=$PREFIX"
  [ -z "$PUBLIC_ORIGIN" ] || say "LOCALDOT_PUBLIC_ORIGIN=$PUBLIC_ORIGIN"
  [ -z "${DOCKER_HOST:-}" ] || say "DOCKER_HOST=$DOCKER_HOST"
  if [ -n "${PACKAGE_CHANNEL:-}" ]; then
    "$NODE_DIR/bin/node" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for(const [role,pin] of Object.entries(r.images)) console.log("LOCALDOT_"+role.toUpperCase()+"_IMAGE="+pin)' "$APP/package-release.json"
  fi
}

systemd_units() {
  local environment="" line vault="" daemon_args='"--import" "tsx" "src/main.ts"' working=$APP/apps/daemon
  if [ -n "${PACKAGE_CHANNEL:-}" ]; then daemon_args='"dist/daemon.mjs"'; working=$APP; fi
  [ "$VAULT" != passphrase ] || vault=' "-vault" "passphrase"'
  while IFS= read -r line; do environment="$environment"$'\n'"Environment=\"$line\""; done <<EOF
$(daemon_environment)
EOF
  KEYD_CONTENT="# $MARKER
[Unit]
Description=localDot key service

[Service]
Type=exec
ExecStart=\"$PREFIX/bin/keyd\" \"-home\" \"$LD_HOME\"$vault
UMask=0077
Restart=on-failure
RestartSec=5
StandardOutput=append:$LD_HOME/logs/keyd.log
StandardError=append:$LD_HOME/logs/keyd.log

[Install]
WantedBy=default.target"
  DAEMON_CONTENT="# $MARKER
[Unit]
Description=localDot
Wants=$KEYD_UNIT
After=$KEYD_UNIT

[Service]
Type=exec
WorkingDirectory=$working$environment
ExecStart=\"$NODE_DIR/bin/node\" $daemon_args
SuccessExitStatus=143
UMask=0077
Restart=on-failure
RestartSec=5
StandardOutput=append:$LD_HOME/logs/daemon.log
StandardError=append:$LD_HOME/logs/daemon.log

[Install]
WantedBy=default.target"
}

plist() {
  local label=$1 log=$2 arguments="" environment="" argument line working=$APP/apps/daemon
  [ -z "${PACKAGE_CHANNEL:-}" ] || working=$APP
  shift 2
  for argument in "$@"; do arguments="$arguments"$'\n'"    <string>$argument</string>"; done
  if [ "$label" = "$DAEMON_LABEL" ]; then
    while IFS= read -r line; do
      environment="$environment"$'\n'"    <key>${line%%=*}</key><string>${line#*=}</string>"
    done <<EOF
$(daemon_environment)
EOF
    environment="
  <key>EnvironmentVariables</key>
  <dict>$environment
  </dict>
  <key>WorkingDirectory</key><string>$working</string>"
  fi
  say "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<!-- $MARKER -->
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>$arguments
  </array>$environment
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$LD_HOME/logs/$log.log</string>
  <key>StandardErrorPath</key><string>$LD_HOME/logs/$log.log</string>
</dict>
</plist>"
}

# Writes a service file when its content changed; returns 1 when it was already current.
put_service_file() {
  local file=$1 content=$2
  if [ -f "$file" ] && [ "$(cat "$file")" = "$content" ]; then return 1; fi
  mkdir -p "${file%/*}"
  printf '%s\n' "$content" >"$file.new"
  mv "$file.new" "$file"
}

write_services() {
  if [ "$OS" = macos ]; then
    # Without the signed release, keyd can't use the Keychain; a passphrase protects the keys.
    KEYD_CONTENT=$(plist "$KEYD_LABEL" keyd "$PREFIX/bin/keyd" -home "$LD_HOME" -vault file)
    if [ -n "${PACKAGE_CHANNEL:-}" ]; then
      DAEMON_CONTENT=$(plist "$DAEMON_LABEL" daemon "$NODE_DIR/bin/node" dist/daemon.mjs)
    else
      DAEMON_CONTENT=$(plist "$DAEMON_LABEL" daemon "$NODE_DIR/bin/node" --import tsx src/main.ts)
    fi
  else
    systemd_units
  fi
  (umask 077 && mkdir -p "$LD_HOME/logs")
  if put_service_file "$KEYD_FILE" "$KEYD_CONTENT"; then KEYD_CHANGED=1; fi
  if put_service_file "$DAEMON_FILE" "$DAEMON_CONTENT"; then DAEMON_CHANGED=1; fi
}

launchd_loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }

load_agent() {
  local label=$1 restart=$2 domain tries=0
  domain="gui/$(id -u)"
  if launchd_loaded "$label"; then
    [ "$restart" = 1 ] || return 0
    launchctl bootout "$domain/$label" 2>/dev/null || true
    while launchd_loaded "$label" && [ $tries -lt 20 ]; do
      sleep 0.5
      tries=$((tries + 1))
    done
  fi
  tries=0
  until launchctl bootstrap "$domain" "$LAUNCH_DIR/$label.plist"; do
    tries=$((tries + 1))
    [ $tries -lt 5 ] || die "macOS didn't start $label. Sign in to this Mac's desktop, then run: localdot up"
    sleep 1
  done
}

ensure_linger() {
  local user
  user=$(id -un)
  [ "$(loginctl show-user "$user" --property=Linger --value 2>/dev/null || true)" != yes ] || return 0
  loginctl enable-linger "$user" 2>/dev/null ||
    warn "localDot stops when you sign out. To keep it running, run: sudo loginctl enable-linger $user"
}

# This setting changes future starts only. It never interrupts the running service.
startup_preference() {
  if [ -f "$PREFIX/start-at-login" ]; then cat "$PREFIX/start-at-login"; else say on; fi
}
set_startup_preference() {
  local value=${1:-status} label
  case "$value" in
    status) startup_preference; return ;;
    on|off) ;;
    *) die "Usage: localdot start-at-login on|off|status" ;;
  esac
  owned "$KEYD_FILE" && owned "$DAEMON_FILE" || die "Startup services are missing. Rerun the localDot installer to repair them."
  if [ "$OS" = macos ]; then
    for label in "$KEYD_LABEL" "$DAEMON_LABEL"; do
      if [ "$value" = on ]; then launchctl enable "gui/$(id -u)/$label"
      else launchctl disable "gui/$(id -u)/$label"; fi
    done
  else
    user_systemd || die "Your user services are unavailable. Sign in again, then retry."
    if [ "$value" = on ]; then systemctl --user enable --quiet "$KEYD_UNIT" "$DAEMON_UNIT"
    else systemctl --user disable --quiet "$KEYD_UNIT" "$DAEMON_UNIT"; fi
  fi
  (umask 077; printf '%s\n' "$value" > "$PREFIX/start-at-login.new")
  mv "$PREFIX/start-at-login.new" "$PREFIX/start-at-login"
  say "$value"
}

start_services() {
  if [ "$OS" = macos ]; then
    launchctl enable "gui/$(id -u)/$KEYD_LABEL"
    launchctl enable "gui/$(id -u)/$DAEMON_LABEL"
    load_agent "$KEYD_LABEL" "$1"
    load_agent "$DAEMON_LABEL" "$2"
    if [ "$(startup_preference)" = off ]; then set_startup_preference off >/dev/null; fi
    return
  fi
  user_systemd || true
  systemctl --user daemon-reload
  if [ "$(startup_preference)" = on ]; then
    systemctl --user enable --quiet "$KEYD_UNIT" "$DAEMON_UNIT"
  else
    systemctl --user disable --quiet "$KEYD_UNIT" "$DAEMON_UNIT"
  fi
  if [ "$1" = 1 ]; then systemctl --user restart "$KEYD_UNIT"; else systemctl --user start "$KEYD_UNIT"; fi
  if [ "$2" = 1 ]; then systemctl --user restart "$DAEMON_UNIT"; else systemctl --user start "$DAEMON_UNIT"; fi
  ensure_linger
}

stop_services() {
  if [ "$OS" = macos ]; then
    launchctl bootout "gui/$(id -u)/$DAEMON_LABEL" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/$KEYD_LABEL" 2>/dev/null || true
  else
    user_systemd || true
    systemctl --user stop "$DAEMON_UNIT" "$KEYD_UNIT" 2>/dev/null || true
  fi
}

remove_services() {
  owned "$DAEMON_FILE" || owned "$KEYD_FILE" || return 0
  stop_services
  if [ "$OS" = linux ]; then
    systemctl --user disable --quiet "$DAEMON_UNIT" "$KEYD_UNIT" 2>/dev/null || true
  fi
  if owned "$DAEMON_FILE"; then rm -f "$DAEMON_FILE"; fi
  if owned "$KEYD_FILE"; then rm -f "$KEYD_FILE"; fi
  if [ "$OS" = linux ]; then systemctl --user daemon-reload 2>/dev/null || true; fi
}

# Configure shells as well as creating the executable. A piped installer cannot change the
# parent terminal's environment, so finish also prints a command for that current terminal.
install_command_path() {
  local file login zdir=${ZDOTDIR:-$HOME}
  mkdir -p "$zdir"
  login=$HOME/.profile
  if [ -f "$HOME/.bash_profile" ]; then login=$HOME/.bash_profile
  elif [ -f "$HOME/.bash_login" ]; then login=$HOME/.bash_login; fi
  for file in "$zdir/.zprofile" "$zdir/.zshrc" "$HOME/.bashrc" "$login"; do
    if ! grep -qF '# localDot command path' "$file" 2>/dev/null; then
      cat >>"$file" <<'PATH_CONFIG'

# localDot command path
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
PATH_CONFIG
    fi
  done
  if [ "${SHELL##*/}" = fish ]; then
    file=${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/localdot.fish
    mkdir -p "${file%/*}"
    if [ ! -e "$file" ]; then
      printf '%s\n' '# localDot command path' 'contains -- "$HOME/.local/bin" $PATH; or set -gx PATH "$HOME/.local/bin" $PATH' >"$file"
    fi
  fi
}

install_command() {
  local shim=$PREFIX/bin/localdot link=$HOME/.local/bin/localdot
  mkdir -p "$PREFIX/bin" "${link%/*}"
  cat >"$shim.new" <<EOF
#!/bin/sh
# $MARKER
exec "$BASH" "$APP/install.sh" --prefix "$PREFIX" --as-command "\$@"
EOF
  chmod 755 "$shim.new"
  mv "$shim.new" "$shim"
  if [ ! -e "$link" ] && [ ! -L "$link" ] || [ "$(readlink "$link" 2>/dev/null || true)" = "$shim" ]; then
    ln -sfn "$shim" "$link"
    install_command_path
  else
    warn "$link is another program, so this one stays at $shim."
  fi
}

cli() {
  if [ -n "${PACKAGE_CHANNEL:-}" ]; then
    (cd "$APP"
      while IFS= read -r line; do case "$line" in LOCALDOT_*_IMAGE=*) export "$line" ;; esac; done <<EOF
$(daemon_environment)
EOF
      LOCALDOT_HOME="$LD_HOME" LOCALDOT_PORT="$PORT" LOCALDOT_PUBLIC_ORIGIN="$PUBLIC_ORIGIN" "$NODE_DIR/bin/node" dist/cli.mjs "$@")
    return
  fi
  (cd "$APP/apps/daemon" && LOCALDOT_HOME="$LD_HOME" LOCALDOT_PORT="$PORT" \
    LOCALDOT_PUBLIC_ORIGIN="$PUBLIC_ORIGIN" "$NODE_DIR/bin/node" --import tsx ../cli/src/main.ts "$@")
}

wait_ready() {
  local tries=0 started=$SECONDS notice=$((SECONDS + 15))
  say "Checking that localDot is responding..."
  until curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; do
    tries=$((tries + 1))
    if [ "$SECONDS" -ge "$notice" ]; then
      say "Waiting for localDot to respond ($((SECONDS - started)) seconds)."
      notice=$((SECONDS + 15))
    fi
    if [ $tries -ge 60 ]; then
      tail -n 20 "$LD_HOME/logs/daemon.log" >&2 2>/dev/null || true
      die "localDot could not start. Check the error above, then retry with: localdot up"
    fi
    sleep 1
  done
}

has_terminal() { (exec </dev/tty) 2>/dev/null; }

offer_unlock() {
  has_terminal || return 0
  local tries=0
  while [ ! -S "$LD_HOME/keyd/admin.sock" ] && [ $tries -lt 20 ]; do
    sleep 1
    tries=$((tries + 1))
  done
  cli unlock </dev/tty || warn "Your saved keys are still locked. Run: localdot unlock"
}

remote_session() { [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; }

# The command that opens a link in a browser on this computer's own screen, if it has one.
local_browser() {
  remote_session && return 1
  if [ "$OS" = macos ]; then
    say open
  elif [ -n "$WSL" ] && command -v explorer.exe >/dev/null 2>&1; then
    say explorer.exe
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    say xdg-open
  else
    return 1
  fi
}

show_link() {
  local browser out link
  # Always leave a usable link in the terminal, even if the browser opener silently fails.
  # WSL is local to Windows: missing explorer.exe does not mean this is an SSH-only server.
  if [ -n "$WSL" ] && ! remote_session; then
    out=$(cli open) || die "Couldn't make a sign-in link. Run: localdot open"
    link=${out%%$'\n'*}
    say "Open localDot (within a minute; this link works once):"
    say "  $link"
    if browser=$(local_browser); then
      "$browser" "$link" >/dev/null 2>&1 || true
      say "If your Windows browser did not open, use the link above."
    fi
    say "For a fresh link from PowerShell: wsl -d ${WSL_DISTRO_NAME:-Ubuntu} -- ~/.local/bin/localdot open"
    return
  fi
  if ! browser=$(local_browser); then
    if [ -n "$PUBLIC_ORIGIN" ]; then
      cli open --qr || die "Couldn't make a sign-in link. Run: localdot open"
      return
    fi
    out=$(cli open) || die "Couldn't make a sign-in link. Run: localdot open"
    say "This computer has no screen to open localDot on. To use it from your own computer:"
    say "  1. On your computer, run: ssh -N -L $PORT:127.0.0.1:$PORT $(id -un)@<this computer>"
    say "  2. Open this link there within a minute (it works once): ${out%%$'\n'*}"
    say "     For a fresh link later, run here: localdot open"
    say "To use localDot from any of your devices, phone included, run the installer again with --tailscale."
    return
  fi
  out=$(cli open) || die "Couldn't make a sign-in link. Run: localdot open"
  link=${out%%$'\n'*}
  say "Open localDot (within a minute; this link works once):"
  say "  $link"
  # explorer.exe reports failure even when it opened the link.
  "$browser" "$link" >/dev/null 2>&1 || true
  say "If your browser did not open, use the link above."
  [ -z "$PUBLIC_ORIGIN" ] || say "For your phone or another computer, run: localdot open --qr"
}

finish() {
  wait_ready
  offer_unlock
  step "Checking the installation"
  local diagnostic=0
  cli doctor || diagnostic=$?
  case "$diagnostic" in
  0) ;;
  2) say "localDot is installed. Before starting a task, choose or unlock your vault passphrase:"
     say "  localdot unlock"
     say "The vault must be unlocked before dot can use your saved keys." ;;
  *) die "Installation checks failed. Setup is not complete. Your data is kept; run localdot doctor, fix the reported checks, then rerun setup." ;;
  esac
  step "Sign in"
  show_link
  case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "The localdot command is ready in new terminals. To use it in this terminal now:"
     say '  export PATH="$HOME/.local/bin:$PATH"' ;;
  esac
}

run_install() {
  detect_platform
  resolve_settings
  check_prefix
  set_paths
  check_services_are_ours
  if [ -n "$PACKAGE_CHANNEL" ]; then run_package_install; return; fi
  prepare_prerequisites
  check_prerequisites
  check_port
  if [ "${LOCALDOT_UPDATE_SHUTDOWN:-}" = 1 ]; then
    # Only the explicitly confirmed UI install sets this. Checks/downloads never stop services.
    stop_services
    unset LOCALDOT_UPDATE_SHUTDOWN
  fi
  if [ "${LOCALDOT_INSTALL_STAGE:-}" != checked-out ] || [ ! -d "$APP/.git" ]; then
    sync_source
    # Continue with the installer of the version just checked out, so its pins match its code.
    LOCALDOT_INSTALL_STAGE=checked-out exec "$BASH" "$APP/install.sh" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
  fi
  unset LOCALDOT_INSTALL_STAGE
  COMMIT=$(git -C "$APP" rev-parse HEAD)
  check_install_storage
  ensure_node
  rm -f "$RUNTIME/install-failure.txt"
  if [ "$SKIP_IMAGES" = 0 ] && { [ "$COMMIT" != "$BUILT_COMMIT" ] || ! images_present; }; then
    check_docker_storage
  fi
  build_app
  build_keyd
  configure_remote_access
  prepare_images
  step "Starting localDot"
  write_services
  install_command
  start_services "$KEYD_CHANGED" "$DAEMON_CHANGED"
  write_state
  finish
}

run_uninstall() {
  detect_platform
  resolve_settings
  set_paths
  if [ "$INSTALLED" = 0 ] && ! owned "$DAEMON_FILE" && ! owned "$KEYD_FILE"; then
    say "localDot isn't installed in $PREFIX."
    return
  fi
  step "Removing localDot"
  remove_services
  [ "$TAILSCALE" != on ] || stop_tailscale "$PORT"
  local link=$HOME/.local/bin/localdot
  if [ "$(readlink "$link" 2>/dev/null || true)" = "$PREFIX/bin/localdot" ]; then rm -f "$link"; fi
  remove_installed
  say "Removed localDot. Your data is still in $LD_HOME; to delete it too: rm -rf $LD_HOME"
  say "Computers and their images stay in Docker. To remove them (and those of any other localDot on this Docker):"
  say "  docker rm -f \$(docker ps -aq --filter label=localdot.role)"
  say "  docker volume rm \$(docker volume ls -q --filter label=localdot.role)"
  say "  docker image rm localdot/desktop:dev localdot/browser:dev localdot/brain:dev localdot/gate:dev"
}

run_command() {
  case "$COMMAND" in
  help | -h | --help)
    command_usage
    return
    ;;
  update)
    ORIGINAL_ARGS=(--prefix "$PREFIX" ${COMMAND_ARGS[@]+"${COMMAND_ARGS[@]}"})
    parse_args "${ORIGINAL_ARGS[@]}"
    run_install
    return
    ;;
  uninstall)
    run_uninstall
    return
    ;;
  esac
  detect_platform
  resolve_settings
  set_paths
  [ "$INSTALLED" = 1 ] || die "localDot isn't installed in $PREFIX."
  case "$COMMAND" in
  up)
    start_services 0 0
    wait_ready
    show_link
    ;;
  down) stop_services; cli stop --computers ;;
  start-at-login) set_startup_preference "${COMMAND_ARGS[@]:-status}" ;;
  restart)
    stop_services
    start_services 0 0
    wait_ready
    ;;
  logs)
    case "${COMMAND_ARGS[*]-}" in
    "") tail -n 100 "$LD_HOME/logs/daemon.log" "$LD_HOME/logs/keyd.log" ;;
    --follow) tail -n 20 -F "$LD_HOME/logs/daemon.log" "$LD_HOME/logs/keyd.log" ;;
    *) die "Usage: localdot logs [--follow]" ;;
    esac
    ;;
  open | doctor | unlock | stop | reset-computer) cli "$COMMAND" ${COMMAND_ARGS[@]+"${COMMAND_ARGS[@]}"} ;;
  *)
    printf 'Unknown command: %s\n\n' "$COMMAND" >&2
    command_usage >&2
    exit 2
    ;;
  esac
}

# Public testing releases use the same prerequisite, service and data-directory handling as
# developer installs. Only immutable, signed, already-built payloads enter this path.
prepare_package() {
  mkdir -p "$RUNTIME"
  local bootstrap=$APP/dist/package-bootstrap.mjs scratch
  # Use only the verifier pinned by this installer, including when upgrading older installs.
  if [ ! -f "$bootstrap" ] || [ -z "$PACKAGE_BOOTSTRAP_SHA256" ] || [ "$(sha256_of "$bootstrap")" != "$PACKAGE_BOOTSTRAP_SHA256" ]; then
    [ -n "$PACKAGE_BOOTSTRAP_SHA256" ] || die "This installer has no packaged bootstrap. Download it from https://downloads.localdot.dev/install.sh."
    bootstrap=$RUNTIME/bootstrap.mjs
    curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 30 --max-time 120 \
      "https://downloads.localdot.dev/bootstrap/$PACKAGE_BOOTSTRAP_SHA256.mjs" -o "$bootstrap.new" || die "Couldn't download the installer. Rerun the same command to try again."
    [ "$(sha256_of "$bootstrap.new")" = "$PACKAGE_BOOTSTRAP_SHA256" ] || die "Installer checksum did not match. Nothing was installed."
    mv "$bootstrap.new" "$bootstrap"
  fi
  scratch=$(mktemp -d "$RUNTIME/.package.XXXXXX")
  PACKAGE_SCRATCH=$scratch
  # A failed or interrupted attempt owns only its private staging directory.
  if ! "$NODE_DIR/bin/node" "$bootstrap" prepare "$PACKAGE_CHANNEL" "$NODE_PLATFORM" "$scratch" "$scratch/app" "$OPT_PACKAGE_VERSION"; then
    rm -rf "$scratch"
    die "The packaged download could not be prepared. Your existing app and computer data are kept."
  fi
  PACKAGE_STAGE=$scratch/app
  COMMIT=$("$NODE_DIR/bin/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit' "$PACKAGE_STAGE/package-release.json")
  step "Downloading the computer images"
  local role image
  for role in $IMAGE_ROLES; do
    image=$("$NODE_DIR/bin/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).images[process.argv[2]]' "$PACKAGE_STAGE/package-release.json" "$role")
    step "Computer image: $role (Docker shows progress for each layer)"
    docker pull "$image" || die "Couldn't download the $role image. Rerun setup to reuse completed downloads; the current app is kept."
  done
}

rollback_package() {
  [ "${PACKAGE_PENDING:-0}" = 1 ] || return 0
  PACKAGE_PENDING=0
  warn "The new app did not finish starting. Restoring the previous installation; your computer data is kept."
  stop_services
  if [ "${PACKAGE_ACTIVE:-0}" = 1 ]; then mv "$APP" "$PACKAGE_ROLLBACK/failed-app"; fi
  if [ "${PACKAGE_MOVED:-0}" = 1 ]; then mv "$PREFIX/app.previous" "$APP"; fi
  local name file
  for name in keyd daemon state binary; do
    case "$name" in keyd) file=$KEYD_FILE ;; daemon) file=$DAEMON_FILE ;; state) file=$PREFIX/install.env ;; binary) file=$PREFIX/bin/keyd ;; esac
    if [ -f "$PACKAGE_ROLLBACK/$name" ]; then cp -p "$PACKAGE_ROLLBACK/$name" "$file"; else rm -f "$file"; fi
  done
  if [ -f "$PACKAGE_ROLLBACK/state" ]; then start_services 1 1 || warn "Run localdot up to start the restored app."; fi
}

package_exit() {
  local result=$?
  trap - EXIT
  set +e
  rollback_package
  [ -z "${PACKAGE_SCRATCH:-}" ] || rm -rf "$PACKAGE_SCRATCH"
  rm -f "$PREFIX/.package-install.lock/pid"
  rmdir "$PREFIX/.package-install.lock" 2>/dev/null || true
  exit "$result"
}

activate_package() {
  # No service is stopped until all app files and all images have verified and downloaded.
  # Keep one complete previous installation for rollback. Computer volumes are never touched.
  local backup=$PREFIX/app.previous scratch=${PACKAGE_STAGE%/app} name file
  PACKAGE_ROLLBACK=$(mktemp -d "$RUNTIME/.rollback.XXXXXX")
  for name in keyd daemon state binary; do
    case "$name" in keyd) file=$KEYD_FILE ;; daemon) file=$DAEMON_FILE ;; state) file=$PREFIX/install.env ;; binary) file=$PREFIX/bin/keyd ;; esac
    [ ! -f "$file" ] || cp -p "$file" "$PACKAGE_ROLLBACK/$name"
  done
  if [ -e "$backup" ]; then rm -rf "$backup"; fi
  PACKAGE_PENDING=1 PACKAGE_MOVED=0 PACKAGE_ACTIVE=0
  stop_services
  if [ -d "$APP" ]; then mv "$APP" "$backup"; PACKAGE_MOVED=1; fi
  mv "$PACKAGE_STAGE" "$APP"
  PACKAGE_ACTIVE=1
  rm -rf "$scratch"
  mkdir -p "$PREFIX/bin"
  cp "$APP/keyd" "$PREFIX/bin/keyd.new"
  chmod 700 "$PREFIX/bin/keyd.new"
  KEYD_CHANGED=0 DAEMON_CHANGED=1
  if [ -f "$PREFIX/bin/keyd" ] && cmp -s "$PREFIX/bin/keyd" "$PREFIX/bin/keyd.new"; then rm "$PREFIX/bin/keyd.new"
  else mv "$PREFIX/bin/keyd.new" "$PREFIX/bin/keyd"; KEYD_CHANGED=1; fi
  configure_remote_access
  write_services
  install_command
  start_services "$KEYD_CHANGED" "$DAEMON_CHANGED"
  write_state
}

run_package_install() {
  [ -z "$OPT_REF$OPT_REPO$OPT_REGISTRY" ] || die "Packaged installs use their published release channel. Source --ref, --repo and --registry options do not apply."
  local lock=$PREFIX/.package-install.lock
  mkdir -p "$PREFIX"
  [ ! -L "$lock" ] || die "Installation lock must not be a link."
  if ! mkdir -m 700 "$lock" 2>/dev/null; then
    [ -d "$lock" ] && [ -O "$lock" ] && [ ! -L "$lock/pid" ] || die "Invalid installation lock."
    local owner=""
    [ ! -f "$lock/pid" ] || owner=$(cat "$lock/pid")
    case "$owner" in '' | *[!0-9]*) die "An incomplete installation lock remains at $lock. Check no installer is running before removing it." ;; esac
    if kill -0 "$owner" 2>/dev/null; then die "Another localDot installation is already running. Wait for it to finish."; fi
    rm -f "$lock/pid"; rmdir "$lock" || die "Couldn't clear the previous installation lock."
    mkdir "$lock" || die "Another installer started; wait for it to finish."
  fi
  printf '%s\n' "$$" > "$lock/pid"
  trap package_exit EXIT
  prepare_prerequisites
  check_prerequisites
  check_port
  ensure_node
  check_install_storage
  prepare_package
  activate_package
  finish
  PACKAGE_PENDING=0
  rm -rf "$PACKAGE_ROLLBACK"
}

main() {
  ORIGINAL_ARGS=("$@")
  parse_args "$@"
  if [ "$AS_COMMAND" = 1 ]; then
    run_command
  elif [ "$UNINSTALL" = 1 ]; then
    run_uninstall
  else
    run_install
  fi
}

# Everything above only defines functions, so a download cut short never runs half an installer.
(return 0 2>/dev/null) || { main "$@"; exit $?; }
