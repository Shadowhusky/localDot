#!/usr/bin/env bash
# The Part 2 desktop image, standalone (default bridge, so the desktop's Chromium can load a page
# for the motion test), stream on 127.0.0.1:4791 behind the basic-auth password s8password.
set -euo pipefail
SCALE=${1:-2}
W=$((1280 * SCALE)); H=$((800 * SCALE))
docker rm -fv ld-s8-desktop >/dev/null 2>&1 || true
docker run -d --name ld-s8-desktop --shm-size=1g --cap-drop NET_RAW -p 127.0.0.1:4791:3000 \
  -e PASSWORD=s8password -e LOCALDOT_SCALE="$SCALE" \
  -e SELKIES_MANUAL_WIDTH="$W" -e SELKIES_MANUAL_HEIGHT="$H" \
  localdot/desktop:dev >/dev/null
until docker exec -u abc ld-s8-desktop pgrep -x xfce4-panel >/dev/null 2>&1; do sleep 1; done
sleep 5
echo "desktop: http://127.0.0.1:4791 (${SCALE}x = ${W}x${H}), user localdot, password s8password"
