#!/usr/bin/env bash
# Replaces the flash page with Mousepad (72 pt, no caret blink) and prints the detector config for the
# first character cell: evaluate `Object.assign(window.ldDetect, <printed JSON>)` in the viewer before inputs.mjs.
set -euo pipefail
C=${LD_DESKTOP:-ld-s6-desktop}
DBUS=$(docker exec -u abc "$C" sh -c 'tr "\0" "\n" < /proc/$(pgrep -u abc -n xfce4-session)/environ' | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')
run() { docker exec -u abc -e DISPLAY=:1 -e DBUS_SESSION_BUS_ADDRESS="$DBUS" "$C" sh -c "$1"; }
run 'pkill -u abc -f "[c]hromium" || true; pkill -u abc -x mousepad || true'
run "xfconf-query -c xsettings -p /Net/CursorBlink -s false; gsettings set org.xfce.mousepad.preferences.view font-name 'DejaVu Sans Mono 72'"
docker exec -d -u abc -e DISPLAY=:1 -e DBUS_SESSION_BUS_ADDRESS="$DBUS" "$C" mousepad
sleep 4
WID=$(run "xdotool search --onlyvisible --name 'Mousepad\$' | head -1")
run "xdotool windowactivate --sync $WID; sleep 0.5; import -window root /tmp/mp-before.png; xdotool type x; sleep 0.5; import -window root /tmp/mp-after.png; xdotool key BackSpace"
eval "$(run "xdotool getwindowgeometry --shell $WID")"
CROP="${WIDTH}x${HEIGHT}+${X}+${Y}"
BOX=$(run "convert /tmp/mp-before.png /tmp/mp-after.png -crop $CROP +repage -compose difference -composite -threshold 10% -format '%@' info:")
read -r W H BX BY <<<"$(echo "$BOX" | sed -E 's/([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)/\1 \2 \3 \4/')"
X=$((X + BX)); Y=$((Y + BY))
# The glyph's middle half, which the caret (at the cell edges) never enters.
RX=$((X + W / 4)); RY=$((Y + H / 4)); RW=$((W / 2 / 2 * 2)); RH=$((H / 2 / 2 * 2))
EMPTY=$(run "convert /tmp/mp-before.png -crop ${RW}x${RH}+${RX}+${RY} -colorspace gray -format '%[fx:255*mean]' info:")
GLYPH=$(run "convert /tmp/mp-after.png -crop ${RW}x${RH}+${RX}+${RY} -colorspace gray -format '%[fx:255*mean]' info:")
echo "window $WID; typed glyph changed ${BOX}; region mean luma empty ${EMPTY}, with glyph ${GLYPH}" >&2
echo "{\"rect\":{\"x\":$RX,\"y\":$RY,\"width\":$RW,\"height\":$RH},\"threshold\":$(echo "($EMPTY + $GLYPH) / 2" | bc)}"
