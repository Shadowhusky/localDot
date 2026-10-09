#!/bin/sh
# The IP-in-IP link between a desktop and its gate: link.sh <local> <remote> <address> <peer>
# [default]. The desktop's internal network drops every packet addressed outside it, so the
# desktop's outbound traffic crosses to the gate inside this link, keeping its destination for
# ldgate. The gate runs it at start; a helper with NET_ADMIN only, in the desktop's network
# namespace, runs it with "default" after each desktop start. The desktop never gets NET_ADMIN.
set -eu
ip link del ld0 2>/dev/null || true
ip tunnel add ld0 mode ipip local "$1" remote "$2"
ip addr add "$3/32" peer "$4" dev ld0
ip link set ld0 up
if [ "${5:-}" = default ]; then
  ip route replace default via "$4" dev ld0
fi
