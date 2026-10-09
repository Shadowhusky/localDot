#!/bin/bash
# Build, sign, check and switch the hand-run keyd and its keyd-native launcher.
#
#   scripts/deploy.sh [--dry-run] [--label dev.localdot.keyd] [--target /path/to/live/keyd]
#
# --dry-run builds, signs, verifies and runs the signed tests, then prints the switch it would
# make. Without it the script stages both binaries next to the live keyd, renames them into place,
# restarts the LaunchAgent, and rolls back to the previous binaries if the new keyd is not healthy
# within 20 seconds. Once it is healthy, the previous binaries are deleted: they are signed keyd
# builds of an earlier generation.
set -euo pipefail

TEAM=87FD3FSZBG
IDENTITY="Developer ID Application: Richard Liao ($TEAM)"
KEYD_ID=dev.localdot.keyd
NATIVE_ID=dev.localdot.keyd.native
LABEL=dev.localdot.keyd
TARGET=
DRY_RUN=0
HEALTH_SECONDS=20

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --label) LABEL=$2; shift ;;
    --target) TARGET=$2; shift ;;
    *) echo "usage: $0 [--dry-run] [--label LABEL] [--target /path/to/live/keyd]" >&2; exit 2 ;;
  esac
  shift
done

KEYD_DIR=$(cd "$(dirname "$0")/.." && pwd)
UIDN=$(id -u)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

plist_args() { /usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PLIST" 2>/dev/null | sed -n 's/^    //p'; }
if [ -z "$TARGET" ]; then
  [ -f "$PLIST" ] || fail "no LaunchAgent $PLIST; pass --target"
  TARGET=$(plist_args | sed -n 1p)
fi
case "$TARGET" in /*) ;; *) fail "the live keyd path must be absolute: $TARGET" ;; esac
LIVE_DIR=$(dirname "$TARGET")

# keyd's home as Go's flag package reads it: -home or --home, its value next or after "="; else
# LOCALDOT_HOME from the LaunchAgent's environment; else ~/.localdot.
KEYD_HOME=
if [ -f "$PLIST" ]; then
  KEYD_HOME=$(plist_args | awk '
    taken { print; exit }
    /^--?home=/ { sub(/^--?home=/, ""); print; exit }
    /^--?home$/ { taken = 1 }')
  if [ -z "$KEYD_HOME" ] && plist_args | grep -q -- '^--\{0,1\}home'; then
    fail "cannot read keyd's home from the LaunchAgent's arguments"
  fi
  [ -n "$KEYD_HOME" ] || KEYD_HOME=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:LOCALDOT_HOME" "$PLIST" 2>/dev/null || true)
fi
KEYD_HOME=${KEYD_HOME:-$HOME/.localdot}
case "$KEYD_HOME" in /*) ;; *) fail "keyd's home must be an absolute path: $KEYD_HOME" ;; esac
SOCKET="$KEYD_HOME/keyd/admin.sock"

BUILD=$(mktemp -d "${TMPDIR:-/tmp}/keyd-deploy.XXXXXX")
SELFTEST_HOME=$(mktemp -d /tmp/keyd-selftest.XXXXXX)
trap 'rm -rf "$BUILD" "$SELFTEST_HOME"' EXIT

signed_by() {
  printf '%s and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "%s"' "$1" "$TEAM"
}
cdhash() { codesign -dv --verbose=4 "$1" 2>&1 | sed -n 's/^CDHash=//p'; }

step "build"
(cd "$KEYD_DIR" && CGO_ENABLED=1 go build -trimpath -o "$BUILD/keyd" ./cmd/keyd &&
  CGO_ENABLED=1 go build -trimpath -o "$BUILD/keyd-native" ./cmd/keyd-native &&
  CGO_ENABLED=1 go test -c -o "$BUILD/keyd.test" ./cmd/keyd &&
  CGO_ENABLED=1 go test -c -o "$BUILD/vault.test" ./internal/vault)
# keyd's designated requirement asks for the generation its Info.plist carries. Every earlier keyd
# meets only the earlier requirement; keyd adopts the items stored under it.
KEYD_REQ=$("$BUILD/keyd" requirement)
EARLIER_REQ=$(signed_by "identifier \"$KEYD_ID\"")
NATIVE_REQ=$(signed_by "identifier \"$NATIVE_ID\"")
case "$KEYD_REQ" in "$EARLIER_REQ and info [KeydGeneration] >= "*) ;; *) fail "keyd names an unexpected requirement: $KEYD_REQ" ;; esac
otool -s __TEXT __info_plist "$BUILD/keyd" | grep -q '^0' || fail "keyd has no Info.plist"
echo "built keyd, keyd-native and the signed tests' executables in $BUILD"

step "sign ($IDENTITY, hardened runtime)"
sign() {
  local requirements=()
  [ -z "${3:-}" ] || requirements=(--requirements "=designated => $3")
  codesign --force --sign "$IDENTITY" --identifier "$2" --options runtime --timestamp ${requirements[@]+"${requirements[@]}"} "$1" ||
    fail "signing $1 failed; errSecInternalComponent means the login keychain is locked or the key needs your approval"
}
# The tests' executables are signed as keyd so that they pass as its daemon; they stay in $BUILD,
# which the script deletes.
for bin in keyd keyd.test vault.test; do sign "$BUILD/$bin" "$KEYD_ID" "$KEYD_REQ"; done
sign "$BUILD/keyd-native" "$NATIVE_ID"

step "verify signatures"
for pair in "keyd|$KEYD_ID|$KEYD_REQ" "keyd-native|$NATIVE_ID|$NATIVE_REQ"; do
  IFS='|' read -r name id req <<<"$pair"
  bin="$BUILD/$name"
  codesign --verify --strict --verbose=2 -R "=$req" "$bin"
  details=$(codesign -dv --verbose=4 "$bin" 2>&1)
  grep -q "^Identifier=$id\$" <<<"$details" || fail "$bin is not signed as $id"
  grep -q "^TeamIdentifier=$TEAM\$" <<<"$details" || fail "$bin is not signed by team $TEAM"
  grep -q '(runtime)' <<<"$details" || fail "$bin lacks the hardened runtime"
  grep -q '^Timestamp=' <<<"$details" || fail "$bin has no secure timestamp"
  [ -z "$(codesign -d --entitlements - "$bin" 2>/dev/null)" ] || fail "$bin carries entitlements"
  echo "$bin: $id, team $TEAM, hardened runtime, no entitlements, cdhash $(cdhash "$bin")"
done
codesign -d -r- "$BUILD/keyd" 2>&1 | grep -q '^designated => .*KeydGeneration' || fail "keyd's designated requirement lacks its generation"
! codesign --verify -R "=$KEYD_REQ" "$BUILD/keyd-native" 2>/dev/null || fail "keyd-native meets keyd's requirement"

step "local Gatekeeper status (no notarization)"
for bin in "$BUILD/keyd" "$BUILD/keyd-native"; do
  ! xattr -p com.apple.quarantine "$bin" >/dev/null 2>&1 || fail "$bin is quarantined"
  assessment=$(spctl --assess --type execute --verbose=4 "$bin" 2>&1 || true)
  source=$(sed -n 's/^source=//p' <<<"$assessment")
  case "$source" in
    "Unnotarized Developer ID" | "Notarized Developer ID" | "Developer ID") ;;
    *) fail "$bin: unexpected Gatekeeper assessment: $assessment" ;;
  esac
  echo "$bin: not quarantined, Gatekeeper source: $source (launchd starts it without a Gatekeeper check)"
done

step "self-test and signed tests"
"$BUILD/keyd" self-test -home "$SELFTEST_HOME"
set +e
"$BUILD/keyd" keychain-item check localdot-keyd-test probe </dev/null >/dev/null 2>&1
direct=$?
set -e
[ "$direct" = 45 ] || fail "a direct call of the Keychain helper was not refused (exit $direct)"
echo "a direct call of the Keychain helper is refused (exit 45)"
# The signed tests make a keychain of their own. When the live keyd is from before generation 2,
# the vault tests also store items under its access list and adopt them.
EARLIER_BIN=
if [ -f "$TARGET" ] && codesign --verify -R "=$EARLIER_REQ" "$TARGET" 2>/dev/null &&
  ! codesign --verify -R "=$KEYD_REQ" "$TARGET" 2>/dev/null; then
  EARLIER_BIN=$TARGET
fi
signed_test() {
  local package=$1 executable=$2 run=$3 out
  shift 3
  out=$(cd "$KEYD_DIR/$package" && env "$@" "$BUILD/$executable" -test.run "$run" -test.v -test.count=1 2>&1) ||
    { echo "$out"; fail "the signed tests in $package failed"; }
  if ! grep -q -- '--- PASS' <<<"$out" || grep -q -- '--- SKIP' <<<"$out"; then
    echo "$out"
    fail "the signed tests in $package did not run"
  fi
  grep -- '--- PASS' <<<"$out"
}
signed_test cmd/keyd keyd.test '^TestSignedHelperServesOnlyTheDaemonThatClaimedIt$' KEYD_SIGNED_DIR="$BUILD"
signed_test internal/vault vault.test '^TestSigned' KEYD_SIGNED_VAULT=1 KEYD_EARLIER_BIN="$EARLIER_BIN"
rm -f "$BUILD/keyd.test" "$BUILD/vault.test"

NEW_HASH=$(cdhash "$BUILD/keyd")
launchd_pid() { launchctl print "gui/$UIDN/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'; }
status_field() { curl -sf --max-time 2 --unix-socket "$SOCKET" http://keyd/v1/status | plutil -extract "$1" raw -o - - 2>/dev/null; }

# healthy OLD_BOOT HASH: launchd runs the binary with HASH, it answers with a boot other than
# OLD_BOOT and its audit is intact, and it is still the same process two seconds later.
healthy() {
  local deadline=$((SECONDS + HEALTH_SECONDS)) pid boot
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid=$(launchd_pid || true)
    if [ -n "$pid" ] && [ "$(cdhash "$pid")" = "$2" ]; then
      boot=$(status_field bootId || true)
      if [ -n "$boot" ] && [ "$boot" != "$1" ] && [ "$(status_field audit.ok || true)" = true ]; then
        sleep 2
        [ "$(launchd_pid || true)" = "$pid" ] && return 0
      fi
    fi
    sleep 0.5
  done
  return 1
}

PLAN=(
  "copy $BUILD/keyd to $LIVE_DIR/.keyd.next and $BUILD/keyd-native to $LIVE_DIR/.keyd-native.next; verify both"
  "keep the running binaries as $TARGET.prev and $LIVE_DIR/keyd-native.prev until the new keyd is healthy"
  "rename .keyd-native.next to $LIVE_DIR/keyd-native, then .keyd.next to $TARGET (atomic renames)"
  "launchctl kickstart -k gui/$UIDN/$LABEL; roll back if it fails"
  "at start the new keyd claims the Keychain service and adopts every item an earlier keyd stored, which then no earlier keyd can read"
  "health: within ${HEALTH_SECONDS}s launchd runs cdhash $NEW_HASH, $SOCKET answers /v1/status with a new boot and an intact audit"
  "if healthy, delete the .prev binaries; if not, rename them back, kickstart again and exit 1"
)

if [ "$DRY_RUN" = 1 ]; then
  step "dry run: the switch was not made"
  for i in "${!PLAN[@]}"; do printf '%d. %s\n' $((i + 1)) "${PLAN[$i]}"; done
  exit 0
fi

[ -f "$TARGET" ] || fail "no live keyd at $TARGET"
LOCK="$LIVE_DIR/.keyd-deploy.lock"
mkdir "$LOCK" 2>/dev/null || fail "another deploy holds $LOCK"
trap 'rm -rf "$BUILD" "$SELFTEST_HOME"; rmdir "$LOCK" 2>/dev/null || true' EXIT

step "stage"
cp "$BUILD/keyd" "$LIVE_DIR/.keyd.next"
cp "$BUILD/keyd-native" "$LIVE_DIR/.keyd-native.next"
chmod 755 "$LIVE_DIR/.keyd.next" "$LIVE_DIR/.keyd-native.next"
codesign --verify --strict -R "=$KEYD_REQ" "$LIVE_DIR/.keyd.next"
codesign --verify --strict -R "=$NATIVE_REQ" "$LIVE_DIR/.keyd-native.next"
cmp -s "$BUILD/keyd" "$LIVE_DIR/.keyd.next" && cmp -s "$BUILD/keyd-native" "$LIVE_DIR/.keyd-native.next" || fail "the staged copies differ from the build"

OLD_BOOT=$(status_field bootId || true)
OLD_HASH=$(cdhash "$TARGET")
cp -p "$TARGET" "$TARGET.prev"
HAD_NATIVE=0
if [ -f "$LIVE_DIR/keyd-native" ]; then
  cp -p "$LIVE_DIR/keyd-native" "$LIVE_DIR/keyd-native.prev"
  HAD_NATIVE=1
fi

rollback() {
  step "rollback: $1"
  mv -f "$TARGET.prev" "$TARGET"
  if [ "$HAD_NATIVE" = 1 ]; then mv -f "$LIVE_DIR/keyd-native.prev" "$LIVE_DIR/keyd-native"; else rm -f "$LIVE_DIR/keyd-native"; fi
  launchctl kickstart -k "gui/$UIDN/$LABEL" || true
  echo "items the new keyd adopted trust only keyd from generation 2, so the restored keyd cannot read them until a new keyd is deployed"
  if healthy "" "$OLD_HASH"; then
    fail "$1; the previous binaries are back and running"
  fi
  fail "$1, and the restored keyd did not come back either; see $KEYD_HOME/logs/keyd.log"
}

step "switch"
mv -f "$LIVE_DIR/.keyd-native.next" "$LIVE_DIR/keyd-native"
mv -f "$LIVE_DIR/.keyd.next" "$TARGET"
launchctl kickstart -k "gui/$UIDN/$LABEL" || rollback "launchctl kickstart failed"

step "health check (${HEALTH_SECONDS}s)"
healthy "$OLD_BOOT" "$NEW_HASH" || rollback "the new keyd was not healthy"
# An earlier keyd can still read nothing the new keyd adopted, but it keeps its launcher.
rm -f "$TARGET.prev" "$LIVE_DIR/keyd-native.prev"
echo "keyd is healthy on cdhash $NEW_HASH (pid $(launchd_pid)); the previous binaries are deleted"
echo "keys to re-enter: $(status_field reenter || echo unknown); keys changed outside localDot: $(status_field rebound || echo unknown)"
