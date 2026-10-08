#!/bin/sh
set -eu
for relay in $RELAYS; do
  listen="${relay%%=*}"
  target="${relay#*=}"
  socat "TCP-LISTEN:${listen},fork,reuseaddr" "TCP:${target}" &
done
wait
