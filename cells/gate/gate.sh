#!/bin/sh
# A desktop's gate starts as root only to take the desktop's traffic from its link (link.sh) to
# ldgate, which hands each connection to keyd, and its DNS to ldgate's placeholder answers; it then
# runs as nobody with no capabilities. Every other gate starts as nobody.
set -eu
if [ "$(id -u)" = 0 ]; then
  : "${LD_DESKTOP_ADDR:?}" "${LD_INTERNAL_ADDR:?}" "${LD_CAPTURE_TOKEN:?}"
  /link.sh "$LD_INTERNAL_ADDR" "$LD_DESKTOP_ADDR" 192.0.0.1 192.0.0.2
  for proto in udp tcp; do
    iptables -t nat -A PREROUTING -i ld0 -p "$proto" --dport 53 -j REDIRECT --to-ports 5353
    iptables -t nat -A PREROUTING -s "$LD_DESKTOP_ADDR" -d "$LD_INTERNAL_ADDR" -p "$proto" --dport 53 -j REDIRECT --to-ports 5353
  done
  iptables -t nat -A PREROUTING -i ld0 -p tcp -j REDIRECT --to-ports 3130
  # Nothing is routed through the gate: what ldgate does not take is dropped here.
  iptables -P FORWARD DROP
  exec setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs /relay.sh
fi
exec /relay.sh
