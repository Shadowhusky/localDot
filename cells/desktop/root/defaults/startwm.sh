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
# The look below is rewritten on every start: a theme, panel or wallpaper change made inside the
# desktop does not survive a restart, on purpose (the look is localDot's, not the agent's).
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
put() {
  cat > "$conf/$1.new"
  mv -f "$conf/$1.new" "$conf/$1"
}
sed "s/@SCALE@/$scale/g" /defaults/localdot/xsettings.xml.in | put xsettings.xml
sed "s/@THEME@/$theme/g" /defaults/localdot/xfwm4.xml.in | put xfwm4.xml
put xfce4-panel.xml < /defaults/localdot/xfce4-panel.xml
put xfce4-desktop.xml < /defaults/localdot/xfce4-desktop.xml
panel="${HOME}/.config/xfce4/panel"
rm -rf "$panel"/launcher-*
mkdir -p "$panel"/launcher-4 "$panel"/launcher-5
cp /defaults/localdot/panel/spotlight.desktop "$panel"/launcher-4/
cp /defaults/localdot/panel/controls.desktop "$panel"/launcher-5/
mkdir -p "${HOME}/.config/gtk-3.0" "${HOME}/.config/rofi"
cp /defaults/localdot/gtk.css "${HOME}/.config/gtk-3.0/gtk.css"
perl -pe "s/(\d+(?:\.\d+)?)pt\b/\$1 * $scale . 'px'/ge" /defaults/localdot/spotlight.rasi \
  > "${HOME}/.config/rofi/localdot-spotlight.rasi"
# A home whose shortcuts xfsettingsd has already copied out of the defaults gets the launcher key.
shortcuts="$conf/xfce4-keyboard-shortcuts.xml"
if [ -f "$shortcuts" ]; then
  python3 /defaults/localdot/add-shortcut.py "$shortcuts" "<Super>space" localdot-spotlight
fi
exec /usr/bin/xfce4-session
