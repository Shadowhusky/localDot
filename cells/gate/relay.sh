#!/bin/sh
# Each relay binds one address: the keyd relay exists only on the cell's internal network, the
# inbound relays only on the egress network, where Docker delivers the ports it publishes.
set -eu
: "${LD_INTERNAL_ADDR:?}" "${LD_EGRESS_ADDR:?}" "${LD_DESKTOP_ADDR:?}" "${LD_KEYD_PORT:?}"

has_addr() { ip -4 -o addr show | grep -q " inet $1/"; }

# The daemon starts the gate on its egress network and connects the internal one afterwards.
n=0
until has_addr "$LD_INTERNAL_ADDR"; do
  n=$((n + 1))
  if [ "$n" -gt 150 ]; then
    echo "gate: $LD_INTERNAL_ADDR never appeared" >&2
    exit 1
  fi
  sleep 0.1
done

socat "TCP4-LISTEN:3128,bind=$LD_INTERNAL_ADDR,fork,reuseaddr" "TCP4:host.docker.internal:$LD_KEYD_PORT" &
keyd=$!
socat "TCP4-LISTEN:8081,bind=$LD_EGRESS_ADDR,fork,reuseaddr" "TCP4:$LD_DESKTOP_ADDR:7700" &
desktopd=$!
socat "TCP4-LISTEN:8082,bind=$LD_EGRESS_ADDR,fork,reuseaddr" "TCP4:$LD_DESKTOP_ADDR:3000" &
stream=$!
echo "gate: keyd $LD_INTERNAL_ADDR:3128 -> host.docker.internal:$LD_KEYD_PORT; inbound $LD_EGRESS_ADDR:8081 -> $LD_DESKTOP_ADDR:7700, $LD_EGRESS_ADDR:8082 -> $LD_DESKTOP_ADDR:3000"

while kill -0 "$keyd" "$desktopd" "$stream" 2>/dev/null; do sleep 1; done
echo "gate: a relay exited" >&2
exit 1
