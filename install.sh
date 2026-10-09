#!/usr/bin/env bash
# Installs localDot from source on macOS, Linux and WSL 2: checks what it needs, builds the app
# and its computer images, starts its services and prints a sign-in link. Run it again to
# upgrade; --uninstall removes it. The installed `localdot` command runs this script too.
# On Windows, install.ps1 sets up WSL 2 and runs this inside it. See docs/install.md.
set -euo pipefail

NODE_VERSION=24.21.0
GO_VERSION=1.27.1
MIN_DOCKER_MAJOR=28
DEFAULT_REPO=https://github.com/Shadowhusky/localdot.git
DEFAULT_REF=main
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
Install or upgrade localDot from source on macOS, Linux or WSL 2.

Usage: install.sh [options]
  --ref <branch, tag or commit>  Version to install (default: main, or the one installed)
  --repo <url or path>           Where to get localDot from
  --port <port>                  Local port for the app (default 4750)
  --home <folder>                Where localDot keeps your data (default ~/.localdot)
  --prefix <folder>              Where the app is installed (default ~/.local/share/localdot)
  --tailscale                    Reach localDot from your other devices through Tailscale Serve
  --no-tailscale                 Stop serving localDot through Tailscale
  --registry <registry/owner>    Pull published computer images instead of building them
  --skip-images                  Use the computer images already in Docker
  --uninstall                    Remove localDot; keeps your data
  --help                         Show this help

Run it again at any time to upgrade; it keeps your settings and data.
EOF
}

command_usage() {
  cat <<'EOF'
localdot: run localDot installed from source

  localdot up                  Start localDot and print a sign-in link
  localdot down                Stop localDot until you start it again or restart this computer
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
    die "Run the installer as your own user, not as root. localDot runs as that user's services and never needs sudo. On a fresh server, create a user with Docker access first; see docs/install.md."
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
      say "Docker. Install Docker Desktop for Windows and turn on Settings > Resources > WSL integration for this distro, or install $engine here: curl -fsSL https://get.docker.com | sudo sh, then sudo usermod -aG docker $(id -un) and open a new terminal."
    else
      say "$engine. On Ubuntu or Debian: curl -fsSL https://get.docker.com | sudo sh, then sudo usermod -aG docker $(id -un) and sign in again. Other systems: https://docs.docker.com/engine/install/"
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
      elif [ -n "$WSL" ] && ! command -v systemctl >/dev/null 2>&1; then
        say "Docker is installed but not running. Start Docker Desktop for Windows."
      else
        say "Docker is installed but not running. Run: sudo systemctl enable --now docker (with Docker Desktop for Windows: start it)."
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

check_prerequisites() {
  local problems="" missing="" tool problem
  git --version >/dev/null 2>&1 || missing="git"
  for tool in curl tar gzip; do
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
  if [ -n "$problems" ]; then
    printf 'localDot needs a few things first:\n%sThen run the installer again.\n' "$problems" >&2
    exit 1
  fi
}

parse_args() {
  OPT_REF="" OPT_REPO="" OPT_PORT="" OPT_HOME="" OPT_TAILSCALE="" OPT_REGISTRY=""
  SKIP_IMAGES=0 UNINSTALL=0 AS_COMMAND=0
  COMMAND="" COMMAND_ARGS=()
  PREFIX="${LOCALDOT_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/localdot}"
  while [ $# -gt 0 ]; do
    case "$1" in
    --ref | --repo | --port | --home | --prefix | --registry)
      [ $# -ge 2 ] || die "$1 needs a value. Run install.sh --help for usage."
      case "$1" in
      --ref) OPT_REF=$2 ;;
      --repo) OPT_REPO=$2 ;;
      --port) OPT_PORT=$2 ;;
      --home) OPT_HOME=$2 ;;
      --prefix) PREFIX=$2 ;;
      --registry) OPT_REGISTRY=$2 ;;
      esac
      shift 2
      ;;
    --tailscale) OPT_TAILSCALE=on && shift ;;
    --no-tailscale) OPT_TAILSCALE=off && shift ;;
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
    LOCALDOT_REF) REF=$value ;;
    LOCALDOT_HOME) LD_HOME=$value ;;
    LOCALDOT_PORT) PORT=$value ;;
    LOCALDOT_TAILSCALE) TAILSCALE=$value ;;
    LOCALDOT_PUBLIC_ORIGIN) PUBLIC_ORIGIN=$value ;;
    LOCALDOT_REGISTRY) REGISTRY=$value ;;
    LOCALDOT_COMMIT) BUILT_COMMIT=$value ;;
    esac
  done <"$file"
}

write_state() {
  cat >"$PREFIX/install.env.new" <<EOF
# $MARKER
LOCALDOT_REPO="$REPO"
LOCALDOT_REF="$REF"
LOCALDOT_HOME="$LD_HOME"
LOCALDOT_PORT="$PORT"
LOCALDOT_TAILSCALE="$TAILSCALE"
LOCALDOT_PUBLIC_ORIGIN="$PUBLIC_ORIGIN"
LOCALDOT_REGISTRY="$REGISTRY"
LOCALDOT_COMMIT="$COMMIT"
EOF
  mv "$PREFIX/install.env.new" "$PREFIX/install.env"
}

# Recorded settings win over the environment, and options win over both.
resolve_settings() {
  REPO=$DEFAULT_REPO REF=$DEFAULT_REF
  LD_HOME=${LOCALDOT_HOME:-$HOME/.localdot} PORT=${LOCALDOT_PORT:-4750}
  TAILSCALE=off PUBLIC_ORIGIN="" REGISTRY="" BUILT_COMMIT="" INSTALLED=0
  check_path "The install folder" "$PREFIX"
  if read_state; then INSTALLED=1; fi
  WAS_TAILSCALE=$TAILSCALE OLD_PORT=$PORT
  [ -z "$OPT_REPO" ] || REPO=$OPT_REPO
  [ -z "$OPT_REF" ] || REF=$OPT_REF
  [ -z "$OPT_HOME" ] || LD_HOME=$OPT_HOME
  [ -z "$OPT_PORT" ] || PORT=$OPT_PORT
  [ -z "$OPT_TAILSCALE" ] || TAILSCALE=$OPT_TAILSCALE
  [ -z "$OPT_REGISTRY" ] || REGISTRY=$OPT_REGISTRY
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
  git -C "$dir" fetch --quiet --depth 1 origin "$REF" || die "Couldn't get $REF from $REPO."
  git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
  [ "$dir" = "$APP" ] || mv "$dir" "$APP"
  [ -f "$APP/install.sh" ] || die "localDot $REF has no installer. Choose a newer version with --ref."
}

install_archive() {
  local url=$1 sum=$2 destination=$3 work=$RUNTIME/.download
  rm -rf "$work"
  mkdir -p "$work/out"
  curl -fsSL --retry 3 -o "$work/archive.tar.gz" "$url" || die "Couldn't download $url."
  if [ "$(sha256_of "$work/archive.tar.gz")" != "$sum" ]; then
    rm -rf "$work"
    die "The download from $url doesn't match its pinned checksum, so nothing was installed."
  fi
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
    remove_other_versions "$NODE_DIR" "$RUNTIME"/node-v*
  fi
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
  PATH="$TOOLS:$NODE_DIR/bin:$PATH" COREPACK_HOME="$RUNTIME/corepack" \
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
    GOFLAGS=-modcacherw "$GO_DIR/bin/go" build -trimpath -o "$binary.new" ./cmd/keyd) ||
    die "Building the key service failed; see the messages above."
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
    say "Building the $role image"
    (cd "$APP" && tools bash "cells/$role/build.sh") || die "Building the $role image failed; see the messages above."
  done
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
  printf '%s\n' "HOME=$HOME" "PATH=$(service_path)" "LOCALDOT_HOME=$LD_HOME" "LOCALDOT_PORT=$PORT"
  [ -z "$PUBLIC_ORIGIN" ] || say "LOCALDOT_PUBLIC_ORIGIN=$PUBLIC_ORIGIN"
  [ -z "${DOCKER_HOST:-}" ] || say "DOCKER_HOST=$DOCKER_HOST"
}

systemd_units() {
  local environment="" line
  while IFS= read -r line; do environment="$environment"$'\n'"Environment=\"$line\""; done <<EOF
$(daemon_environment)
EOF
  KEYD_CONTENT="# $MARKER
[Unit]
Description=localDot key service

[Service]
Type=exec
ExecStart=\"$PREFIX/bin/keyd\" \"-home\" \"$LD_HOME\"
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
WorkingDirectory=$APP/apps/daemon$environment
ExecStart=\"$NODE_DIR/bin/node\" \"--import\" \"tsx\" \"src/main.ts\"
UMask=0077
Restart=on-failure
RestartSec=5
StandardOutput=append:$LD_HOME/logs/daemon.log
StandardError=append:$LD_HOME/logs/daemon.log

[Install]
WantedBy=default.target"
}

plist() {
  local label=$1 log=$2 arguments="" environment="" argument line
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
  <key>WorkingDirectory</key><string>$APP/apps/daemon</string>"
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
    DAEMON_CONTENT=$(plist "$DAEMON_LABEL" daemon "$NODE_DIR/bin/node" --import tsx src/main.ts)
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

start_services() {
  if [ "$OS" = macos ]; then
    load_agent "$KEYD_LABEL" "$1"
    load_agent "$DAEMON_LABEL" "$2"
    return
  fi
  user_systemd || true
  systemctl --user daemon-reload
  systemctl --user enable --quiet "$KEYD_UNIT" "$DAEMON_UNIT"
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
  else
    warn "$link is another program, so this one stays at $shim."
  fi
}

cli() {
  (cd "$APP/apps/daemon" && LOCALDOT_HOME="$LD_HOME" LOCALDOT_PORT="$PORT" \
    LOCALDOT_PUBLIC_ORIGIN="$PUBLIC_ORIGIN" "$NODE_DIR/bin/node" --import tsx ../cli/src/main.ts "$@")
}

wait_ready() {
  local tries=0
  until curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; do
    tries=$((tries + 1))
    if [ $tries -ge 60 ]; then
      tail -n 20 "$LD_HOME/logs/daemon.log" >&2 2>/dev/null || true
      die "localDot didn't start; its last log lines are above. Fix what they say, then run: localdot up"
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
  # explorer.exe reports failure even when it opened the link.
  "$browser" "$link" >/dev/null 2>&1 || true
  say "Opened localDot in your browser. If it didn't open, run: localdot open"
  [ -z "$PUBLIC_ORIGIN" ] || say "For your phone or another computer, run: localdot open --qr"
}

finish() {
  wait_ready
  offer_unlock
  step "Checking the installation"
  local healthy=1
  cli doctor || healthy=0
  step "Sign in"
  show_link
  if [ "$healthy" = 0 ]; then
    say ""
    say "Some checks failed (marked FAIL above). Fix them, then run: localdot doctor"
  fi
  case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "To use the localdot command, open a new terminal or add $HOME/.local/bin to your PATH." ;;
  esac
}

run_install() {
  detect_platform
  resolve_settings
  set_paths
  check_services_are_ours
  check_prerequisites
  check_port
  if [ "${LOCALDOT_INSTALL_STAGE:-}" != checked-out ] || [ ! -d "$APP/.git" ]; then
    sync_source
    # Continue with the installer of the version just checked out, so its pins match its code.
    LOCALDOT_INSTALL_STAGE=checked-out exec "$BASH" "$APP/install.sh" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
  fi
  unset LOCALDOT_INSTALL_STAGE
  COMMIT=$(git -C "$APP" rev-parse HEAD)
  ensure_node
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
  rm -rf "$PREFIX"
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
  down) stop_services ;;
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
