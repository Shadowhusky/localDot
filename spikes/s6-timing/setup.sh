#!/usr/bin/env bash
# Step 1 on a fresh desktop: xinput for the raw-event log, xilog.py, and the flash page in a kiosk Chromium.
set -euo pipefail
cd "$(dirname "$0")"
C=${LD_DESKTOP:-ld-s6-desktop}
until docker exec "$C" pgrep -u abc xfce4-panel >/dev/null 2>&1; do sleep 1; done
sleep 5
docker exec "$C" sh -c 'command -v xinput >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xinput >/dev/null)'
docker cp flash.html "$C":/tmp/flash.html
docker cp xilog.py "$C":/tmp/xilog.py
docker exec "$C" chmod 644 /tmp/flash.html /tmp/xilog.py
BROWSER=$(docker exec "$C" sh -c 'command -v chromium || command -v chromium-browser || command -v firefox')
docker exec -d -u abc -e DISPLAY=:1 "$C" "$BROWSER" --kiosk file:///tmp/flash.html
sleep 6
docker exec -u abc -e DISPLAY=:1 "$C" sh -c 'xdpyinfo | grep dimensions; xdotool getactivewindow getwindowname getwindowgeometry'
