#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HOST_PORT=4799
PUB_PORT=4798
LISTEN_ADDR=${LISTEN_ADDR:-127.0.0.1}
GATEWAY_MODE=${GATEWAY_MODE:-}
FAILS=0

cleanup() {
  docker rm -f ld-s3-cell ld-s3-gate ld-s3-gate2 ld-s3-vm >/dev/null 2>&1 || true
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
in_gate() { docker exec ld-s3-gate "$@"; }
ip_of() { docker inspect -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"; }

node host-listener.mjs "$HOST_PORT" "$LISTEN_ADDR" & LISTENER_PID=$!
docker build -q -t localdot-spike-gate gate >/dev/null
docker build -q -t localdot-spike-cell cell >/dev/null
docker network create --internal ${GATEWAY_MODE:+-o com.docker.network.bridge.gateway_mode_ipv4=$GATEWAY_MODE} ld-s3-sbx >/dev/null
docker network create ld-s3-egress >/dev/null
docker run -d --name ld-s3-cell --network ld-s3-sbx localdot-spike-cell >/dev/null
docker run -d --name ld-s3-gate --network ld-s3-egress -p "127.0.0.1:${PUB_PORT}:8081" \
  -e RELAYS="3128=host.docker.internal:${HOST_PORT} 8081=ld-s3-cell:8080" localdot-spike-gate >/dev/null
docker network connect ld-s3-sbx ld-s3-gate
docker network create --internal ${GATEWAY_MODE:+-o com.docker.network.bridge.gateway_mode_ipv4=$GATEWAY_MODE} ld-s3-sbx2 >/dev/null
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

HDI=$(in_gate nslookup -type=a host.docker.internal | awk '/^Address: /{a=$2} END{print a}')
G2_SBX=$(ip_of ld-s3-gate2 ld-s3-sbx2)
G2_EGRESS=$(ip_of ld-s3-gate2 ld-s3-egress2)
GW=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' ld-s3-sbx)
echo "info  gate resolves host.docker.internal to: $(in_gate nslookup host.docker.internal | awk '/^Address: /{s = s (s ? " " : "") $2} END{print s}')"

expect blocked "cell -> 1.1.1.1:443 by IP" in_cell nc -z -w 3 1.1.1.1 443
expect ok "control: gate -> 1.1.1.1:443 by IP" in_gate nc -z -w 3 1.1.1.1 443
expect blocked "cell -> ${HDI}:${HOST_PORT} by IP (host.docker.internal)" in_cell nc -z -w 3 "$HDI" "$HOST_PORT"
expect ok "control: gate -> ${HDI}:${HOST_PORT} by IP" in_gate nc -z -w 3 "$HDI" "$HOST_PORT"
expect ok "control: gate2 relay listening (127.0.0.1:3128)" docker exec ld-s3-gate2 nc -z -w 3 127.0.0.1 3128
expect ok "control: gate nc -z -> ld-s3-cell:8080" in_gate nc -z -w 3 ld-s3-cell 8080
for ip in "$G2_SBX" "$G2_EGRESS"; do
  expect blocked "cell -> gate2 ${ip}:3128 by IP" in_cell nc -z -w 3 "$ip" 3128
  expect blocked "gate -> gate2 ${ip}:3128 by IP" in_gate nc -z -w 3 "$ip" 3128
done
docker run -d --rm --name ld-s3-vm --network host --entrypoint sleep localdot-spike-gate 600 >/dev/null
VM_ADDRS=$(docker exec ld-s3-vm ip -4 -o addr show | awk '$4 !~ /^127\./ {sub(/\/.*/, "", $4); s = s (s ? " " : "") $4} END{print s}')
VM_PORTS=$(docker exec ld-s3-vm netstat -tln | awk '$4 ~ /^0\.0\.0\.0:/ {sub(/.*:/, "", $4); s = s (s ? " " : "") $4} END{print s}')
VM_OPEN=$(docker exec ld-s3-vm sh -c "for p in ${VM_PORTS}; do nc -z -w 2 127.0.0.1 \$p && printf '%s ' \$p; done; true")
VM_OPEN=${VM_OPEN% }
echo "info  cell routes: $(in_cell ip route | awk '{$1 = $1; s = s (s ? "; " : "") $0} END{print s}')"
echo "info  sandbox gateway: ${GW:-none}; VM IPv4 addresses: ${VM_ADDRS}"
echo "info  VM TCP listeners on 0.0.0.0: ${VM_PORTS}; accepting from inside the VM: ${VM_OPEN}"
cell_to_vm() { in_cell sh -c "for a in ${VM_ADDRS}; do for p in $*; do nc -z -w 2 \$a \$p && exit 0; done; done; exit 1"; }
expect ok "control: cell nc -z -> ld-s3-gate:3128" in_cell nc -z -w 3 ld-s3-gate 3128
expect blocked "cell -> any VM address on 22 53 80 443 2375 3128 4798 6443" cell_to_vm 22 53 80 443 2375 3128 4798 6443
for port in $VM_OPEN; do
  expect blocked "cell -> any VM address on VM listener ${port}" cell_to_vm "$port"
done
expect blocked "cell -> DNS server on any VM address" in_cell sh -c "for a in ${VM_ADDRS}; do nslookup -timeout=3 example.com \$a && exit 0; done; exit 1"
expect ok "control: cell nslookup ld-s3-gate (embedded DNS)" in_cell nslookup -timeout=3 ld-s3-gate

echo "failures: $FAILS"
exit "$FAILS"
