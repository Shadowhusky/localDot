#!/bin/bash
# Replaces the base's startwm.sh: no dbus-launch (svc-session-bus owns the bus), and the HiDPI
# settings follow LOCALDOT_SCALE on every start so a cell can switch between 2x and 1x.
set -eu
conf="${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml"
# Each default fills in only a channel the home lacks, even when xfconfd made the folder first.
# (--update=none is cp -n without coreutils' "non-portable" warning.)
mkdir -p "$conf"
cp --update=none /defaults/xfce/*.xml "$conf"/
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
  1) theme=WhiteSur-Light ;;
  2) theme=WhiteSur-Light-xhdpi ;;
  *) echo "startwm: LOCALDOT_SCALE must be 1 or 2, got $scale" >&2; exit 1 ;;
esac
# An xfconfd that outlived the last session (or that Selkies' DPI restore activated) flushes its
# pending changes as it exits, and would serve stale values while it dies: it must be gone first.
# One still there after 5 s (D-Bus can re-activate it) is killed, which skips the flush.
uid="$(id -u)"
for _ in $(seq 50); do
  pkill -u "$uid" -x xfconfd || break
  sleep 0.1
done
pkill -KILL -u "$uid" -x xfconfd || true
# Written whole, then renamed into place: an xfconfd re-activated meanwhile never reads half a file.
sed "s/@SCALE@/$scale/g" /defaults/localdot/xsettings.xml.in > "$conf/xsettings.xml.new"
mv -f "$conf/xsettings.xml.new" "$conf/xsettings.xml"
sed "s/@THEME@/$theme/g" /defaults/localdot/xfwm4.xml.in > "$conf/xfwm4.xml.new"
mv -f "$conf/xfwm4.xml.new" "$conf/xfwm4.xml"
exec /usr/bin/xfce4-session
