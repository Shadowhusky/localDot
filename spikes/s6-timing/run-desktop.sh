#!/usr/bin/env bash
# S1's run-desktop.sh on the S2 image (webtop + Cua Driver + LibreOffice + Mousepad), per Ruling 20.
set -euo pipefail
SCALE=${1:-1}
W=$((1280 * SCALE)); H=$((800 * SCALE)); DPI=$((96 * SCALE))
docker rm -fv ld-s6-desktop >/dev/null 2>&1 || true
docker run -d --name ld-s6-desktop --shm-size=1g -p 127.0.0.1:4791:3001 \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -e SELKIES_MANUAL_WIDTH="$W" -e SELKIES_MANUAL_HEIGHT="$H" -e SELKIES_ENABLE_RESIZE=false \
  -e SELKIES_SCALING_DPI="$DPI" -e SELKIES_ENABLE_CURSORS=false -e SELKIES_FRAMERATE=60 \
  -e SELKIES_AUDIO_ENABLED=false -e SELKIES_VIDEO_FULLCOLOR=true \
  localdot-spike-s2 >/dev/null
echo "desktop: https://127.0.0.1:4791 (${SCALE}x = ${W}x${H} @ ${DPI} dpi)"
