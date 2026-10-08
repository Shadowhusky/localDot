#!/usr/bin/env bash
# usage: capture.sh <label> <pid> <window_id> [timeout_ms]
# Raises the window, saves its tree, a full-screen screenshot and the frame overlay under out/.
set -euo pipefail
cd "$(dirname "$0")"
label=$1 pid=$2 wid=$3 timeout=${4:-5000}
LD_DBUS=${LD_DBUS:-$(docker exec -u abc ld-s2 sh -c 'tr "\0" "\n" < /proc/$(pgrep -u abc -n xfce4-session)/environ' \
  | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')}
export LD_DBUS
node probe.mjs call bring_to_front "{\"pid\":$pid,\"window_id\":$wid}" | tail -1
sleep 1
log=$(node probe.mjs call get_window_state "{\"pid\":$pid,\"window_id\":$wid,\"timeout_ms\":$timeout}")
echo "$log" | tail -1
cp "$(echo "$log" | sed -n 's/^saved //p')" "out/$label-state.json"
docker exec -u abc ld-s2 sh -c 'DISPLAY=:1 import -window root /tmp/s.png'
docker cp ld-s2:/tmp/s.png "out/$label-s.png" >/dev/null
node overlay.mjs "out/$label-s.png" "out/$label-state.json" "out/$label-overlay.png" "${SCALE:-1}"
