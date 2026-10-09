#!/bin/sh
# Each relay binds one address: the relays out of a cell exist only on its internal network, the
# inbound relays only on the egress network, where Docker delivers the ports it publishes.
# A desktop's gate relays keyd out and desktopd and the stream in, and with a capture token runs
# ldgate for the programs that ignore the proxy; a brain's gate (LD_ROLE=brain, Part 5a) relays keyd
# and the daemon's tool API out, and nothing in; a connector's gate (LD_ROLE=connector) relays keyd
# out and nothing else.
# Out means host.docker.internal on Docker Desktop. Docker Engine has no such name and can't reach
# the host's 127.0.0.1, so there the daemon mounts keyd's and its own sockets (LD_KEYD_SOCKET,
# LD_TOOL_SOCKET) instead.
set -eu
: "${LD_ROLE:=desktop}" "${LD_INTERNAL_ADDR:?}" "${LD_KEYD_PORT:?}"
# PID 1 ignores signals it doesn't trap; exiting takes the relays down with the container.
case "$LD_ROLE" in
  brain) : "${LD_TOOL_PORT:?}" ;;
  desktop) : "${LD_EGRESS_ADDR:?}" "${LD_DESKTOP_ADDR:?}" ;;
  connector) ;;
  *) echo "gate: unknown role" >&2; exit 1 ;;
esac
relays=""
cleanup() {
  for pid in $relays; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 0' TERM INT

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

host_target() {
  if [ -n "$1" ]; then echo "UNIX-CONNECT:$1"; else echo "TCP4:host.docker.internal:$2"; fi
}
keyd_to=$(host_target "${LD_KEYD_SOCKET:-}" "$LD_KEYD_PORT")
socat "TCP4-LISTEN:3128,bind=$LD_INTERNAL_ADDR,fork,reuseaddr" "$keyd_to" &
keyd=$!
case "$LD_ROLE" in
  brain)
    : "${LD_TOOL_PORT:?}"
    tool_to=$(host_target "${LD_TOOL_SOCKET:-}" "$LD_TOOL_PORT")
    socat "TCP4-LISTEN:4751,bind=$LD_INTERNAL_ADDR,fork,reuseaddr" "$tool_to" &
    tool=$!
    echo "gate (brain): keyd $LD_INTERNAL_ADDR:3128 -> $keyd_to; tool API $LD_INTERNAL_ADDR:4751 -> $tool_to"
    relays="$keyd $tool"
    ;;
  connector)
    echo "gate (connector): keyd $LD_INTERNAL_ADDR:3128 -> $keyd_to"
    relays="$keyd"
    ;;
  desktop)
    : "${LD_EGRESS_ADDR:?}" "${LD_DESKTOP_ADDR:?}"
    socat "TCP4-LISTEN:8081,bind=$LD_EGRESS_ADDR,fork,reuseaddr" "TCP4:$LD_DESKTOP_ADDR:7700" &
    desktopd=$!
    socat "TCP4-LISTEN:8082,bind=$LD_EGRESS_ADDR,fork,reuseaddr" "TCP4:$LD_DESKTOP_ADDR:3000" &
    stream=$!
    echo "gate: keyd $LD_INTERNAL_ADDR:3128 -> $keyd_to; inbound $LD_EGRESS_ADDR:8081 -> $LD_DESKTOP_ADDR:7700, $LD_EGRESS_ADDR:8082 -> $LD_DESKTOP_ADDR:3000"
    relays="$keyd $desktopd $stream"
    if [ -n "${LD_CAPTURE_TOKEN:-}" ]; then
      /usr/local/bin/ldgate &
      relays="$relays $!"
    fi
    ;;
  *)
    echo "gate: unknown LD_ROLE $LD_ROLE" >&2
    exit 1
    ;;
esac

# shellcheck disable=SC2086 # the pids are meant to split
while :; do
  for pid in $relays; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "gate: a relay exited" >&2
      exit 1
    fi
  done
  sleep 1
done
