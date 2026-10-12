# Reuse a previously verified desktop image for a desktopd-only release. BASE must be a pinned
# digest, separately for each target architecture. The normal desktop Dockerfile also builds
# this same bundle; no host configuration or user computer data is copied into the image.
ARG BASE
FROM ${BASE}
ARG COMMIT
LABEL org.opencontainers.image.source="https://github.com/Shadowhusky/localdot"
LABEL org.opencontainers.image.revision="${COMMIT}"
COPY desktopd.mjs /opt/localdot/desktopd.mjs
RUN chmod 644 /opt/localdot/desktopd.mjs && /opt/node/bin/node --check /opt/localdot/desktopd.mjs
