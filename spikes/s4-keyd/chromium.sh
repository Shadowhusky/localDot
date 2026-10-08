#!/usr/bin/env bash
# Step 5 per Ruling 27: headless Chromium as abc in the S1 desktop (default bridge), pointed straight at
# iron-proxy through host.docker.internal. No gate: this tests TLS trust, not isolation.
set -euo pipefail
cd "$(dirname "$0")"
LOG=out/chromium-proxy.log
cleanup() {
  docker rm -f ld-s1-desktop >/dev/null 2>&1 || true
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT
start_proxy() {
  if [[ -n "${PROXY_PID:-}" ]]; then kill "$PROXY_PID"; wait "$PROXY_PID" 2>/dev/null || true; fi
  LD_SPIKE_SECRET="real-secret-value-for-spike" bin/iron-proxy --config "$1" >> "$LOG" 2>&1 &
  PROXY_PID=$!
  sleep 2
  kill -0 "$PROXY_PID"
  echo "--- iron-proxy with $1 (tls.mode $(sed -n 's/^  mode: "\(.*\)"/\1/p' "$1"))"
}
# One line per visit: Chromium's page-load result, DOM size and start, then iron-proxy's audit records for the host.
visit() {
  local label=$1 url=$2 host before result dom
  host=${url#https://}; host=${host%%/*}
  before=$(wc -l < "$LOG")
  docker exec -u abc ld-s1-desktop sh -c "timeout 60 chromium --headless=new --proxy-server=http://host.docker.internal:4796 --disable-quic --user-data-dir=/tmp/ld-s4-$label --enable-logging=stderr --dump-dom '$url' > /tmp/$label.html 2> /tmp/$label.err" || true
  result=$(docker exec ld-s1-desktop sh -c "grep -o 'Page load failed: .*' /tmp/$label.err | head -1" || true)
  dom=$(docker exec ld-s1-desktop sh -c "head -c 160 /tmp/$label.html | tr '\n' ' '")
  printf '%-18s %-34s %s; DOM %s bytes: %s\n' "$label" "$url" "${result:-loaded}" "$(docker exec ld-s1-desktop sh -c "wc -c < /tmp/$label.html")" "${dom:-(empty)}"
  sleep 1
  tail -n "+$((before + 1))" "$LOG" | jq -rR --arg h "$host" 'fromjson? | select(.msg == "request" and (.audit.host | sub(":[0-9]+$"; "")) == $h)
    | "      audit: \(.audit.method) \(.audit.host)\(.audit.path) mode=\(.audit.mode) \(.audit.action) \(.audit.status_code)" + (if .rejected_by then " by=\(.rejected_by)" else "" end)'
}
: > "$LOG"
start_proxy iron-proxy.yaml
../s1-stream/run-desktop.sh 1 >/dev/null
for _ in $(seq 120); do docker logs ld-s1-desktop 2>&1 | grep -q '\[ls.io-init\] done' && break; sleep 1; done
# The desktop image ships without certutil.
docker exec ld-s1-desktop sh -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libnss3-tools' >/dev/null 2>&1
echo "desktop: $(docker exec ld-s1-desktop chromium-browser --version); $(docker exec ld-s1-desktop dpkg-query -W libnss3-tools)"
visit before-import https://postman-echo.com/get
docker cp out/ca.crt ld-s1-desktop:/tmp/ca.crt
docker exec -u abc ld-s1-desktop sh -c 'mkdir -p ~/.pki/nssdb && (certutil -d sql:$HOME/.pki/nssdb -N --empty-password 2>/dev/null || true) && certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n ldot -i /tmp/ca.crt'
echo "nssdb: $(docker exec -u abc ld-s1-desktop sh -c 'certutil -d sql:$HOME/.pki/nssdb -L' | awk '$1 == "ldot" {print $1, $2}')"
visit bound-host https://postman-echo.com/get
visit subdomain https://www.postman-echo.com/get
visit outside https://example.com/
docker exec -u abc ld-s1-desktop sh -c "timeout 60 chromium --headless=new --proxy-server=http://host.docker.internal:4796 --disable-quic --user-data-dir=/tmp/ld-s4-netlog --log-net-log=/tmp/netlog.json --dump-dom https://example.com/ >/dev/null 2>&1" || true
docker cp ld-s1-desktop:/tmp/netlog.json out/example-netlog.json
echo "info  Chromium's verifier on example.com: $(jq -r '.constants.logEventTypes.CERT_VERIFY_PROC_PATH_BUILT as $t
  | [.events[] | select(.type == $t and .params.errors != null) | .params] | last
  | "\(.errors | gsub("\n+"; " ") | sub(" $"; "")) (\(.last_cert_trust))"' out/example-netlog.json)"
sed 's/mode: "mitm"/mode: "sni-only"/' iron-proxy.yaml > out/iron-proxy.sni-only.yaml
start_proxy out/iron-proxy.sni-only.yaml
visit sni-bound-host https://postman-echo.com/get
visit sni-outside https://example.com/
echo "info  host curl with the surrogate in sni-only mode, echoed authorization: $(curl -sS -m 15 --proxy http://127.0.0.1:4796 --proxytunnel -H 'Authorization: ld_spike_surrogate_7f3c9a1e5b2d4f60' https://postman-echo.com/headers | jq -r .headers.authorization)"
