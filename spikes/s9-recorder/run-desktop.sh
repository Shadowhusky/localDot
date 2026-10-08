#!/usr/bin/env bash
# Standalone pinned desktop for S9. The caller owns and retires only the returned container ID.
set -euo pipefail
scale=${1:-2}
case "$scale" in 1|2) ;; *) echo 'scale must be 1 or 2' >&2; exit 2 ;; esac
name=${S9_CONTAINER_NAME:-localdot-test-s9-$$}
case "$name" in localdot-test-s9-*) ;; *) echo 'owned S9 name required' >&2; exit 2 ;; esac
port=${S9_STREAM_PORT:-4776}
image=${S9_DESKTOP_IMAGE:-localdot/desktop:ui14-20261004-b1}
if docker container inspect "$name" >/dev/null 2>&1; then
  echo 'refusing to replace an existing container' >&2; exit 1
fi
width=$((1280 * scale)); height=$((800 * scale))
id=$(docker run --pull never -d --name "$name" --label localdot.spike=s9 --shm-size=1g \
  --cap-drop NET_RAW -p "127.0.0.1:$port:3000" \
  -e PASSWORD=s9-local-synthetic-password -e "LOCALDOT_SCALE=$scale" \
  -e "SELKIES_MANUAL_WIDTH=$width" -e "SELKIES_MANUAL_HEIGHT=$height" \
  -e "SELKIES_VIDEO_FULLCOLOR=${S9_FULLCOLOR:-true}|locked" "$image")
failed=1
cleanup() { if [[ "$failed" == 1 ]]; then docker rm -fv "$id" >/dev/null; fi; }
trap cleanup EXIT
for ((i=0; i<60; i++)); do
  if docker exec -u abc "$id" pgrep -x xfce4-panel >/dev/null 2>&1; then
    failed=0
    printf '%s\n' "$id"
    exit 0
  fi
  sleep 1
done
echo 'desktop readiness timed out' >&2
exit 1
