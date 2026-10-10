#!/bin/sh
# Isolated visual regression, never point this at the user's running display.
# docker run --rm --network none --entrypoint /bin/sh \
#   -v "$PWD/cells/desktop:/source:ro" -v /tmp/localdot-corners:/results \
#   localdot/desktop:dev /source/tests/native-corners.sh --out /results
set -eu
export DISPLAY=:98 NO_AT_BRIDGE=1
Xvfb "$DISPLAY" -screen 0 2880x1800x24 +extension Composite -nolisten tcp >/tmp/corners-xvfb.log 2>&1 &
xvfb=$!
trap 'kill "$xvfb" 2>/dev/null || true' EXIT
sleep 1
# Xvfb's default RandR output is 1280x1024 even with a larger framebuffer.
xrandr --newmode corners 300 2880 2881 2882 2883 1800 1801 1802 1803
xrandr --addmode screen corners
xrandr --output screen --mode corners
dbus-run-session -- sh -c '
  xfwm4 --compositor=on --replace >/tmp/corners-xfwm.log 2>&1 &
  wm=$!
  trap '\''kill "$wm" 2>/dev/null || true'\'' EXIT
  sleep 1
  xfconf-query -c xfwm4 -p /general/show_popup_shadow -s false
  xfconf-query -c xfwm4 -p /general/show_frame_shadow -s false
  python3 "$(dirname "$0")/native-corners.py" "$@"
' "$0" "$@"
