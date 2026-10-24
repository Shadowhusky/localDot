ARG DESKTOP_IMAGE=localdot/desktop:dev
FROM ${DESKTOP_IMAGE}
USER root
RUN install -d -m 0700 -o 1000 -g 1000 /profile /downloads

# Opt-in Google Chrome for the account browser. Off by default, so the distributed image ships only
# Chromium and never redistributes Chrome; an operator who builds with --build-arg INSTALL_CHROME=1
# installs it from Google's own apt repo (amd64 and, since 2026, arm64) and accepts Google's terms.
# browserd then prefers /opt/google/chrome/chrome, whose codecs and Widevine some sign-in walls check
# for. The signing key is pinned by sha256. apt bypasses the base image's proxy (Acquire::Proxy
# DIRECT): that proxy points at the cell's runtime forwarder on 127.0.0.1:3129, which does not exist
# during the build.
ARG INSTALL_CHROME=
# Google rotates this key file; re-verify and bump the pin when a build reports a checksum mismatch.
ARG CHROME_KEY_SHA256=54dea5f6c2a26091578cf52a999cebc6b64df478d37ad4dce96376b711e3b27c
RUN if [ -n "$INSTALL_CHROME" ]; then set -eu; \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /tmp/google.pub; \
      echo "${CHROME_KEY_SHA256}  /tmp/google.pub" | sha256sum -c -; \
      gpg --dearmor < /tmp/google.pub > /usr/share/keyrings/google-chrome.gpg; \
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
      apt-get -o Acquire::http::Proxy=DIRECT -o Acquire::https::Proxy=DIRECT update; \
      DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::http::Proxy=DIRECT -o Acquire::https::Proxy=DIRECT install -y --no-install-recommends google-chrome-stable; \
      rm -rf /var/lib/apt/lists/* /tmp/google.pub; \
    fi
COPY cells/browser/root/etc/localdot/browser-nginx.conf /etc/localdot/browser-nginx.conf
COPY cells/browser/browserd/dist/browserd.mjs cells/browser/browserd/dist/forwarder.mjs /opt/localdot/
COPY cells/browser/browserd/x/browser-helper.py cells/browser/browserd/x/browser_surface.py cells/browser/browserd/x/browser-capture.py /opt/localdot/
COPY cells/desktop/desktopd/x/xhelper.py /opt/localdot/xhelper.py
USER 1000:1000
WORKDIR /
ENTRYPOINT ["/usr/local/bin/node", "/opt/localdot/browserd.mjs"]

# Ownership survives retagging so maintenance can identify unused localDot builds.
LABEL localdot.image-role="browser"
