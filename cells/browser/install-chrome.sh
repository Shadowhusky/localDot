#!/bin/sh
# Adds Google Chrome from Google's signed apt repository. It runs on the user's own machine, after
# they accept Google's terms, to make a local image from the released one. Released images must
# never contain Chrome: scripts/release/no-chrome.mjs checks every layer of them.
#
# The exit codes are the reason the daemon shows (apps/daemon/src/cells/chrome-image.ts).
set -u

# Google rotates signing subkeys under one primary key, so the key file's hash changes with each new
# subkey and only the primary's fingerprint is stable. Published at google.com/linuxrepositories.
PRIMARY=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796
SOURCE=https://dl.google.com/linux
KEYRING=/usr/share/keyrings/google-chrome.gpg
# The base image's apt proxy is the browser cell's runtime forwarder, which isn't running here.
DIRECT="-o Acquire::http::Proxy=DIRECT -o Acquire::https::Proxy=DIRECT"

architecture=$(dpkg --print-architecture)
case "$architecture" in
  arm64 | amd64) ;;
  *) exit 14 ;;
esac

work=$(mktemp -d) || exit 13
trap 'rm -rf "$work"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 "$SOURCE/linux_signing_key.pub" -o "$work/key.pub" || exit 10
primaries=$(gpg --homedir "$work" --show-keys --with-colons "$work/key.pub" 2>/dev/null \
  | awk -F: '$1 == "pub" { pub = 1; next } pub && $1 == "fpr" { print $10; pub = 0 }') || exit 11
[ "$primaries" = "$PRIMARY" ] || exit 11
gpg --homedir "$work" --dearmor <"$work/key.pub" >"$KEYRING" || exit 11
chmod 0644 "$KEYRING"
echo "deb [arch=$architecture signed-by=$KEYRING] $SOURCE/chrome/deb/ stable main" \
  >/etc/apt/sources.list.d/google-chrome.list

# Google's repository alone first: a signature that doesn't check out is an error here, not a warning
# apt carries on from. Then the image's other sources, for Chrome's dependencies. One of them having a
# bad day doesn't stop the install unless it really had something Chrome needs, and apt verifies them
# all the same.
# shellcheck disable=SC2086
apt-get $DIRECT -o APT::Update::Error-Mode=any -o Acquire::AllowInsecureRepositories=false \
  -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/google-chrome.list -o Dir::Etc::sourceparts=- \
  -o APT::Get::List-Cleanup=0 update || exit 12
# shellcheck disable=SC2086
apt-get $DIRECT update || true
# shellcheck disable=SC2086
DEBIAN_FRONTEND=noninteractive apt-get $DIRECT -o APT::Get::AllowUnauthenticated=false \
  install -y --no-install-recommends google-chrome-stable || exit 13
version=$(/opt/google/chrome/chrome --version 2>/dev/null | sed -n 's/^Google Chrome \([0-9.]*\).*/\1/p')
[ -n "$version" ] || exit 13
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
echo "localdot-chrome-version=$version"
