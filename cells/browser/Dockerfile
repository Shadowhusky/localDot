ARG DESKTOP_IMAGE=localdot/desktop:dev
FROM ${DESKTOP_IMAGE}
USER root
RUN install -d -m 0700 -o 1000 -g 1000 /profile /downloads
COPY cells/browser/root/etc/localdot/browser-nginx.conf /etc/localdot/browser-nginx.conf
COPY cells/browser/browserd/dist/browserd.mjs cells/browser/browserd/dist/forwarder.mjs /opt/localdot/
COPY cells/browser/browserd/x/browser-helper.py cells/browser/browserd/x/browser_surface.py cells/browser/browserd/x/browser-capture.py /opt/localdot/
COPY cells/desktop/desktopd/x/xhelper.py /opt/localdot/xhelper.py
USER 1000:1000
WORKDIR /
ENTRYPOINT ["/usr/local/bin/node", "/opt/localdot/browserd.mjs"]
