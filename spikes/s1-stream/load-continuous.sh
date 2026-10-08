#!/usr/bin/env bash
set -euo pipefail
C=ld-s1-desktop
BROWSER=$(docker exec "$C" sh -c 'command -v chromium || command -v chromium-browser || command -v firefox')
docker exec -d -u abc -e DISPLAY=:1 "$C" "$BROWSER" https://en.wikipedia.org/wiki/Computer
sleep 10
docker exec -u abc -e DISPLAY=:1 "$C" xdotool key --clearmodifiers --delay 40 --repeat 500 Down &
for _ in $(seq 1 8); do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$C"; sleep 2; done
wait
