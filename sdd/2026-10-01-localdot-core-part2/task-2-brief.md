### Task 2: Desktop image — pinned base, the app set, Node, VSCodium and Cua Driver

**Files:**
- Create: `cells/desktop/Dockerfile`, `cells/desktop/build.sh`, `cells/desktop/.dockerignore`,
  `cells/desktop/cua-requirements.txt`
- Test: `apps/daemon/src/cells/desktop-image.docker.test.ts`

**Interfaces:**
- Produces: image `localdot/desktop:dev` (stage `desktop`) and the build stage `selkies-client`
  (a scratch image holding Selkies' dashboard `index.html`, `assets/`, `icon.png`, `icon-512.png`
  and the MPL-2.0 text as `LICENSE`, copied from the pinned image and extracted in Task 4);
  `/usr/local/bin/node` (24.21.0), `/usr/local/bin/cua-driver` (the bundled 0.30.4 binary, runnable
  as the desktop user `abc`; installed with `pip install --require-hashes` from
  `cells/desktop/cua-requirements.txt`, which pins every wheel of its dependency closure by sha256),
  `codium`, the app set; env `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`,
  `CUA_DRIVER_RS_UPDATE_CHECK=0`, `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0`, `GTK_MODULES`,
  `QT_ACCESSIBILITY`, `START_DOCKER=false` baked in.

- [ ] **Step 1: Resolve the base digest**

Run: `docker image inspect --format '{{index .RepoDigests 0}}' lscr.io/linuxserver/webtop:ubuntu-xfce`
Expected: `lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804`
(the `53afe260-ls3` build of 2026-09-29, the one S1, S2 and S6 ran on). Write the printed value into
the `FROM` line below; if it differs from the one shown, use the printed one and note it in the
commit message.

- [ ] **Step 2: Pin Cua Driver and its dependencies by hash**

Cua Driver comes from PyPI as a wheel that bundles its native binary, so every wheel of its
dependency closure is pinned by sha256 in `cells/desktop/cua-requirements.txt`, and the image
installs from that file with `pip install --require-hashes`. Generate the file once, inside a
throwaway container of the pinned base image, so the wheels match the image's Python and platform
(Docker runs it for the host's architecture, the one `build.sh` builds for). Nothing is
bind-mounted; `docker cp` brings the file out. Use the digest Step 1 printed.
```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot"
docker rm -fv localdot-cua-pins >/dev/null 2>&1 || true
docker run --name localdot-cua-pins --entrypoint /bin/bash \
  lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 -c '
set -euo pipefail
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3-venv >/dev/null
python3 -m venv /tmp/pin
/tmp/pin/bin/pip download --no-cache-dir --only-binary=:all: --dest /tmp/wheels "cua-driver==0.30.4"
{
  echo "# cua-driver 0.30.4 and its dependency closure for linux/$(dpkg --print-architecture), every wheel pinned by sha256"
  for whl in /tmp/wheels/*.whl; do
    file="${whl##*/}"
    name="$(echo "$file" | cut -d- -f1 | tr _ -)"
    version="$(echo "$file" | cut -d- -f2)"
    echo "$name==$version $(/tmp/pin/bin/pip hash "$whl" | tail -n 1)"
  done | sort
} > /tmp/cua-requirements.txt'
docker cp localdot-cua-pins:/tmp/cua-requirements.txt cells/desktop/cua-requirements.txt
docker rm -fv localdot-cua-pins
cat cells/desktop/cua-requirements.txt
```
Expected: `pip download` saves only wheels (`--only-binary=:all:`); the file holds the comment line
(`linux/arm64` on Apple silicon) and one `<name>==<version> --hash=sha256:<64 hex digits>` line per
wheel, `cua-driver==0.30.4` among them, and no requirement without a hash. Step 3 checks that the
build installs from it and that a changed hash stops the build.

- [ ] **Step 3: Write the Dockerfile**

`cells/desktop/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
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
```

`cells/desktop/.dockerignore`:
```
desktopd/node_modules
desktopd/src
desktopd/*.test.ts
scripts
```

`cells/desktop/build.sh`:
```bash
#!/usr/bin/env bash
# Builds localdot/desktop:dev for the host architecture (arm64 on Apple silicon).
set -euo pipefail
cd "$(dirname "$0")"
docker build --target desktop -t localdot/desktop:dev .
```

Run: `chmod +x cells/desktop/build.sh && cells/desktop/build.sh`
Expected: the build finishes (first run 10–25 minutes: LibreOffice, GIMP, fonts, VSCodium, Node);
`docker image ls localdot/desktop` lists `dev`. The `sha256sum -c` lines print `/tmp/node.tar.xz: OK`
and `/tmp/codium.deb: OK` in the build log, and pip installs Cua Driver from
`/opt/cua/requirements.txt` in hash-checking mode. Then check that the hashes bind: zero the
`cua-driver` hash, build, and restore the file.
```bash
good="$(mktemp)" && cp cells/desktop/cua-requirements.txt "$good"
sed -E '/^cua-driver==/s/sha256:[0-9a-f]{64}/sha256:0000000000000000000000000000000000000000000000000000000000000000/' "$good" > cells/desktop/cua-requirements.txt
cells/desktop/build.sh || echo "refused, as it should be"
cp "$good" cells/desktop/cua-requirements.txt && cells/desktop/build.sh
```
Expected: the first build stops at the Cua Driver step with `THESE PACKAGES DO NOT MATCH THE
HASHES FROM THE REQUIREMENTS FILE` and the shell prints `refused, as it should be`; after the
restore, the second build passes from the cache.

- [ ] **Step 4: Write the image test (part 1: pinned tools)**

`apps/daemon/src/cells/desktop-image.docker.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerExecAs,
  dockerOk,
  removeAll,
} from "./testing/docker-cli.ts";

export const DESKTOP_IMAGE = "localdot/desktop:dev";
const C = "localdot-test-desktop-tools";

describe.skipIf(!DOCKER_TESTS)("desktop image: pinned tools", () => {
  beforeAll(() => {
    if (!dockerOk("image", "inspect", DESKTOP_IMAGE)) {
      throw new Error(`${DESKTOP_IMAGE} is missing: run cells/desktop/build.sh first`);
    }
    removeAll({ containers: [C] });
    docker("run", "-d", "--name", C, "--network", "none", "--shm-size=1g", DESKTOP_IMAGE);
  });

  afterAll(() => removeAll({ containers: [C] }));

  it("ships the app set", () => {
    expect(dockerExec(C, "libreoffice", "--version").out).toContain("LibreOffice");
    expect(dockerExecAs(C, "abc", "codium", "--version").out.split("\n")[0]).toBe("1.135.06055");
    expect(dockerExec(C, "gimp", "--version").out).toMatch(/Image Manipulation Program/);
    expect(dockerExec(C, "ffmpeg", "-version").out).toContain("ffmpeg version");
    expect(dockerExec(C, "convert", "-version").out).toContain("ImageMagick");
    expect(dockerExec(C, "pandoc", "--version").out).toContain("pandoc");
    expect(dockerExec(C, "chromium-browser", "--version").out).toContain("Chromium");
    for (const tool of ["thunar", "xfce4-terminal", "mousepad", "git", "curl", "jq", "python3"]) {
      expect(dockerExec(C, "sh", "-c", `command -v ${tool}`).status, tool).toBe(0);
    }
  });

  it("ships Node 24.21.0", () => {
    expect(dockerExec(C, "node", "--version").out.trim()).toBe("v24.21.0");
    expect(dockerExec(C, "readlink", "-f", "/usr/local/bin/node").out.trim()).toBe("/opt/node/bin/node");
  });

  it("runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off", () => {
    expect(dockerExecAs(C, "abc", "cua-driver", "--version").out).toContain("0.30.4");
    const env = docker("image", "inspect", "--format", "{{json .Config.Env}}", DESKTOP_IMAGE);
    expect(env).toContain('"CUA_DRIVER_RS_TELEMETRY_ENABLED=0"');
    expect(env).toContain('"CUA_DRIVER_RS_UPDATE_CHECK=0"');
    expect(env).toContain('"CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0"');
    expect(env).toContain('"START_DOCKER=false"');
  });

  it("has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji", () => {
    const families = dockerExec(C, "fc-list", ":", "family").out;
    expect(families).toMatch(/\bInter\b/);
    expect(families).toContain("JetBrains Mono");
    expect(families).toContain("Noto Sans CJK");
    expect(families).toContain("Noto Color Emoji");
  });

  it("has the X, accessibility and certificate tools", () => {
    expect(dockerExec(C, "xinput", "--version").status).toBe(0);
    expect(dockerExec(C, "python3", "-c", "import Xlib").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "command -v xprop && command -v certutil").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "ls /usr/libexec/at-spi-bus-launcher").status).toBe(0);
  });
});
```

- [ ] **Step 5: Run it**

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: 5 tests pass. If `codium --version` prints nothing as `abc`, check
`dockerExecAs(C, "abc", "codium", "--version").out` by hand: VSCodium refuses to run as root, which
is why the test runs it as `abc`.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop apps/daemon/src/cells/desktop-image.docker.test.ts
git commit -m "feat(desktop): pinned desktop image with the app set, Node, VSCodium and Cua Driver"
```

---
