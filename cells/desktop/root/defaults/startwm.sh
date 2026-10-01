#!/bin/bash
# Replaces the base's startwm.sh: no dbus-launch (svc-session-bus owns the bus), and the HiDPI
# settings follow LOCALDOT_SCALE on every start so a cell can switch between 2x and 1x.
set -eu
conf="${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml"
if [ ! -d "$conf" ]; then
  mkdir -p "$conf"
  cp /defaults/xfce/*.xml "$conf"/
fi
# LibreOffice's first-run dialogs are modal and invisible to the accessibility tree (S2).
lo="${HOME}/.config/libreoffice/4/user"
if [ ! -f "$lo/registrymodifications.xcu" ]; then
  mkdir -p "$lo"
  cp /defaults/localdot/registrymodifications.xcu "$lo"/
fi
# The two files below are rewritten on every start: a theme change made inside the desktop does
# not survive a restart, on purpose (the look is localDot's, not the agent's).
scale="${LOCALDOT_SCALE:-2}"
case "$scale" in
  1) theme=Default ;;
  2) theme=Default-xhdpi ;;
  *) echo "startwm: LOCALDOT_SCALE must be 1 or 2, got $scale" >&2; exit 1 ;;
esac
# An xfconfd that outlived the last session (or that Selkies' DPI restore activated) flushes its
# pending changes as it exits, and would serve stale values while it dies: it must be gone first.
if pkill -u "$(id -u)" -x xfconfd; then
  while pgrep -u "$(id -u)" -x xfconfd >/dev/null; do sleep 0.1; done
fi
sed "s/@SCALE@/$scale/g" /defaults/localdot/xsettings.xml.in > "$conf/xsettings.xml"
sed "s/@THEME@/$theme/g" /defaults/localdot/xfwm4.xml.in > "$conf/xfwm4.xml"
exec /usr/bin/xfce4-session
