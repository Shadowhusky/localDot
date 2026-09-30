#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HOST_PORT=4799
PUB_PORT=4798
LISTEN_ADDR=${LISTEN_ADDR:-127.0.0.1}
FAILS=0

cleanup() {
  docker rm -f ld-s3-cell ld-s3-gate ld-s3-gate2 >/dev/null 2>&1 || true
  docker network rm ld-s3-sbx ld-s3-sbx2 ld-s3-egress ld-s3-egress2 >/dev/null 2>&1 || true
  [[ -n "${LISTENER_PID:-}" ]] && kill "$LISTENER_PID" 2>/dev/null || true
}
trap cleanup EXIT
cleanup

expect() {
  local want=$1 desc=$2; shift 2
  local got=blocked
  if "$@" >/dev/null 2>&1; then got=ok; fi
  if [[ $got == "$want" ]]; then printf 'ok    %-8s %s\n' "$got" "$desc"
  else printf 'FAIL  %-8s %s (wanted %s)\n' "$got" "$desc" "$want"; FAILS=$((FAILS + 1)); fi
}
in_cell() { docker exec ld-s3-cell "$@"; }

node host-listener.mjs "$HOST_PORT" "$LISTEN_ADDR" & LISTENER_PID=$!
docker build -q -t localdot-spike-gate gate >/dev/null
docker build -q -t localdot-spike-cell cell >/dev/null
docker network create --internal ld-s3-sbx >/dev/null
docker network create ld-s3-egress >/dev/null
docker run -d --name ld-s3-cell --network ld-s3-sbx localdot-spike-cell >/dev/null
docker run -d --name ld-s3-gate --network ld-s3-egress -p "127.0.0.1:${PUB_PORT}:8081" \
  -e RELAYS="3128=host.docker.internal:${HOST_PORT} 8081=ld-s3-cell:8080" localdot-spike-gate >/dev/null
docker network connect ld-s3-sbx ld-s3-gate
docker network create --internal ld-s3-sbx2 >/dev/null
docker network create ld-s3-egress2 >/dev/null
docker run -d --name ld-s3-gate2 --network ld-s3-egress2 \
  -e RELAYS="3128=host.docker.internal:${HOST_PORT}" localdot-spike-gate >/dev/null
docker network connect ld-s3-sbx2 ld-s3-gate2
sleep 2

expect blocked "cell -> internet (https://example.com)" in_cell curl -sS -m 5 https://example.com
expect blocked "cell -> external DNS (nslookup example.com)" in_cell nslookup -timeout=3 example.com
expect blocked "cell -> host.docker.internal directly" in_cell curl -sS -m 5 "http://host.docker.internal:${HOST_PORT}"
expect ok "cell -> gate -> host listener (${LISTEN_ADDR})" in_cell sh -c "curl -sS -m 5 http://ld-s3-gate:3128 | grep -q host-ok"
expect ok "host -> 127.0.0.1:${PUB_PORT} -> gate -> cell" sh -c "curl -sS -m 5 http://127.0.0.1:${PUB_PORT} | grep -q cell-ok"
LAN_IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || true)
if [[ -n "$LAN_IP" ]]; then
  expect blocked "LAN ${LAN_IP}:${PUB_PORT} -> gate" curl -sS -m 5 "http://${LAN_IP}:${PUB_PORT}"
fi
expect blocked "cell -> another sandbox's gate" in_cell curl -sS -m 5 http://ld-s3-gate2:3128
expect blocked "gate -> another sandbox's gate (separate egress networks)" docker exec ld-s3-gate sh -c "nc -z -w 3 ld-s3-gate2 3128"

echo "failures: $FAILS"
exit "$FAILS"
