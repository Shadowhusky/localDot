FROM alpine:3.22
RUN apk add --no-cache socat
COPY relay.sh /relay.sh
RUN chmod +x /relay.sh
USER nobody
ENTRYPOINT ["/relay.sh"]
