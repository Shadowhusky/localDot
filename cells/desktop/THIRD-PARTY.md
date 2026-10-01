# Third-party components in the desktop image

| Component | Version | License | Where |
|---|---|---|---|
| linuxserver webtop (Ubuntu 26.04, XFCE 4.20, Selkies 2.0.0) | 53afe260-ls3, `sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804` | GPL-3.0-only (image), Selkies MPL-2.0 | base image |
| WhiteSur GTK theme (light) | tag 2026-09-10, commit 99247ecd219bdc1c7409baff062b4aafcf1102a7 | MIT | `/usr/share/themes/WhiteSur-Light*`, `/usr/share/plank/themes/WhiteSur-Light`, license at `/usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING` |
| WhiteSur icon theme | tag 2026-09-10, commit 73d8040da51a9ed74e47c7366e7e9ff437601a5c | GPL-3.0 (separately licensed data) | `/usr/share/icons/WhiteSur*`, license at `/usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING` |
| WhiteSur wallpapers: `Wallpaper-nord/Mojave-nord-light.png` | tag 2023-06-11, commit 4fe5ae7a01f38f8ff9a25c343e0a49234c1012c9, `sha256:4a5867e8c67e04ef23e8a13ce38644053ddb3aebeb0d02706924ffdfb0d95833` | MIT | `/usr/share/backgrounds/localdot/mojave-nord-light.png`, license at `/usr/share/doc/localdot-themes/WhiteSur-wallpapers.LICENSE` |
| Plank | 0.11.89-6ubuntu1 (Ubuntu package) | GPL-3.0-or-later | `/usr/bin/plank`, license at `/usr/share/doc/plank/copyright` |
| Cua Driver | 0.30.4 | MIT | `/opt/cua`, `/usr/local/bin/cua-driver` |
| VSCodium | 1.135.06055 | MIT | `/usr/share/codium` |
| Node.js | 24.21.0 | MIT | `/opt/node` |

localDot changed these components (2026-10-01):
- WhiteSur GTK theme: `WhiteSur-Light` is the repository's pre-built `release/WhiteSur-Light-solid`
  theme under that name, without its `gnome-shell` part (this desktop has no GNOME Shell, and its
  activities icon is the Apple logo). Its xfwm4 `-hdpi`/`-xhdpi` variants are assembled from the
  repository's `src/` the way its installer does.
- WhiteSur icon theme: the `start-here` and `folder-apple` icons (the Apple logo), and the links to
  them, are removed before its installer runs. No Apple fonts or artwork are in the image.
- Thunar (base image): `thunar.desktop` gains `StartupWMClass=Thunar-real`, so the dock matches the
  windows of the base's renamed Thunar binary.

The localDot code in this image (`desktopd`, the s6 services, the templates) is MIT like the rest
of the repository. This file is also in the image, at
`/usr/share/doc/localdot-themes/THIRD-PARTY.md`.
