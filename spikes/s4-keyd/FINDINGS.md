# S4 findings: key swap proxy and name-constrained CA

2026-09-30 · macOS 26.6.2, Apple M3 Ultra · Docker Desktop 4.60.0 (Engine 29.2.0) · iron-proxy 0.52.0 `darwin_arm64`
(tarball sha256 `ad730f0c…`, checked against the release `checksums.txt`) · cell: `localdot-spike-cell` (Alpine 3.22.6,
curl 8.14.1 / OpenSSL 3.5.8) · desktop: `lscr.io/linuxserver/webtop:ubuntu-xfce` (`73f966bd414c`), Chromium
154.0.8037.57, libnss3-tools 3.120 · host: OpenSSL 3.6.3, jq 1.7.1, Node 25.6.0 · blobs: `run.sh` `4c62b5fc`,
`chromium.sh` `7db09363`, `iron-proxy.yaml` `65140162`, `iron-proxy.brief.yaml` `ffcfcd92`

**Result: build keyd's data plane on goproxy; don't run iron-proxy per cell.** iron-proxy swaps, allowlists and guards
private addresses well, but three of the seven keyd requirements are missing, and each of the four it supports has
gaps keyd would have to close:

- **Selective MITM: missing.** `tls.mode` is process-wide. In `mitm` every tunnelled TLS host gets a leaf from the one CA,
  so the name-constrained cell CA breaks every host outside it: example.com fails in curl (`permitted subtree
  violation`) and in Chromium (`ERR_CERT_INVALID`, verifier: "Not permitted by name constraints"). In `sni-only`
  nothing is terminated, so the bound host isn't swapped either. With iron-proxy the only way out would be an
  unconstrained per-cell CA that terminates all of a cell's TLS.
- **Response scrubbing: missing.** postman-echo reflected `real-secret-value-for-spike` into the cell.
- **Per-listener identity: missing.** One tunnel listener per process, and the audit has only `remote_addr`, which is
  `127.0.0.1` for every gate-relayed request. Per-cell identity would take one process per cell, each binding four TCP
  ports (HTTP, HTTPS and metrics can't be switched off) at 26–37 MB RSS.
- **Gaps in what it supports.** Unknown surrogates are blocked only on hosts with a `require: true` rule. The swap has
  no scheme or port, so plain `http://` to the bound host sends the real value in cleartext. `require: true` rejects
  every CONNECT unless the rule lists methods, and then unlisted methods skip it. The deny list must also name
  `0.0.0.0/8` and `::/128`, or both reach loopback. A TLS handshake the client rejects, and an SNI/Host mismatch,
  leave no audit record.

Worth copying into keyd (Apache-2.0): the dial-time CIDR guard in `net.Dialer.Control`, with `0.0.0.0/8` and `::/128`
added (see Surprises); the Basic-auth-aware header swap (source); the SNI == Host check; and the audit shape (a trace
per transform, secret names but never values). goproxy's per-host MITM is not tested here. The probes in `run.sh` and
`chromium.sh` are the acceptance tests to port.

## keyd requirements in iron-proxy 0.52.0

| Requirement | iron-proxy | Evidence (run 2 and Step 5 unless noted) |
|---|---|---|
| Exact-host swap | supported | `GET postman-echo.com/headers allow 200 swapped`. `www.postman-echo.com` (allowlisted, not bound) echoes the surrogate unswapped, and a surrogate in `X-Api-Key` (not in `match_headers`) stays as it is. Gaps: rules have no scheme or port, so `http://postman-echo.com` (CONNECT `:80`) is swapped and sent in cleartext. A `require: true` rule without `methods` also matches the synthetic CONNECT, so every tunnel is rejected (run 1). Listing methods fixes that, but an unlisted method skips `require` (`PROPFIND` without a surrogate: `allow 404`, see One-off checks). |
| Unknown-surrogate block | supported | Only where a `require: true` rule matches: `GET postman-echo.com/headers reject 403 by=secrets`. Everywhere else it goes through: `ld_spike_unknown_…` reaches `www.postman-echo.com` as it is. There is no rule for "a surrogate-shaped token this host isn't bound to". |
| Private-address block | supported | `upstream_deny_cidrs` is checked after DNS, in `net.Dialer.Control`. `192.168.65.254`, `169.254.169.254`, `127.0.0.1:1234`, the LAN address, `127.0.0.1:4799` and `localhost` (dialled as `::1`) all fail with `denied by upstream_deny_cidrs`, while the controls show that LM Studio and the loopback listener are up. The brief's list misses the unspecified addresses: `0.0.0.0:4799` and `[::]:4799` both reach a listener bound only to `127.0.0.1`. Adding the two CIDRs closes it (One-off checks). |
| Per-listener identity | missing | One `tunnel_listen` per process. The audit has only `remote_addr`: `127.0.0.1` for all 40 requests in run 2, with no listener or cell field. Any container with egress can also reach the listener: Step 5's desktop, on the default bridge, used `host.docker.internal:4796` with no gate. |
| Selective MITM | missing | `mitm` terminates every host: curl and Chromium reject the example.com leaf from the constrained CA. `sni-only` terminates none, and the surrogate is echoed unswapped. There is no per-host mode (`config.TLS` has only `mode`; `serveTunnelTLS` branches on it alone). |
| Response scrubbing | missing | `info  authorization that postman-echo reflected into the cell: real-secret-value-for-spike`. `secrets.TransformResponse` is a no-op. The `grpc` transform can return a modified response (`grpc.go:169`), so an external scrubber is possible (untested); it would receive every buffered response body and need the real values. |
| Audit format | supported | JSON lines on stderr, one record per CONNECT and one per inner request (format below). Secret values and surrogates never appear (0 matches in all three logs); a swap records the secret's source name (`LD_SPIKE_SECRET`). Gaps: no cell identity. A TLS handshake the client aborts after an allowed CONNECT leaves only `CONNECT ... allow 200`. An SNI/Host mismatch 400 is a plain `WARN SNI/Host mismatch` line, not an audit record. |

## Step 5: Chromium and the cell CA

Per Ruling 27: the S1 desktop (`spikes/s1-stream/run-desktop.sh 1`) on the default bridge, and headless Chromium as `abc`
with `--proxy-server=http://host.docker.internal:4796 --disable-quic` and a fresh profile per visit. The result is the
headless handler's `Page load failed: net::…` line, or `loaded`, next to iron-proxy's audit records for the host.

| Visit | Chromium | iron-proxy audit |
|---|---|---|
| postman-echo.com/get before the CA import (control) | `ERR_CERT_AUTHORITY_INVALID` | 2 × `CONNECT ... allow 200`, no request |
| postman-echo.com/get (bound, inside the constraints) | TLS accepted, then `ERR_HTTP_RESPONSE_CODE_FAILURE` | `GET postman-echo.com/get reject 403 by=secrets` |
| www.postman-echo.com/get (inside the constraints, not bound) | loaded, 896-byte DOM with the echo JSON | `GET www.postman-echo.com/get allow 200` |
| example.com (outside the constraints) | `ERR_CERT_INVALID`; NetLog: `Certificate i=0 (CN=example.com) ERROR: Not permitted by name constraints` | 2 × `CONNECT ... allow 200`, no request |
| `sni-only`: postman-echo.com/get | loaded, real certificate | CONNECT, then passthrough records (`mode=sni-only`) |
| `sni-only`: example.com | loaded, real certificate | the same |

- **postman-echo.com is MITM'd and trusted.** The inner `GET` reached iron-proxy, so Chromium accepted the leaf. The 403
  comes from `require: true`, because a browser doesn't send the surrogate. A bound host can't be browsed normally.
- **example.com is terminated too, and rejected.** Chromium treats the cell CA as a constrained anchor
  (`TRUSTED_ANCHOR+enforce_anchor_expiry+enforce_anchor_constraints`) and refuses the example.com leaf that iron-proxy
  minted. iron-proxy can't pass some hosts through and terminate others: that is the missing selective MITM.
- The before-import control shows the NSS import (`certutil -A -t "C,,"`) is what makes postman-echo.com trusted.
  `certutil` isn't in the desktop image, so `chromium.sh` installs `libnss3-tools` first.

## Config differences from the brief and the docs

1. **Listeners.** The brief sets only `tunnel_listen`. Unset, `http_listen`, `https_listen` and `metrics.listen` default to
   `:80`, `:443` and `:9090` on every interface (`config.go` `applyDefaults`). All three always start (`main.go`,
   `proxy.go` `ListenAndServe`); they can only be moved. Both configs pin them to `127.0.0.1:4794`, `:4795` and `:4797`,
   so the brief's config never ran unpinned. The "metrics" server serves only `/healthz`.
2. **`require: true` and CONNECT.** The tunnel runs the whole pipeline on a synthetic CONNECT (`tunnel.go`
   `tunnelTransformCheck`), which carries only the CONNECT's own headers (curl sends `-H` headers to the origin only),
   and `secrets` doesn't skip CONNECT. So the brief's rule rejects the tunnel (run 1: `CONNECT postman-echo.com:443
   reject 403 by=secrets`). Sending the surrogate on the CONNECT too (`--proxy-header`) makes the swap work (One-off
   checks). `iron-proxy.yaml` lists methods on the rule instead, leaving out CONNECT.
3. **Secrets form.** The brief's top-level `proxy_value`, `match_headers` and `require` are the example config's
   "Legacy replace mode (top-level fields, still supported)". The current form nests them under `replace:` (beside
   `inject:`). The legacy form can't carry `match_path` or `match_query`.
4. **Allowlist.** `iron-proxy.yaml` adds `www.postman-echo.com`, `localhost` and the private, `0.0.0.0/8` and `::/128`
   CIDRs, so the private-address probes reach `upstream_deny_cidrs` instead of stopping at the allowlist. That is probe
   design, not a key change.
5. **Keys as the brief wrote them.** `dns.enabled`, `proxy.tunnel_listen`, `proxy.upstream_deny_cidrs`, `tls.mode`
   (`mitm` or `sni-only`), `tls.ca_cert` and `tls.ca_key` (the SEC1 EC key from `make-ca.sh` loads), and `transforms`
   with `allowlist` (`domains`, `cidrs`, `rules`) and `secrets` (`source.type: env`, `var`, `rules[].host`, `methods`).
   `--config` and `--version` work.
6. **Validation.** Top-level keys are strict: `tunel_listen` fails with `field tunel_listen not found in type
   config.Proxy` (exit 1). Keys inside a transform's `config` aren't checked: `requir: true` starts cleanly, with
   `require` off.
7. **Defaults.** Without `upstream_deny_cidrs` the list is only `169.254.169.254/32`, `fd00:ec2::254/128`,
   `fd20:ce::254/128`, `127.0.0.0/8` and `::1/128`; RFC 1918 is left out deliberately (`dnsguard.go`). keyd needs the
   brief's explicit list plus `0.0.0.0/8` and `::/128`. The example config also says that with an upstream proxy
   (`upstream_proxy` or `HTTP(S)_PROXY`) the list applies to the proxy's address, so keyd must run without one (none was
   set here).
8. **Docs.** The release archive holds only `LICENSE`, `README.md` and the binary, so `iron-proxy.example.yaml` came from
   the source tarball at tag `v0.52.0`. The README's config sketch leaves out `tls.mode`, `dns.enabled` and `metrics`.
   It says "Query parameters are always scanned", but the code scans the query only with `match_query: true`. Releases
   come from `paradigmxyz/iron-proxy`; the README and the Go module path say `ironsh/iron-proxy`.
9. **`make-ca.sh`.** The brief's `grep -A2 "Name Constraints"` shows only the first name; the committed script uses
   `-A3`.

## Surprises

1. **The unspecified addresses reach loopback.** The guard checks the literal dial address, but a dial to `0.0.0.0` or
   `::` lands on loopback. During a proxied `http://[::]:1234` request, `lsof` showed iron-proxy's socket as
   `127.0.0.1:57744->127.0.0.1:1234`. A name that resolves to `0.0.0.0` would get the same result.
2. **The inner request picks the upstream.** Plain HTTP inside `CONNECT example.com:80` with `Host: postman-echo.com`
   was swapped and delivered to postman-echo.com (audit: `tunnel.target` `example.com:80`, `host`
   `postman-echo.com`). Over TLS, SNI must equal Host (otherwise 400). Because the allowlist and the swap follow the
   inner request this is safe in iron-proxy, but keyd must also decide on the inner request, not on the CONNECT.
3. **Leaves carry CN plus one DNS SAN** (the SNI), and Go signs them whatever the CA's constraints (`certcache.go`).
   iron-proxy never notices that it is minting certificates the cell will refuse.
4. **Browser chatter.** The 7 headless Chromium starts in Step 5 also sent Chromium's own requests through the proxy:
   61 allowlist rejections (`www.google.com` 30; `accounts.google.com`, `update.googleapis.com`, `clients2.google.com`
   and `redirector.gvt1.com` 7 each; `connectivitycheck.gstatic.com` 3).

## Audit line format

A swapped request inside a tunnel (run 2, pretty-printed):
```json
{
  "time": "2026-09-30T23:39:20.734913+01:00",
  "level": "INFO",
  "msg": "request",
  "audit": {
    "host": "postman-echo.com",
    "method": "GET",
    "path": "/headers",
    "remote_addr": "127.0.0.1:58203",
    "sni": "postman-echo.com",
    "mode": "mitm",
    "action": "allow",
    "status_code": 200,
    "duration_ms": 146.339
  },
  "tunnel": {
    "target": "postman-echo.com:443",
    "request_transforms": [
      {
        "name": "allowlist",
        "action": "allow",
        "duration_ms": 0.001
      },
      {
        "name": "secrets",
        "action": "allow",
        "duration_ms": 0
      }
    ]
  },
  "request_transforms": [
    {
      "name": "allowlist",
      "action": "allow",
      "duration_ms": 0
    },
    {
      "name": "secrets",
      "action": "allow",
      "duration_ms": 0.009,
      "annotations": {
        "swapped": [
          {
            "secret": "LD_SPIKE_SECRET",
            "locations": [
              "header:Authorization"
            ]
          }
        ]
      }
    }
  ],
  "response_transforms": [
    {
      "name": "allowlist",
      "action": "allow",
      "duration_ms": 0
    },
    {
      "name": "secrets",
      "action": "allow",
      "duration_ms": 0
    }
  ]
}
```
- One JSON object per line on stderr (Go `slog`), mixed with non-audit lines such as `tunnel short-circuited by
  transform` and the startup messages. Audit records have `"msg": "request"`.
- `level`: `INFO` for allow, stub and client_cancel; `WARN` for reject; `ERROR` for error.
- `audit`: `host` (with `:port` on a CONNECT), `method` (empty on an `sni-only` passthrough), `path`, `remote_addr`,
  `sni` (empty for plain HTTP), `mode` (`mitm` or `sni-only`), `action` (`allow`, `reject`, `error`, `client_cancel`,
  `stub`), `status_code` and `duration_ms`.
- `tunnel`: on a request inside a CONNECT, the CONNECT's `target` and its `request_transforms`.
- `rejected_by` names the rejecting transform. `error` holds the failure, such as the deny-list dial error.
- `request_transforms` and `response_transforms`: `{name, action, duration_ms, error?, annotations?}`. `secrets`
  annotates `swapped: [{secret, locations}]`, `rejected`, `reject_reason` and `secret_unavailable`, where `secret` is
  the source name.
- A tunnelled request gives two records, the CONNECT then the request, linked only by `remote_addr` and
  `tunnel.target`.

The other outcomes, verbatim (run 2, and Step 5 for `sni-only`):
```
# reject by secrets on the inner GET (no surrogate)
{"time":"2026-09-30T23:39:21.132597+01:00","level":"WARN","msg":"request","audit":{"host":"postman-echo.com","method":"GET","path":"/headers","remote_addr":"127.0.0.1:58207","sni":"postman-echo.com","mode":"mitm","action":"reject","status_code":403,"duration_ms":0.007},"tunnel":{"target":"postman-echo.com:443","request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"allow","duration_ms":0.001}]},"rejected_by":"secrets","request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"reject","duration_ms":0.002,"annotations":{"rejected":"LD_SPIKE_SECRET"}}]}
# reject by allowlist on the CONNECT (unlisted host)
{"time":"2026-09-30T23:39:21.968081+01:00","level":"WARN","msg":"request","audit":{"host":"www.wikipedia.org:443","method":"CONNECT","path":"","remote_addr":"127.0.0.1:58213","sni":"www.wikipedia.org","mode":"mitm","action":"reject","status_code":403,"duration_ms":0.029},"rejected_by":"allowlist","request_transforms":[{"name":"allowlist","action":"reject","duration_ms":0.003}]}
# error: deny list at dial time (private address)
{"time":"2026-09-30T23:39:22.355598+01:00","level":"ERROR","msg":"request","audit":{"host":"192.168.65.254","method":"GET","path":"/","remote_addr":"127.0.0.1:58218","sni":"","mode":"mitm","action":"error","status_code":502,"duration_ms":0.078},"tunnel":{"target":"192.168.65.254:80","request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.003},{"name":"secrets","action":"allow","duration_ms":0}]},"error":"dial tcp 192.168.65.254:80: denied by upstream_deny_cidrs: 192.168.65.254 in 192.168.0.0/16","request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"allow","duration_ms":0}]}
# run 1: the brief's rule rejecting the CONNECT itself
{"time":"2026-09-30T23:39:08.593661+01:00","level":"WARN","msg":"request","audit":{"host":"postman-echo.com:443","method":"CONNECT","path":"","remote_addr":"127.0.0.1:58124","sni":"postman-echo.com","mode":"mitm","action":"reject","status_code":403,"duration_ms":0.029},"rejected_by":"secrets","request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"reject","duration_ms":0.005,"annotations":{"rejected":"LD_SPIKE_SECRET"}}]}
# sni-only passthrough (Step 5)
{"time":"2026-09-30T23:39:49.096272+01:00","level":"INFO","msg":"request","audit":{"host":"postman-echo.com","method":"","path":"","remote_addr":"127.0.0.1:58429","sni":"postman-echo.com","mode":"sni-only","action":"allow","status_code":200,"duration_ms":38.499},"request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0},{"name":"secrets","action":"allow","duration_ms":0}]}
```

## Run 1: brief config (`CONFIG=iron-proxy.brief.yaml spikes/s4-keyd/run.sh`; 23:39:05 BST; exit 16, 12 s)

Only the brief's `unlisted host` line passes. Its swap line fails, and every other `blocked` line is stopped by the wrong
mechanism: the CONNECT rather than the request, or the allowlist rather than the deny list.
```
config: iron-proxy.brief.yaml; iron-proxy 0.52.0
info  iron-proxy listeners: 127.0.0.1:4794 127.0.0.1:4795 127.0.0.1:4796 127.0.0.1:4797; RSS 25.7 MB
--- brief probes
FAIL  blocked  surrogate swapped for bound host (wanted ok)
      audit: CONNECT postman-echo.com:443 reject 403 by=secrets
FAIL  blocked  request without surrogate (require: true) (wrong reason)
      audit: CONNECT postman-echo.com:443 reject 403 by=secrets
FAIL  blocked  unknown surrogate (wrong reason)
      audit: CONNECT postman-echo.com:443 reject 403 by=secrets
ok    blocked  unlisted host
      audit: CONNECT www.wikipedia.org:443 reject 403 by=allowlist
FAIL  blocked  private address (docker host) (wrong reason)
      audit: CONNECT 192.168.65.254:80 reject 403 by=allowlist
FAIL  blocked  metadata address (wrong reason)
      audit: CONNECT 169.254.169.254:80 reject 403 by=allowlist
FAIL  blocked  host loopback (LM Studio port) (wrong reason)
      audit: CONNECT 127.0.0.1:1234 reject 403 by=allowlist
--- controls and keyd requirements
ok    ok       control: host -> 127.0.0.1:1234 directly (LM Studio is up)
FAIL  blocked  allowlisted name resolving to loopback (localhost:1234) (wrong reason)
      audit: CONNECT localhost:1234 reject 403 by=allowlist
ok    ok       control: host -> 192.168.1.241:1234 directly
FAIL  blocked  host LAN address 192.168.1.241:1234 (wrong reason)
      audit: CONNECT 192.168.1.241:1234 reject 403 by=allowlist
ok    ok       control: host -> 127.0.0.1:4799 directly (listener bound to 127.0.0.1 only)
FAIL  blocked  127.0.0.1:4799 through the proxy (wrong reason)
      audit: CONNECT 127.0.0.1:4799 reject 403 by=allowlist
FAIL  blocked  0.0.0.0:4799 reaches the same loopback-only listener (0.0.0.0/8 not in the deny list) (wanted ok)
      audit: CONNECT 0.0.0.0:4799 reject 403 by=allowlist
FAIL  blocked  [::]:4799 reaches the same loopback-only listener (::/128 not in the deny list) (wanted ok)
      audit: CONNECT [::]:4799 reject 403 by=allowlist
info  authorization that postman-echo reflected into the cell: none (request failed)
FAIL  blocked  surrogate in X-Api-Key (not in match_headers) is not swapped (wanted ok)
      audit: CONNECT postman-echo.com:443 reject 403 by=secrets
FAIL  blocked  exact host: surrogate sent to www.postman-echo.com arrives unswapped (wanted ok)
      audit: CONNECT www.postman-echo.com:443 reject 403 by=allowlist
FAIL  blocked  plain http:// to the bound host is swapped too (real value leaves in cleartext) (wanted ok)
      audit: CONNECT postman-echo.com:80 reject 403 by=secrets
FAIL  blocked  unknown surrogate to www.postman-echo.com (allowlisted, no binding) is forwarded (wanted ok)
      audit: CONNECT www.postman-echo.com:443 reject 403 by=allowlist
FAIL  blocked  control: www.postman-echo.com verifies against system roots + cell CA (wanted ok)
      audit: CONNECT www.postman-echo.com:443 reject 403 by=allowlist
ok    ok       control: example.com is allowlisted and reachable through the tunnel (-k)
      audit: CONNECT example.com:443 allow 200 | GET example.com/ allow 200
ok    ok       example.com is terminated too: curl rejects its leaf (permitted subtree violation)
      audit: CONNECT example.com:443 allow 200
info  leaf served for example.com: subject: CN=example.com; issuer: CN=localDot cell CA (spike)
info  remote_addr of every audited request: 127.0.0.1 x23
info  iron-proxy RSS after the probes: 33.6 MB
--- audit sample
(5 raw audit lines elided: the same example.com CONNECT and GET records as run 2's sample)
failures: 16
```

## Run 2: `spikes/s4-keyd/run.sh` (23:39:17 BST; exit 0, 14 s)
```
config: iron-proxy.yaml; iron-proxy 0.52.0
info  iron-proxy listeners: 127.0.0.1:4794 127.0.0.1:4795 127.0.0.1:4796 127.0.0.1:4797; RSS 25.9 MB
--- brief probes
ok    ok       surrogate swapped for bound host
      audit: CONNECT postman-echo.com:443 allow 200 | GET postman-echo.com/headers allow 200 swapped
ok    blocked  request without surrogate (require: true)
      audit: CONNECT postman-echo.com:443 allow 200 | GET postman-echo.com/headers reject 403 by=secrets
ok    blocked  unknown surrogate
      audit: CONNECT postman-echo.com:443 allow 200 | GET postman-echo.com/headers reject 403 by=secrets
ok    blocked  unlisted host
      audit: CONNECT www.wikipedia.org:443 reject 403 by=allowlist
ok    blocked  private address (docker host)
      audit: CONNECT 192.168.65.254:80 allow 200 | GET 192.168.65.254/ error 502 err=dial tcp 192.168.65.254:80: denied by upstream_deny_cidrs: 192.168.65.254 in 192.168.0.0/16
ok    blocked  metadata address
      audit: CONNECT 169.254.169.254:80 allow 200 | GET 169.254.169.254/ error 502 err=dial tcp 169.254.169.254:80: denied by upstream_deny_cidrs: 169.254.169.254 in 169.254.0.0/16
ok    blocked  host loopback (LM Studio port)
      audit: CONNECT 127.0.0.1:1234 allow 200 | GET 127.0.0.1:1234/v1/models error 502 err=dial tcp 127.0.0.1:1234: denied by upstream_deny_cidrs: 127.0.0.1 in 127.0.0.0/8
--- controls and keyd requirements
ok    ok       control: host -> 127.0.0.1:1234 directly (LM Studio is up)
ok    blocked  allowlisted name resolving to loopback (localhost:1234)
      audit: CONNECT localhost:1234 allow 200 | GET localhost:1234/v1/models error 502 err=dial tcp [::1]:1234: denied by upstream_deny_cidrs: ::1 in ::1/128
ok    ok       control: host -> 192.168.1.241:1234 directly
ok    blocked  host LAN address 192.168.1.241:1234
      audit: CONNECT 192.168.1.241:1234 allow 200 | GET 192.168.1.241:1234/v1/models error 502 err=dial tcp 192.168.1.241:1234: denied by upstream_deny_cidrs: 192.168.1.241 in 192.168.0.0/16
ok    ok       control: host -> 127.0.0.1:4799 directly (listener bound to 127.0.0.1 only)
ok    blocked  127.0.0.1:4799 through the proxy
      audit: CONNECT 127.0.0.1:4799 allow 200 | GET 127.0.0.1:4799/ error 502 err=dial tcp 127.0.0.1:4799: denied by upstream_deny_cidrs: 127.0.0.1 in 127.0.0.0/8
ok    ok       0.0.0.0:4799 reaches the same loopback-only listener (0.0.0.0/8 not in the deny list)
      audit: CONNECT 0.0.0.0:4799 allow 200 | GET 0.0.0.0:4799/ allow 200
ok    ok       [::]:4799 reaches the same loopback-only listener (::/128 not in the deny list)
      audit: CONNECT [::]:4799 allow 200 | GET [::]:4799/ allow 200
info  authorization that postman-echo reflected into the cell: real-secret-value-for-spike
ok    ok       surrogate in X-Api-Key (not in match_headers) is not swapped
      audit: CONNECT postman-echo.com:443 allow 200 | GET postman-echo.com/headers allow 200 swapped
ok    ok       exact host: surrogate sent to www.postman-echo.com arrives unswapped
      audit: CONNECT www.postman-echo.com:443 allow 200 | GET www.postman-echo.com/headers allow 200
ok    ok       plain http:// to the bound host is swapped too (real value leaves in cleartext)
      audit: CONNECT postman-echo.com:80 allow 200 | GET postman-echo.com/headers allow 200 swapped
ok    ok       unknown surrogate to www.postman-echo.com (allowlisted, no binding) is forwarded
      audit: CONNECT www.postman-echo.com:443 allow 200 | GET www.postman-echo.com/headers allow 200
ok    ok       control: www.postman-echo.com verifies against system roots + cell CA
      audit: CONNECT www.postman-echo.com:443 allow 200 | GET www.postman-echo.com/get allow 200
ok    ok       control: example.com is allowlisted and reachable through the tunnel (-k)
      audit: CONNECT example.com:443 allow 200 | GET example.com/ allow 200
ok    ok       example.com is terminated too: curl rejects its leaf (permitted subtree violation)
      audit: CONNECT example.com:443 allow 200
info  leaf served for example.com: subject: CN=example.com; issuer: CN=localDot cell CA (spike)
info  remote_addr of every audited request: 127.0.0.1 x40
info  iron-proxy RSS after the probes: 36.7 MB
--- audit sample
{"time":"2026-09-30T23:39:29.551393+01:00","level":"INFO","msg":"request","audit":{"host":"example.com:443","method":"CONNECT","path":"","remote_addr":"127.0.0.1:58268","sni":"example.com","mode":"mitm","action":"allow","status_code":200,"duration_ms":0.003},"request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"allow","duration_ms":0}]}
{"time":"2026-09-30T23:39:29.583703+01:00","level":"INFO","msg":"request","audit":{"host":"example.com","method":"GET","path":"/","remote_addr":"127.0.0.1:58268","sni":"example.com","mode":"mitm","action":"allow","status_code":200,"duration_ms":28.347},"tunnel":{"target":"example.com:443","request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"allow","duration_ms":0}]},"request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.005},{"name":"secrets","action":"allow","duration_ms":0}],"response_transforms":[{"name":"allowlist","action":"allow","duration_ms":0},{"name":"secrets","action":"allow","duration_ms":0}]}
{"time":"2026-09-30T23:39:29.993693+01:00","level":"INFO","msg":"request","audit":{"host":"example.com:443","method":"CONNECT","path":"","remote_addr":"127.0.0.1:58270","sni":"example.com","mode":"mitm","action":"allow","status_code":200,"duration_ms":0.003},"request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"allow","duration_ms":0}]}
{"time":"2026-09-30T23:39:30.399693+01:00","level":"INFO","msg":"request","audit":{"host":"example.com:443","method":"CONNECT","path":"","remote_addr":"127.0.0.1:58277","sni":"example.com","mode":"mitm","action":"allow","status_code":200,"duration_ms":0.004},"request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"allow","duration_ms":0}]}
{"time":"2026-09-30T23:39:30.412314+01:00","level":"INFO","msg":"request","audit":{"host":"example.com","method":"GET","path":"/","remote_addr":"127.0.0.1:58277","sni":"example.com","mode":"mitm","action":"allow","status_code":200,"duration_ms":8.605},"tunnel":{"target":"example.com:443","request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.001},{"name":"secrets","action":"allow","duration_ms":0}]},"request_transforms":[{"name":"allowlist","action":"allow","duration_ms":0.006},{"name":"secrets","action":"allow","duration_ms":0}],"response_transforms":[{"name":"allowlist","action":"allow","duration_ms":0},{"name":"secrets","action":"allow","duration_ms":0}]}
failures: 0
```

## Step 5: `spikes/s4-keyd/chromium.sh` (23:39:31 BST; exit 0, 21 s)
```
--- iron-proxy with iron-proxy.yaml (tls.mode mitm)
desktop: Chromium 154.0.8037.57 built on Ubuntu 26.04.1 LTS; libnss3-tools	2:3.120-1ubuntu2.1
before-import      https://postman-echo.com/get       Page load failed: net::ERR_CERT_AUTHORITY_INVALID; DOM 0 bytes: (empty)
      audit: CONNECT postman-echo.com:443 mode=mitm allow 200
      audit: CONNECT postman-echo.com:443 mode=mitm allow 200
nssdb: ldot C,,
bound-host         https://postman-echo.com/get       Page load failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE; DOM 0 bytes: (empty)
      audit: CONNECT postman-echo.com:443 mode=mitm allow 200
      audit: CONNECT postman-echo.com:443 mode=mitm allow 200
      audit: GET postman-echo.com/get mode=mitm reject 403 by=secrets
subdomain          https://www.postman-echo.com/get   loaded; DOM 896 bytes: <html><head><meta name="color-scheme" content="light dark"><meta charset="utf-8"></head><body><pre>{"args":{},"headers":{"host":"www.postman-echo.com","accept-e
      audit: CONNECT www.postman-echo.com:443 mode=mitm allow 200
      audit: CONNECT www.postman-echo.com:443 mode=mitm allow 200
      audit: GET www.postman-echo.com/get mode=mitm allow 200
      audit: GET www.postman-echo.com/favicon.ico mode=mitm client_cancel 200
outside            https://example.com/               Page load failed: net::ERR_CERT_INVALID; DOM 0 bytes: (empty)
      audit: CONNECT example.com:443 mode=mitm allow 200
      audit: CONNECT example.com:443 mode=mitm allow 200
info  Chromium's verifier on example.com: ----- Certificate i=0 (CN=example.com) ----- ERROR: Not permitted by name constraints (TRUSTED_ANCHOR+enforce_anchor_expiry+enforce_anchor_constraints)
--- iron-proxy with out/iron-proxy.sni-only.yaml (tls.mode sni-only)
sni-bound-host     https://postman-echo.com/get       loaded; DOM 888 bytes: <html><head><meta name="color-scheme" content="light dark"><meta charset="utf-8"></head><body><pre>{"args":{},"headers":{"host":"postman-echo.com","sec-fetch-us
      audit: CONNECT postman-echo.com:443 mode=sni-only allow 200
      audit: CONNECT postman-echo.com:443 mode=sni-only allow 200
      audit:  postman-echo.com mode=sni-only allow 200
      audit:  postman-echo.com mode=sni-only allow 200
sni-outside        https://example.com/               loaded; DOM 12749 bytes: <!DOCTYPE html> <html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><t
      audit: CONNECT example.com:443 mode=sni-only allow 200
      audit: CONNECT example.com:443 mode=sni-only allow 200
      audit:  example.com mode=sni-only allow 200
      audit:  example.com mode=sni-only allow 200
info  host curl with the surrogate in sni-only mode, echoed authorization: ld_spike_surrogate_7f3c9a1e5b2d4f60
```

## Steps 1 and 2

```
$ spikes/s4-keyd/fetch-iron-proxy.sh
iron-proxy.tgz: OK
0.52.0
$ spikes/s4-keyd/make-ca.sh
            X509v3 Name Constraints: critical
                Permitted:
                  DNS:postman-echo.com
                  DNS:api.anthropic.com
```
The archive contains `LICENSE`, `README.md` and `iron-proxy` (51,153,378 bytes).

## One-off checks

Run by hand against iron-proxy on the host (tunnel `127.0.0.1:4796`, no gate) with `iron-proxy.yaml` unless noted:

- **Surrogate on the CONNECT too (brief config):** `curl --proxy http://127.0.0.1:4796 --proxytunnel --cacert
  out/ca.crt --proxy-header 'Authorization: <surrogate>' -H 'Authorization: <surrogate>'
  https://postman-echo.com/headers` got `200 Connection Established`, then HTTP/2 200 with `"authorization":
  "real-secret-value-for-spike"`.
- **Plain HTTP, absolute-form (no CONNECT):** `curl --proxy http://127.0.0.1:4796 -H 'Authorization: <surrogate>'
  http://postman-echo.com/headers` echoed the real value; audit: `GET postman-echo.com/headers`, `sni` empty,
  `swapped`.
- **Unlisted method:** without a surrogate, `curl ... -X GET https://postman-echo.com/headers` got 403 (`reject
  by=secrets`), and `-X PROPFIND` got 404 from postman-echo (`PROPFIND postman-echo.com/headers allow 404`).
- **Validation:** a copy of the config with `tunnel_listen` misspelt `tunel_listen` exited 1 with `parsing config: yaml:
  unmarshal errors: line 6: field tunel_listen not found in type config.Proxy`. A copy with `require` misspelt `requir`
  was still running 2 s later, with `transform pipeline: allowlist → secrets`. Both copies used other ports.
- **Unspecified addresses:** with `0.0.0.0/8` and `::/128` allowlisted, `http://0.0.0.0:1234/v1/models` and
  `http://[::]:1234/v1/models` returned 200 from LM Studio. With both also in `upstream_deny_cidrs`, `0.0.0.0:4799` and
  `[::]:4799` failed with `denied by upstream_deny_cidrs: 0.0.0.0 in 0.0.0.0/8` and `:: in ::/128`. Outside the proxy,
  `curl http://0.0.0.0:4799/` returned 200 from a `python3 -m http.server --bind 127.0.0.1` listener; `[::]` did not
  connect.
- **Host vs CONNECT target:** `curl ... --proxytunnel -H 'Host: postman-echo.com' -H 'Authorization: <surrogate>'
  http://example.com/headers` echoed the real value from postman-echo.com. Over TLS (`-k`, `https://example.com/headers`)
  it got 400, logged only as `WARN SNI/Host mismatch {"sni":"example.com","host":"postman-echo.com"}`.

## Method

- **Topology (`run.sh`).** iron-proxy runs on the host from `bin/`, with `LD_SPIKE_SECRET` only in its environment. The
  cell sits alone on `ld-s4-sbx` (`--internal`, `gateway_mode_ipv4=isolated`, as S3 requires). The gate `ld-s4-gate` is
  on that network and its own `ld-s4-egress`, and relays `3128` to `host.docker.internal:4796` with socat. The cell gets
  `out/ca.crt` by `docker cp` (no bind mounts) and builds `/tmp/roots-and-cell-ca.crt` (system roots plus the cell CA)
  for the lines that need a real certificate to verify.
- **Probe discipline.** Every probe runs curl in the cell through the gate. `expect` notes the log length, runs the
  probe, waits for the log to stop growing and matches the probe's own audit records against a regex naming the
  expected mechanism: `by=secrets` on the inner `GET`, `by=allowlist` on the CONNECT, `denied by upstream_deny_cidrs:
  <address>`, or `swapped`. A `blocked` line stopped by anything else fails as "wrong reason", which is what run 1
  shows. Controls hit the same targets straight from the host: LM Studio on `*:1234`, the LAN address, and S3's
  `host-listener.mjs` bound to `127.0.0.1:4799`.
- **Step 5 (`chromium.sh`).** As described above. The verifier's reason comes from a NetLog (`--log-net-log`,
  `CERT_VERIFY_PROC_PATH_BUILT.errors`). The `sni-only` phase restarts iron-proxy with `tls.mode` switched in a copy of
  `iron-proxy.yaml`.
- **Source.** The v0.52.0 source tarball was read for defaults and code paths; the file names are cited above. Claims
  marked "source" were read, not measured.
- **Secret hygiene.** `real-secret-value-for-spike` is a dummy that lives only in iron-proxy's environment. The cell holds
  only surrogates. `grep -c` for the real value and both surrogates is 0 in each final log.

## Cleanup

`run.sh` and `chromium.sh` remove `ld-s4-cell`, `ld-s4-gate`, `ld-s4-sbx`, `ld-s4-egress` and `ld-s1-desktop`, and stop
iron-proxy and the listener on exit. After the last runs `docker ps -a` and `docker network ls` show no `ld-*`
entries, `pgrep -fl iron-proxy` finds nothing and nothing listens on 4790–4799. `bin/` (the binary) and `out/` (the CA
key and the logs) are git-ignored.
