# Third-party components in the desktop image

| Component | Version | License | Where |
|---|---|---|---|
| linuxserver webtop (Ubuntu 26.04, XFCE 4.20, Selkies 2.0.0) | 53afe260-ls3, `sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804` | GPL-3.0-only (image), Selkies MPL-2.0 | base image |
| WhiteSur GTK theme (light) | tag 2026-09-10, commit 99247ecd219bdc1c7409baff062b4aafcf1102a7 | MIT | `/usr/share/themes/WhiteSur-Light*`, `/usr/share/plank/themes/WhiteSur-Light`, license at `/usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING` |
| WhiteSur icon theme | tag 2026-09-10, commit 73d8040da51a9ed74e47c7366e7e9ff437601a5c | GPL-3.0 (separately licensed data) | `/usr/share/icons/WhiteSur*`, license at `/usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING` |
| Plank | Ubuntu package (unpinned, like the rest of apt) | GPL-3.0-or-later | `/usr/bin/plank`, license at `/usr/share/doc/plank/copyright` |
| vala-panel-appmenu: `xfce4-appmenu-plugin`, `appmenu-registrar` | Ubuntu packages (unpinned) | LGPL-3.0-or-later | the menu bar's app name and menus, licenses at `/usr/share/doc/xfce4-appmenu-plugin/copyright` and `/usr/share/doc/appmenu-registrar/copyright` |
| rofi | 2.0.0 + localDot alpha-visual selection patch | MIT | `/usr/local/bin/rofi` (the Super+Space launcher); license and patch at `/usr/share/doc/localdot-themes/rofi.COPYING` and `rofi-argb-visual.patch`. Ubuntu package supplies runtime dependencies and themes. |
| localDot Daylight wallpaper | design-v2 | MIT (localDot's own) | `/usr/share/backgrounds/localdot/daylight.png` |
| Cua Driver | 0.30.4 | MIT | `/opt/cua`, `/usr/local/bin/cua-driver` |
| VSCodium | 1.135.06055 | MIT | `/usr/share/codium` |
| Node.js | 24.21.0 | MIT | `/opt/node` |

| @hono/node-server | 2.1.3 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| @modelcontextprotocol/sdk | 1.31.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ajv | 8.20.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ajv-formats | 3.0.1 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| cross-spawn | 7.0.6 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| fast-deep-equal | 3.1.3 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| fast-uri | 3.1.8 | BSD-3-Clause | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| Hono | 4.13.12 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| isexe | 2.0.0 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| json-schema-traverse | 1.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| path-key | 3.1.1 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| shebang-command | 2.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| shebang-regex | 3.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| which | 2.0.2 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ws | 8.22.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| zod | 4.6.5 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| zod-to-json-schema | 3.25.2 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |

localDot changed these components (2026-10-01, 2026-10-09):
- WhiteSur GTK theme: `WhiteSur-Light` is the repository's pre-built `release/WhiteSur-Light-solid`
  theme under that name, without its `gnome-shell` part (this desktop has no GNOME Shell, and its
  activities icon is the Apple logo). Its xfwm4 `-hdpi`/`-xhdpi` variants are assembled from the
  repository's `src/` the way its installer does.
- WhiteSur icon theme: the `start-here` and `folder-apple` icons (the Apple logo), and the links to
  them, are removed before its installer runs. No Apple fonts or artwork are in the image.
- Thunar (base image): `thunar.desktop` gains `StartupWMClass=Thunar-real`, so the dock matches the
  windows of the base's renamed Thunar binary.
- Thunar, Mousepad, VSCodium and Xfce Terminal (2026-10-09): their `.desktop` files name them
  Files, Text Editor, Code and Terminal.

The localDot code in this image (`desktopd`, the s6 services, the templates) is MIT like the rest
of the repository. This file is also in the image, at
`/usr/share/doc/localdot-themes/THIRD-PARTY.md`.
