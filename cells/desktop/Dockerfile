# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Base: linuxserver webtop, Ubuntu 26.04.1 + XFCE 4.20 + Selkies 2.0.0 (GPL-3.0-only, a separate
# program inside this image). Pinned by digest; resolve with
#   docker image inspect --format '{{index .RepoDigests 0}}' lscr.io/linuxserver/webtop:ubuntu-xfce
FROM lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 AS base

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_ARM64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
ARG NODE_SHA256_X64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG CODIUM_VERSION=1.135.06055
ARG CODIUM_SHA256_ARM64=79d1efcb8b730d750d144c38a88af9a3449f0d6d47df1c6b8b46e6f98c738a14
ARG CODIUM_SHA256_AMD64=5f5c00a9da9d232e4c84e9eee68bbdeb4d8737462022626ce3bdb6948f3d8649

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      at-spi2-core python3-venv python3-xlib xinput libnss3-tools xz-utils x11-utils webp \
      libreoffice-calc libreoffice-writer libreoffice-impress libreoffice-gtk3 \
      gimp ffmpeg imagemagick pandoc \
      fonts-inter fonts-jetbrains-mono fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Stream credentials are random base64url strings and may begin with a hyphen. The base's
# command-line password then becomes an openssl option; stdin treats every token as data.
RUN python3 - <<'PY'
from pathlib import Path
init = Path('/etc/s6-overlay/s6-rc.d/init-nginx/run')
old = 'openssl passwd -apr1 "${PASSWORD}"'
new = 'printf \'%s\\n\' "${PASSWORD}" | openssl passwd -apr1 -stdin'
source = init.read_text()
assert source.count(old) == 1, 'pinned nginx password initializer changed'
init.write_text(source.replace(old, new))
PY

RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      arm64) node_arch=arm64; sum="$NODE_SHA256_ARM64" ;; \
      amd64) node_arch=x64; sum="$NODE_SHA256_X64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    echo "${sum}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm /tmp/node.tar.xz; \
    ln -s /opt/node/bin/node /usr/local/bin/node; \
    ln -s /opt/node/bin/npm /usr/local/bin/npm; \
    ln -s /opt/node/bin/npx /usr/local/bin/npx

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) sum="$CODIUM_SHA256_ARM64" ;; \
      amd64) sum="$CODIUM_SHA256_AMD64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/codium.deb \
      "https://github.com/VSCodium/vscodium/releases/download/${CODIUM_VERSION}/codium_${CODIUM_VERSION}_${arch}.deb"; \
    echo "${sum}  /tmp/codium.deb" | sha256sum -c -; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/codium.deb; \
    rm -rf /var/lib/apt/lists/* /tmp/codium.deb

# Cua Driver (MIT) for perception only, from cua-requirements.txt, where every wheel of its
# dependency closure is pinned by sha256. Its pip entry point chmods the root-owned binary on every
# run and fails as the desktop user (S2), so the bundled binary is linked directly.
COPY cua-requirements.txt /opt/cua/requirements.txt
RUN python3 -m venv /opt/cua \
 && /opt/cua/bin/pip install --no-cache-dir --require-hashes -r /opt/cua/requirements.txt \
 && bin="$(find /opt/cua -type f -path '*/cua_driver/bin/cua-driver' | head -n 1)" \
 && test -n "$bin" && chmod 755 "$bin" && ln -s "$bin" /usr/local/bin/cua-driver

ENV CUA_DRIVER_RS_TELEMETRY_ENABLED=0 \
    CUA_DRIVER_RS_UPDATE_CHECK=0 \
    CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0 \
    GTK_MODULES=gail:atk-bridge \
    QT_ACCESSIBILITY=1 \
    START_DOCKER=false

# The base runs Thunar as thunar-real behind a wrapper, so its windows carry that class. Naming
# it in thunar.desktop before Plank's window matcher (BAMF) indexes the desktop files at install
# lets the dock put Thunar's windows on its Files item.
RUN sed -i '/^\[Desktop Entry\]$/a StartupWMClass=Thunar-real' /usr/share/applications/thunar.desktop \
 && grep -qx 'StartupWMClass=Thunar-real' /usr/share/applications/thunar.desktop \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends plank \
 && rm -rf /var/lib/apt/lists/*

ARG WHITESUR_GTK_TAG=2026-09-10
ARG WHITESUR_GTK_COMMIT=99247ecd219bdc1c7409baff062b4aafcf1102a7

# WhiteSur GTK theme (MIT), light: the repo's pre-built Light-solid theme, installed as
# WhiteSur-Light, plus the xfwm4 -hdpi/-xhdpi variants assembled the way its installer does
# (libs/lib-install.sh), so no sassc build is needed. Light-solid has Light's xfwm4 and Plank files
# but an opaque #f1f1f1 panel with dark text, where Light's panel is a 15 % white tint with white
# text over the wallpaper. Its GNOME Shell part is left out: this desktop has none, and its
# activities icon is the Apple logo.
RUN set -eu; \
    git clone --depth 1 --branch "$WHITESUR_GTK_TAG" https://github.com/vinceliuice/WhiteSur-gtk-theme /tmp/whitesur-gtk; \
    test "$(git -C /tmp/whitesur-gtk rev-parse HEAD)" = "$WHITESUR_GTK_COMMIT"; \
    tar -xJf /tmp/whitesur-gtk/release/WhiteSur-Light-solid.tar.xz -C /usr/share/themes \
      --transform 's,^WhiteSur-Light-solid,WhiteSur-Light,'; \
    rm -rf /usr/share/themes/WhiteSur-Light/gnome-shell; \
    for size in hdpi xhdpi; do \
      mkdir -p "/usr/share/themes/WhiteSur-Light-${size}/xfwm4"; \
      cp /tmp/whitesur-gtk/src/assets/xfwm4/assets-Light-${size}/*.png "/usr/share/themes/WhiteSur-Light-${size}/xfwm4/"; \
      cp /tmp/whitesur-gtk/src/main/xfwm4/themerc-Light "/usr/share/themes/WhiteSur-Light-${size}/xfwm4/themerc"; \
    done; \
    mkdir -p /usr/share/plank/themes/WhiteSur-Light /usr/share/doc/localdot-themes; \
    cp /usr/share/themes/WhiteSur-Light/plank/dock.theme /usr/share/plank/themes/WhiteSur-Light/dock.theme; \
    cp /tmp/whitesur-gtk/COPYING /usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING; \
    rm -rf /tmp/whitesur-gtk

ARG WHITESUR_ICONS_TAG=2026-09-10
ARG WHITESUR_ICONS_COMMIT=73d8040da51a9ed74e47c7366e7e9ff437601a5c

# WhiteSur icon theme (GPL-3.0): separately licensed data inside the image, like the base (P2-R13).
# Its start-here and folder-apple icons, and the links to them, are the Apple logo: they are removed
# before the installer copies the theme and builds its icon caches.
RUN set -eu; \
    git clone --depth 1 --branch "$WHITESUR_ICONS_TAG" https://github.com/vinceliuice/WhiteSur-icon-theme /tmp/whitesur-icons; \
    test "$(git -C /tmp/whitesur-icons rev-parse HEAD)" = "$WHITESUR_ICONS_COMMIT"; \
    find /tmp/whitesur-icons/src /tmp/whitesur-icons/links \
      \( -name start-here.svg -o -name start-here-symbolic.svg -o -name 'folder-apple*' -o -lname 'start-here*' \) -delete; \
    /tmp/whitesur-icons/install.sh -d /usr/share/icons -t default; \
    cp /tmp/whitesur-icons/COPYING /usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING; \
    rm -rf /tmp/whitesur-icons

ARG WHITESUR_WALLPAPERS_COMMIT=4fe5ae7a01f38f8ff9a25c343e0a49234c1012c9
ARG WALLPAPER_SHA256=4a5867e8c67e04ef23e8a13ce38644053ddb3aebeb0d02706924ffdfb0d95833
ARG WALLPAPER_LICENSE_SHA256=5a9518c6e0636dee418520a999426422aa33a2c5a0d8dedf62cadceec8d1b3c6

# Wallpaper (MIT): WhiteSur-wallpapers' flat light dune in Nord colours (tag 2023-06-11), a
# grey-blue sky over sand browns.
RUN set -eu; \
    src="https://raw.githubusercontent.com/vinceliuice/WhiteSur-wallpapers/${WHITESUR_WALLPAPERS_COMMIT}"; \
    mkdir -p /usr/share/backgrounds/localdot; \
    curl -fsSL -o /usr/share/backgrounds/localdot/mojave-nord-light.png "$src/Wallpaper-nord/Mojave-nord-light.png"; \
    echo "${WALLPAPER_SHA256}  /usr/share/backgrounds/localdot/mojave-nord-light.png" | sha256sum -c -; \
    curl -fsSL -o /usr/share/doc/localdot-themes/WhiteSur-wallpapers.LICENSE "$src/LICENSE"; \
    echo "${WALLPAPER_LICENSE_SHA256}  /usr/share/doc/localdot-themes/WhiteSur-wallpapers.LICENSE" | sha256sum -c -
COPY THIRD-PARTY.md /usr/share/doc/localdot-themes/THIRD-PARTY.md

COPY root/ /
RUN chmod 755 /defaults/startwm.sh /etc/s6-overlay/s6-rc.d/svc-session-bus/run \
      /etc/s6-overlay/s6-rc.d/init-gamepad-lock/run /usr/local/bin/localdot-plank \
      /etc/s6-overlay/s6-rc.d/svc-desktopd/run /usr/local/bin/localdot-chromium

# One session bus for XFCE, AT-SPI, Selkies' xfconf writes and desktopd (A10). The Selkies values
# set here that a client could change are locked: "|locked" on bools, a one-value span on ranges,
# one item on enums (D1, D2). File transfers take "none" because s6 drops an empty variable, which
# re-enables them.
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus \
    LOCALDOT_SCALE=2 \
    SELKIES_MANUAL_WIDTH=2560 \
    SELKIES_MANUAL_HEIGHT=1600 \
    SELKIES_ENABLE_RESIZE="false|locked" \
    SELKIES_USE_CSS_SCALING="false|locked" \
    SELKIES_SCALING_DPI=96 \
    SELKIES_ENABLE_CURSORS="false|locked" \
    SELKIES_ENCODER=h264enc \
    SELKIES_FRAMERATE=60-60 \
    SELKIES_VIDEO_FULLCOLOR="true|locked" \
    SELKIES_AUDIO_ENABLED="false|locked" \
    SELKIES_MICROPHONE_ENABLED="false|locked" \
    SELKIES_WEBCAM_ENABLED="false|locked" \
    SELKIES_GAMEPAD_ENABLED="false|locked" \
    SELKIES_ENABLE_CLIPBOARD=false \
    SELKIES_ENABLE_BINARY_CLIPBOARD="false|locked" \
    SELKIES_FILE_TRANSFERS=none \
    SELKIES_PRINTING_ENABLED="false|locked" \
    SELKIES_COMMAND_ENABLED="false|locked" \
    SELKIES_UI_SHOW_SIDEBAR="false|locked" \
    SELKIES_UI_SHOW_CORE_BUTTONS="false|locked" \
    SELKIES_UI_SHOW_LOGO="false|locked" \
    SELKIES_UI_TITLE=localDot \
    NO_GAMEPAD=1 \
    NO_WEBCAM=1 \
    CUSTOM_USER=localdot

# Selkies' web client (MPL-2.0), served by the daemon instead of by the cell (Task 4, Task 14). It
# copies straight from the pinned image, so `--target selkies-client` never builds the base stage.
FROM scratch AS selkies-client
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/selkies/selkies-dashboard/index.html /index.html
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/selkies/selkies-dashboard/assets /assets
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/selkies/selkies-dashboard/icon.png /usr/share/selkies/selkies-dashboard/icon-512.png /
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/common-licenses/MPL-2.0 /LICENSE

FROM base AS desktop
# The bundle lands in the final stage only, so `--target selkies-client` never needs it built.
COPY desktopd/dist/desktopd.mjs /opt/localdot/desktopd.mjs
COPY desktopd/x/xhelper.py /opt/localdot/xhelper.py
COPY desktopd/x/native.py /opt/localdot/native.py
RUN chmod 644 /opt/localdot/desktopd.mjs
EXPOSE 3000 7700
