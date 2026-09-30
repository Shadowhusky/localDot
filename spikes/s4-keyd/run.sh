#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# IPV6=1 selects iron-proxy.ipv6.yaml and probes the Mac's own IPv6 addresses.
IPV6=${IPV6:-}
CONFIG=${CONFIG:-iron-proxy${IPV6:+.ipv6}.yaml}
LOG=out/iron-proxy.log
SURROGATE=ld_spike_surrogate_7f3c9a1e5b2d4f60
UNKNOWN=ld_spike_unknown_0000000000000000
FAILS=0
REDACT=()
# Printed output shows the Mac's own IPv6 addresses as placeholders: they are this network's public addresses.
redact() {
  local s=$1 pair
  for pair in ${REDACT[@]+"${REDACT[@]}"}; do s=${s//"${pair%%=*}"/"${pair#*=}"}; done
  printf '%s\n' "$s"
}
cleanup() {
  docker rm -f ld-s4-cell ld-s4-gate >/dev/null 2>&1 || true
  docker network rm ld-s4-sbx ld-s4-egress >/dev/null 2>&1 || true
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
  [[ -n "${LISTENER_PID:-}" ]] && kill "$LISTENER_PID" 2>/dev/null || true
}
trap cleanup EXIT
cleanup
# Audit records appended after line $1, one per request: method host+path action status [swapped] [by=] [err=].
audit_since() {
  local seen=-1 now
  # iron-proxy writes the record after the response, so wait for the log to stop growing.
  while now=$(wc -l < "$LOG"); [[ $now != "$seen" ]]; do seen=$now; sleep 0.3; done
  tail -n "+$(($1 + 1))" "$LOG" | jq -rR 'fromjson? | select(.msg == "request")
    | [.audit.method, .audit.host + .audit.path, .audit.action, (.audit.status_code | tostring)]
      + (if any(.request_transforms[]?; .annotations.swapped != null) then ["swapped"] else [] end)
      + (if .rejected_by then ["by=" + .rejected_by] else [] end)
      + (if .error then ["err=" + .error] else [] end)
    | join(" ")' | paste -sd '|' - | sed 's/|/ | /g'
}
# $3 is a regex the probe's audit records must match, so a line cannot pass for the wrong reason.
expect() {
  local want=$1 desc=$2 why=$3; shift 3
  local got=blocked before audit
  before=$(wc -l < "$LOG")
  if "$@" >/dev/null 2>&1; then got=ok; fi
  audit=$(redact "$(audit_since "$before")")
  if [[ $got != "$want" ]]; then printf 'FAIL  %-8s %s (wanted %s)\n' "$got" "$desc" "$want"; FAILS=$((FAILS + 1))
  elif [[ -n $why && ! $audit =~ $why ]]; then printf 'FAIL  %-8s %s (wrong reason)\n' "$got" "$desc"; FAILS=$((FAILS + 1))
  else printf 'ok    %-8s %s\n' "$got" "$desc"; fi
  if [[ -n $audit ]]; then printf '      audit: %s\n' "$audit"; fi
}
LD_SPIKE_SECRET="real-secret-value-for-spike" bin/iron-proxy --config "$CONFIG" > "$LOG" 2>&1 &
PROXY_PID=$!
node ../s3-network/host-listener.mjs 4799 127.0.0.1 >/dev/null &
LISTENER_PID=$!
sleep 2
kill -0 "$PROXY_PID" 2>/dev/null || { cat "$LOG"; exit 1; }
echo "config: $CONFIG; iron-proxy $(bin/iron-proxy --version)"
echo "info  iron-proxy listeners: $(lsof -nP -a -p "$PROXY_PID" -iTCP -sTCP:LISTEN | awk 'NR > 1 {print $9}' | sort | paste -sd ' ' -); RSS $(ps -o rss= -p "$PROXY_PID" | awk '{printf "%.1f MB", $1 / 1024}')"
docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated ld-s4-sbx >/dev/null
docker network create ld-s4-egress >/dev/null
docker run -d --name ld-s4-cell --network ld-s4-sbx localdot-spike-cell >/dev/null
docker run -d --name ld-s4-gate --network ld-s4-egress -e RELAYS="3128=host.docker.internal:4796" localdot-spike-gate >/dev/null
docker network connect ld-s4-sbx ld-s4-gate
docker cp out/ca.crt ld-s4-cell:/tmp/ca.crt
docker exec ld-s4-cell sh -c 'cat /etc/ssl/certs/ca-certificates.crt /tmp/ca.crt > /tmp/roots-and-cell-ca.crt'
for _ in $(seq 50); do docker exec ld-s4-cell nc -z ld-s4-gate 3128 && break; sleep 0.2; done
# --proxytunnel makes even http:// probes use CONNECT, the only mode the tunnel listener is sure to serve.
P="--proxy http://ld-s4-gate:3128 --proxytunnel --cacert /tmp/ca.crt -sS -m 10"
PB="--proxy http://ld-s4-gate:3128 --proxytunnel --cacert /tmp/roots-and-cell-ca.crt -sS -m 10"

echo "--- brief probes"
expect ok "surrogate swapped for bound host" 'GET postman-echo\.com/headers allow 200 swapped' sh -c "docker exec ld-s4-cell curl $P -H 'Authorization: ld_spike_surrogate_7f3c9a1e5b2d4f60' https://postman-echo.com/headers | grep -q real-secret-value-for-spike"
expect blocked "request without surrogate (require: true)" 'GET postman-echo\.com/headers reject 403 by=secrets' sh -c "docker exec ld-s4-cell curl $P -f https://postman-echo.com/headers"
expect blocked "unknown surrogate" 'GET postman-echo\.com/headers reject 403 by=secrets' sh -c "docker exec ld-s4-cell curl $P -f -H 'Authorization: ld_spike_unknown_0000000000000000' https://postman-echo.com/headers"
expect blocked "unlisted host" 'CONNECT www\.wikipedia\.org:443 reject 403 by=allowlist' sh -c "docker exec ld-s4-cell curl $P -f https://www.wikipedia.org"
expect blocked "private address (docker host)" 'denied by upstream_deny_cidrs: 192\.168\.65\.254 ' sh -c "docker exec ld-s4-cell curl $P -f http://192.168.65.254/"
expect blocked "metadata address" 'denied by upstream_deny_cidrs: 169\.254\.169\.254 ' sh -c "docker exec ld-s4-cell curl $P -f http://169.254.169.254/"
expect blocked "host loopback (LM Studio port)" 'denied by upstream_deny_cidrs: 127\.0\.0\.1 ' sh -c "docker exec ld-s4-cell curl $P -f http://127.0.0.1:1234/v1/models"

echo "--- controls and keyd requirements"
expect ok "control: host -> 127.0.0.1:1234 directly (LM Studio is up)" '' curl -sS -m 5 -o /dev/null http://127.0.0.1:1234/v1/models
expect blocked "allowlisted name resolving to loopback (localhost:1234)" 'denied by upstream_deny_cidrs: (::1|127\.0\.0\.1) ' docker exec ld-s4-cell curl $P -f http://localhost:1234/v1/models
LAN_IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || true)
if [[ -n $LAN_IP ]]; then
  expect ok "control: host -> ${LAN_IP}:1234 directly" '' curl -sS -m 5 -o /dev/null "http://${LAN_IP}:1234/v1/models"
  expect blocked "host LAN address ${LAN_IP}:1234" "denied by upstream_deny_cidrs: ${LAN_IP//./\\.} " docker exec ld-s4-cell curl $P -f "http://${LAN_IP}:1234/v1/models"
fi
expect ok "control: host -> 127.0.0.1:4799 directly (listener bound to 127.0.0.1 only)" '' curl -sS -m 5 -o /dev/null http://127.0.0.1:4799/
expect blocked "127.0.0.1:4799 through the proxy" 'denied by upstream_deny_cidrs: 127\.0\.0\.1 ' docker exec ld-s4-cell curl $P -f http://127.0.0.1:4799/
if [[ -n $IPV6 ]]; then
  expect blocked "0.0.0.0:4799 once 0.0.0.0/8 is in the deny list" 'denied by upstream_deny_cidrs: 0\.0\.0\.0 in 0\.0\.0\.0/8' docker exec ld-s4-cell curl $P -f http://0.0.0.0:4799/
  expect blocked "[::]:4799 once ::/128 is in the deny list" 'denied by upstream_deny_cidrs: :: in ::/128' docker exec ld-s4-cell curl $P -f 'http://[::]:4799/'
else
  expect ok "0.0.0.0:4799 reaches the same loopback-only listener (0.0.0.0/8 not in the deny list)" 'GET 0\.0\.0\.0:4799/ allow 200$' sh -c "docker exec ld-s4-cell curl $P -f http://0.0.0.0:4799/ | grep -q host-ok"
  expect ok "[::]:4799 reaches the same loopback-only listener (::/128 not in the deny list)" 'GET \[::\]:4799/ allow 200$' sh -c "docker exec ld-s4-cell curl $P -f 'http://[::]:4799/' | grep -q host-ok"
fi
if [[ -n $IPV6 ]]; then
  own=$(ifconfig en0 2>/dev/null || true; ifconfig en1 2>/dev/null || true)
  GUA_STABLE=$(awk '$1 == "inet6" && $2 ~ /^[23]/ && / secured/ && !/temporary/ {print $2; exit}' <<< "$own")
  GUA_TEMP=$(awk '$1 == "inet6" && $2 ~ /^[23]/ && /temporary/ && !/deprecated/ {print $2; exit}' <<< "$own")
  GUA_OLD=$(awk '$1 == "inet6" && $2 ~ /^[23]/ && /deprecated/ {print $2; exit}' <<< "$own")
  ULA_OWN=$(awk '$1 == "inet6" && $2 ~ /^f[cd]/ && / secured/ {print $2; exit}' <<< "$own")
  for pair in "$GUA_STABLE=GUA-stable" "$GUA_TEMP=GUA-temporary" "$GUA_OLD=GUA-deprecated" "$ULA_OWN=ULA-own"; do
    if [[ $pair != =* ]]; then REDACT+=("$pair"); fi
  done
  echo "info  Mac's own IPv6 on en0/en1: ULA-own, GUA-stable, GUA-temporary and $(awk '$1 == "inet6" && $2 ~ /^[23]/ && /deprecated/' <<< "$own" | wc -l | tr -d ' ') deprecated temporaries (global, prefixlen 64, ${GUA_STABLE%%:*}:...); IPv6 wildcard TCP listeners visible to this user: $(lsof -nP -iTCP -sTCP:LISTEN | awk '$5 == "IPv6" && $9 ~ /^\*:/' | wc -l | tr -d ' ')"
  if [[ -n $ULA_OWN ]]; then
    expect blocked "Mac's own ULA [ULA-own]:1234 (fc00::/7)" 'denied by upstream_deny_cidrs: ULA-own in fc00::/7' docker exec ld-s4-cell curl $P -f "http://[$ULA_OWN]:1234/"
  fi
  if [[ -n $GUA_STABLE ]]; then
    expect blocked "Mac's own stable global IPv6 [GUA-stable]:1234 passes the guard; the Mac refuses it" 'GET \[GUA-stable\]:1234/ error 502 err=dial tcp \[GUA-stable\]:1234: connect: connection refused' docker exec ld-s4-cell curl $P -f "http://[$GUA_STABLE]:1234/"
  fi
  if [[ -n $GUA_TEMP ]]; then
    expect blocked "Mac's own temporary global IPv6 [GUA-temporary]:1234 passes the guard; the Mac refuses it" 'GET \[GUA-temporary\]:1234/ error 502 err=dial tcp \[GUA-temporary\]:1234: connect: connection refused' docker exec ld-s4-cell curl $P -f "http://[$GUA_TEMP]:1234/"
  fi
  if [[ -n $GUA_OLD ]]; then
    expect blocked "Mac's own deprecated temporary [GUA-deprecated]:1234 passes the guard; the Mac refuses it" 'GET \[GUA-deprecated\]:1234/ error 502 err=dial tcp \[GUA-deprecated\]:1234: connect: connection refused' docker exec ld-s4-cell curl $P -f "http://[$GUA_OLD]:1234/"
  fi
fi
reflected=$(docker exec ld-s4-cell curl $P -H "Authorization: $SURROGATE" https://postman-echo.com/headers 2>/dev/null | jq -rR 'fromjson? | .headers.authorization' || true)
echo "info  authorization that postman-echo reflected into the cell: ${reflected:-none (request failed)}"
expect ok "surrogate in X-Api-Key (not in match_headers) is not swapped" 'GET postman-echo\.com/headers allow 200 swapped$' sh -c "docker exec ld-s4-cell curl $P -H 'Authorization: $SURROGATE' -H 'X-Api-Key: $SURROGATE' https://postman-echo.com/headers | grep -q '\"x-api-key\":\"$SURROGATE\"'"
expect ok "exact host: surrogate sent to www.postman-echo.com arrives unswapped" 'GET www\.postman-echo\.com/headers allow 200$' sh -c "docker exec ld-s4-cell curl $P -H 'Authorization: $SURROGATE' https://www.postman-echo.com/headers | grep -q '\"authorization\":\"$SURROGATE\"'"
expect ok "plain http:// to the bound host is swapped too (real value leaves in cleartext)" 'CONNECT postman-echo\.com:80 allow 200 [|] GET postman-echo\.com/headers allow 200 swapped' sh -c "docker exec ld-s4-cell curl $P -H 'Authorization: $SURROGATE' http://postman-echo.com/headers | grep -q real-secret-value-for-spike"
expect ok "unknown surrogate to www.postman-echo.com (allowlisted, no binding) is forwarded" 'GET www\.postman-echo\.com/headers allow 200$' sh -c "docker exec ld-s4-cell curl $P -H 'Authorization: $UNKNOWN' https://www.postman-echo.com/headers | grep -q '\"authorization\":\"$UNKNOWN\"'"
expect ok "control: www.postman-echo.com verifies against system roots + cell CA" 'GET www\.postman-echo\.com/get allow 200$' docker exec ld-s4-cell curl $PB -f -o /dev/null https://www.postman-echo.com/get
expect ok "control: example.com is allowlisted and reachable through the tunnel (-k)" 'GET example\.com/ allow 200$' docker exec ld-s4-cell curl $PB -k -f -o /dev/null https://example.com/
expect ok "example.com is terminated too: curl rejects its leaf (permitted subtree violation)" 'CONNECT example\.com:443 allow 200$' sh -c "docker exec ld-s4-cell curl $PB -o /dev/null https://example.com/ 2>&1 | grep -q 'permitted subtree violation'"
echo "info  leaf served for example.com: $(docker exec ld-s4-cell curl $PB -k -v -o /dev/null https://example.com/ 2>&1 | grep -E '^\*  (subject|issuer):' | sed 's/^\*  //' | paste -sd ';' - | sed 's/;/; /g')"
echo "info  remote_addr of every audited request: $(jq -rR 'fromjson? | select(.msg == "request") | .audit.remote_addr | sub(":[0-9]+$"; "")' "$LOG" | sort | uniq -c | awk '{printf "%s%s x%s", (NR > 1 ? ", " : ""), $2, $1}')"
echo "info  iron-proxy RSS after the probes: $(ps -o rss= -p "$PROXY_PID" | awk '{printf "%.1f MB", $1 / 1024}')"
echo "--- audit sample"; tail -n 5 "$LOG" | while IFS= read -r line; do redact "$line"; done
echo "failures: $FAILS"
exit "$FAILS"
