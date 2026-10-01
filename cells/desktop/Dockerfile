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
      at-spi2-core python3-venv python3-xlib xinput libnss3-tools xz-utils x11-utils \
      libreoffice-calc libreoffice-writer libreoffice-impress libreoffice-gtk3 \
      gimp ffmpeg imagemagick pandoc \
      fonts-inter fonts-jetbrains-mono fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

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
