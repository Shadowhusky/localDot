#!/usr/bin/env bash
set -euo pipefail
C=ld-s1-desktop
docker exec "$C" sh -c 'command -v xdotool >/dev/null || (apt-get update -qq && apt-get install -y -qq xdotool >/dev/null)'
BROWSER=$(docker exec "$C" sh -c 'command -v chromium || command -v chromium-browser || command -v firefox')
docker exec -d -u abc -e DISPLAY=:1 "$C" "$BROWSER" https://en.wikipedia.org/wiki/Computer
sleep 10
( for _ in $(seq 1 60); do docker exec -u abc -e DISPLAY=:1 "$C" xdotool key --clearmodifiers Page_Down; sleep 0.5; done ) &
for _ in $(seq 1 15); do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$C"; sleep 2; done
wait
