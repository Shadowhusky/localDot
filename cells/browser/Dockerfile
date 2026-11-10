ARG DESKTOP_IMAGE=localdot/desktop:dev
FROM ${DESKTOP_IMAGE}
USER root
RUN install -d -m 0700 -o 1000 -g 1000 /profile /downloads

# Everyday fonts and the en_US locale browserd selects, so pages render and identify like an
# ordinary desktop browser. They live here, not in the desktop image: a computer's update merges its
# system files with the user's, and package changes there conflict with any app the user installed.
# The browser cell is recreated from its image every start, so it never migrates. apt bypasses the
# base image's proxy (Acquire::Proxy DIRECT): it points at the cell's runtime forwarder on
# 127.0.0.1:3129, which does not exist during the build.
RUN apt-get -o Acquire::http::Proxy=DIRECT -o Acquire::https::Proxy=DIRECT update \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::http::Proxy=DIRECT -o Acquire::https::Proxy=DIRECT \
      install -y --no-install-recommends fonts-liberation fonts-dejavu-core locales \
 && locale-gen en_US.UTF-8 \
 && rm -rf /var/lib/apt/lists/*

# The released image holds only Chromium: Google's terms bar us from distributing Chrome, so a
# packaged install adds it on the user's machine by running this script in a local image made from
# this one (apps/daemon/src/cells/chrome-image.ts). An operator building their own image can bake it
# in with --build-arg INSTALL_CHROME=1, accepting Google's terms; any other value leaves it out.
# browserd prefers /opt/google/chrome/chrome over Chromium when it is there.
ARG INSTALL_CHROME=
COPY cells/browser/install-chrome.sh /opt/localdot/install-chrome.sh
RUN if [ "$INSTALL_CHROME" = 1 ]; then /opt/localdot/install-chrome.sh; fi
COPY cells/browser/root/etc/localdot/browser-nginx.conf /etc/localdot/browser-nginx.conf
COPY cells/browser/root/etc/chromium/policies/managed/localdot-network.json /etc/chromium/policies/managed/localdot-network.json
COPY cells/browser/root/etc/chromium/policies/managed/localdot-network.json /etc/opt/chrome/policies/managed/localdot-network.json
COPY cells/browser/browserd/dist/browserd.mjs cells/browser/browserd/dist/forwarder.mjs /opt/localdot/
COPY cells/browser/browserd/x/browser-helper.py cells/browser/browserd/x/browser_surface.py cells/browser/browserd/x/browser-capture.py /opt/localdot/
COPY cells/desktop/desktopd/x/xhelper.py /opt/localdot/xhelper.py
USER 1000:1000
WORKDIR /
ENTRYPOINT ["/usr/local/bin/node", "/opt/localdot/browserd.mjs"]

# Ownership survives retagging so maintenance can identify unused localDot builds.
LABEL localdot.image-role="browser"
# This image can have Chrome added to it; an older one can't, and the daemon doesn't offer it.
LABEL localdot.chrome-install="1"
