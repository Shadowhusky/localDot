FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache socat iptables setpriv
COPY relay.sh /relay.sh
COPY gate.sh /gate.sh
COPY link.sh /link.sh
# Built by build.sh from keyd/cmd/ldgate for the engine's architecture.
COPY dist/ldgate /usr/local/bin/ldgate
RUN chmod 555 /relay.sh /gate.sh /link.sh /usr/local/bin/ldgate
USER nobody
ENTRYPOINT ["/gate.sh"]
