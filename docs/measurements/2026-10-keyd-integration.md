# Credential service integration — 2026-10-02

The integration branch combines the completed desktop implementation with
Part 4a at `3d15bdd`. That base passes 622 host tests, all 13 Go packages,
workspace type checks, lint and hygiene. M3 acceptance is still open.

## Task 1: address guard and discovery

The remaining special IPv6 ranges are denied, with global unicast and the
checked well-known NAT64 prefix as the IPv6 boundary. Public IPv4 discovery asks
the router first, falls back to STUN only when needed, retains learned addresses
for the guard, backs off after repeated failures and refreshes on network
changes. The admin status reports active, unknown or off. Tests and temporary
instances disable real network discovery or use loopback fake servers.

Review reproduced three failures in the plan implementation: starting with Stop
already closed still queried a router; Stop during router lookup could start a
new STUN request; and the first failed query on a changed network borrowed the
old network's active-state grace. Discovery now checks shutdown synchronously,
cancels connected UDP reads, and resets that grace on a changed network without
discarding previously denied addresses. Daemon shutdown joins the discovery
worker. The macOS gateway lookup command also has a three-second timeout.

- All 13 Go packages pass `go test -race ./... -count=1` after these changes.
- Seven mutations fail their intended runtime assertions: IPv6 boundary,
  benchmarking range, learned-address denial, router-first preference, STUN
  transaction ID, network-change status and cancellation of a pending UDP read.
- Native/Darwin/Linux vet, formatting, lint and hygiene pass.
- Evidence: `/tmp/localdot-part4b-task1-red.log`,
  `/tmp/localdot-part4b-task1-review-red.log`,
  `/tmp/localdot-part4b-task1-full.log`, and
  `/tmp/localdot-part4b-task1-mutation-run.log`.

The command tests keep the improved Part 4a shutdown and input-validation
behaviour; the discovery tests are in their own file. Live NAT-PMP/STUN was not
used. The plan's router-IPv6 limitation remains: discovery learns public IPv4.

## Task 2: protocol, browser sealing and readiness

The protocol now defines strict sealed-key requests, validated keyd replies,
the browser's ECDH/HKDF/AES-GCM seal, key/budget events and the eleven-check boot
report. Browser and Go known-answer vectors agree in both directions. The event
JSON schema is regenerated.

Review fixed two plan mismatches: the provider enum now includes all ten
providers in the amended Go gateway, and readiness verifies each required
check's kind as well as its ID, uniqueness and result. A gateway isolation check
cannot be relabelled as a trust check. Extra plaintext fields in either binding,
the sealed blob or its envelope are refused.

- All 46 protocol tests in eight files pass; workspace type checks, lint and
  hygiene pass.
- Twelve deliberate regressions fail runtime assertions: strict envelopes and
  nested objects, authenticated binding, methods, fresh nonces, missing/relabelled
  checks, report-summary trust, reserved IDs, environment-name collisions and
  unknown guard states. An initial scratch-run configuration error was fixed;
  it is not counted as a caught mutation.
- Evidence: `/tmp/localdot-part4b-task2-review-red.log`,
  `/tmp/localdot-part4b-task2-final-scoped.log`,
  `/tmp/localdot-part4b-task2-final-types.log`, and
  `/tmp/localdot-part4b-task2-mutation-retry.log`.

## Task 3: daemon client and real-service harness

The daemon client checks the Unix socket and its folder before requests,
validates replies, relays sealed bindings unchanged, manages cell credentials
and reads keyd events. Test ports can be selected independently from production.
The opt-in keyd and Docker configurations build the service into a temporary
directory and clean it afterward.

Review added whole-request deadlines and a separate event handshake deadline,
a 1 MiB JSON reply limit, a 64 KiB event-line limit, cancellation before opening
a stream and during a buffered batch, and a safe error for unstructured backend
replies. An event consumer failure rejects the stream rather than escaping the
socket callback. Established event streams can remain idle. Failed process
startup removes its owned home, and failed builds remove their temporary output.

- The full host suite passes 666 tests in 88 files. The focused client/port
  suites pass 25 tests. Workspace type checks, lint and hygiene pass.
- Four tests against the built Go service pass: browser sealing and binding
  authentication; open/use/event/revoke/remint/close; delete; and failed process
  startup cleanup. A revoked token is explicitly refused on the real listener.
  Tests use an in-memory vault and `-natpmp off -stun off`. Ports 4791–4796 were
  selected because an existing unrelated listener occupied 4797.
- Fourteen deliberate regressions fail runtime assertions: socket privacy and
  permissions, sealed binding preservation, actually revoking credentials,
  response/line bounds, request/handshake deadlines, aborted and idle streams,
  error redaction, reply validation, consumer exceptions and buffered delivery
  after cancellation.
- No test keyd process remains. The Tailscale avatar preview still returns HTTPS
  200; its running services were not changed by this integration work.
- Evidence: `/tmp/localdot-part4b-task3-full-host.log`,
  `/tmp/localdot-part4b-task3-real-final.log`,
  `/tmp/localdot-part4b-task3-review-red.log`,
  `/tmp/localdot-part4b-task3-consumer-red.log`,
  `/tmp/localdot-part4b-task3-batch-red.log`,
  `/tmp/localdot-part4b-task3-mutation-run.log`, and the final two runtime mutation
  logs under `/var/folders/lj/n6y361z92bbf8_sc2fkh0cf80000gn/T/localdot-p4b-task3-final-mut-p8ff9wrr/`.

## Task 4: key API, health monitor and doctor

The four key routes are behind the install token and existing Host/Origin guards.
They accept only the strict sealed envelope, cap requests at 64 KiB, relay its
authenticated binding unchanged, and distinguish stale seals, offline service,
binding errors and vault failure. Doctor checks both audit availability and the
hairpin guard; its subprocess test uses a disposable home.

Review reproduced simultaneous saves reserving the same environment name,
overlapping health requests, late replies notifying after shutdown, duplicate
timers after restart, and an unhandled asynchronous health subscriber. Key
mutations now serialize through the subsequent computer refresh. Polling shares
an in-flight request and invalidates stopped generations. Subscriber failures
are isolated and logged without their message. A successful key write whose
computer refresh fails returns `restart: true`; it is not misreported as a failed
write. Deletion has already revoked the key in keyd before its refresh callback.

- The full host suite passes 691 tests in 90 files; workspace types, lint and
  hygiene pass. The focused route/monitor/doctor suite has 48 tests.
- Two real-service route tests pass: browser sealing, binding tamper refusal,
  no plaintext in daemon storage/responses, and rejection after a new service
  boot. Together with Task 3, six real-keyd integration tests have passed.
- Eleven deliberate regressions fail runtime assertions: envelope/body limits,
  name collisions and concurrent writes, refresh notification, stale-seal error,
  overlapping/stopped health polls, audit and guard failure, and authentication.
- Evidence: `/tmp/localdot-part4b-task4-review-red.log`,
  `/tmp/localdot-part4b-task4-full-host.log`,
  `/tmp/localdot-part4b-task4-real.log`,
  `/tmp/localdot-part4b-task4-final-types.log`, and
  `/tmp/localdot-part4b-task4-mutation-run.log`.

## Task 5: container files and pause support

The Docker client uploads binary tar data directly to a stopped or running
container. The flat regular-file writer preserves bytes and permission modes;
it refuses path names, duplicate entries and invalid numeric headers. No
credential data is placed in exec arguments or a host bind mount. The fake
Docker now keeps extracted files and models paused state in inspect and actions.

The real Docker test exposed a mismatch in the plan: Engine 29.2 returns 500
when unpause targets a non-paused container, whether running or stopped. The
fake matches that result. Pause on a stopped/already-paused container and start
on a paused one return 409. A stop of a paused container does stop and unfreeze
it. Task 10 must inspect paused state and must not assume every redundant
unpause returns 409 or treat an arbitrary 500 as success.

- All 698 host tests in 91 files pass, with workspace type checks, lint and
  hygiene. System tar extracts binary, Unicode, empty and multi-block files.
- Two real Docker API tests pass, including exact binary extraction and mode
  `640:0:0`, a live replacement, pause/unpause and stop while paused. The probe
  uses the existing gate image with no network and leaves no container behind.
- Eight mutations fail runtime assertions: path/duplicate acceptance,
  permission loss, binary corruption, wrong upload type/encoding, ignored
  pause and the incorrect unpause status.
- Evidence: `/tmp/localdot-part4b-task5-full-host.log`,
  `/tmp/localdot-part4b-task5-docker.log`,
  `/tmp/localdot-part4b-task5-docker-review.log`,
  `/tmp/localdot-part4b-task5-docker-final.log`, and
  `/tmp/localdot-part4b-task5-mutation-run.log`.

## Task 6: cell proxy forwarder

The separately bundled forwarder listens only on cell loopback, reads the proxy
token for each request, replaces client proxy credentials, and relays HTTP and
CONNECT through the configured gate. Proxy challenges become a 502 with a safe
reason, and missing/invalid material fails closed. Its private HTTP agent ignores
the process's proxy environment.

Review reproduced connection-nominated headers crossing hops, upstream HTTP
requests and pending tunnels surviving a client disconnect, truncated replies
hanging clients, invalid token callbacks reaching the gate, and unbounded
handshakes. These are fixed. HTTP and CONNECT handshakes have a 30-second bound;
established streams remain usable. Both directions preserve bytes pipelined
alongside CONNECT headers. Unsolicited upgrades are refused. The environment
proxy test explicitly clears both NO_PROXY spellings so a loopback exemption
cannot hide a leak.

- All 716 host tests in 93 files pass, including 18 forwarder checks. Workspace
  types, lint, hygiene and both desktopd bundles pass.
- The built forwarder passes a network-isolated smoke run in the actual desktop
  image's Node 24.21.0: HTTP, CONNECT echo, token rotation, hidden 407 and zero
  contacts to the environment-proxy trap. The temporary container is removed.
  This is runtime-specific verification, not a full Node 24 workspace test run.
- Twelve mutations fail runtime assertions: missing/wrong proxy credentials,
  exposed challenges, hop headers, cancellation, handshake deadline, truncated
  replies, global environment proxy, malformed token and either CONNECT head.
- Evidence: `/tmp/localdot-part4b-task6-review-red.log`,
  `/tmp/localdot-part4b-task6-scoped-final.log`,
  `/tmp/localdot-part4b-task6-full-host.log`,
  `/tmp/localdot-part4b-task6-build.log`,
  `/tmp/localdot-part4b-task6-node24.log`, and
  `/tmp/localdot-part4b-task6-mutation-run.log`.

## Task 7: proxy environment and certificate installation

The desktop spec sets credential-free proxy addresses and loopback-only bypasses,
plus the system/Node trust paths. Image startup installs the cell CA as a plain
anchor in the system bundle and as `localdot-cell C,,` in the user's NSS database
before the desktop session starts. Replacement and removal update both stores.
The forwarder runs as `abc`; shell profiles load surrogates, sudo preserves proxy
and trust variables, apt has an explicit proxy, and Chromium uses the forwarder
with QUIC disabled. Apt configuration is added after build-time package installs.

Review kept the plan's plain-anchor decision and tested its name constraints in
both OpenSSL and Go, including IPv4/IPv6 leaves as well as unrelated DNS names
and subdomains. Two initial Docker failures were fixture errors: a network-none
container had no hostname mapping for sudo, and Docker regenerated `/etc/hosts`
on restart. Persistent `--add-host` entries fix both without external networking.

- All 717 host tests in 93 files, workspace types, lint and hygiene pass.
- The rebuilt image passes five certificate/proxy checks and all nineteen
  existing desktop image checks. Actual curl and Python TLS requests trust the
  permitted leaf on loopback. OpenSSL and Go refuse other names, subdomains and
  both IP families. Shell/sudo/apt behavior and the executed Chromium command are
  verified, along with the forwarder's user and loopback binding.
- Four Docker image mutations fail runtime assertions: absent system anchor,
  NSS lacking CA trust, retaining a removed anchor, and Chromium missing its
  proxy argument. Probe containers and mutation image tags are removed.
- Evidence: `/tmp/localdot-part4b-task7-build.log`,
  `/tmp/localdot-part4b-task7-docker-baseline.log`,
  `/tmp/localdot-part4b-task7-docker-fixed.log`,
  `/tmp/localdot-part4b-task7-launcher-final.log`,
  `/tmp/localdot-part4b-task7-full-host.log`, and
  `/tmp/localdot-part4b-task7-mutation-run.log`.

## Task 8: boot self-test and readiness gate

The bearer-protected self-test runs all eleven isolation, credential-service and
trust checks in parallel. Each check has a hard deadline, sequential work shares
the same budget, and results are cached for two elapsed seconds with one run at
a time. Readiness recomputes the verdict from all required check IDs and kinds.
Missing, malformed, oversized or incomplete evidence cannot make a cell ready.

Review reproduced local errors being mistaken for isolation, invalid route data
passing, hung probes, truncated/oversized HTTP replies being accepted, duplicate
NSS entries and cell-controlled readiness redirects. These are fixed. Connection
refusals fail TCP isolation checks; unknown DNS errors remain inconclusive. The
HTTP primitive uses Node's framing parser, a private agent, a whole-request
deadline and a body cap. File reads reject non-regular and oversized files, and
failed checks return static diagnostics without exception contents. A scoped
review also covered partial DNS answers and cache expiry across clock changes.

- All 760 host tests in 95 files, workspace types, lint, hygiene and desktopd
  bundles pass. The desktop image was rebuilt with the new boot endpoint.
- Seventeen mutations fail runtime assertions, covering isolation verdicts,
  route evidence, token/cell identity, trust stores, deadlines, framing, body
  limits, environment proxies, redirects, claimed readiness and cache expiry.
- A network-none container using Node 24.21.0 exercises the real Linux route
  parser, blocked IPv4/IPv6/DNS/host probes, local proxy authentication, and PEM
  and NSS checks. The gateway check correctly fails because no cell network is
  attached. The probe container is removed. A fully wired cell's boot acceptance
  remains part of Tasks 9–14; this smoke run does not claim that acceptance.
- Evidence: `/tmp/localdot-part4b-task8-review-red.log`,
  `/tmp/localdot-part4b-task8-probes-red.log`,
  `/tmp/localdot-part4b-task8-scoped-final.log`,
  `/tmp/localdot-part4b-task8-full-host.log`,
  `/tmp/localdot-part4b-task8-mutation-run.log`,
  `/tmp/localdot-part4b-task8-image-build.log`, and
  `/tmp/localdot-part4b-task8-node24.log`.

## Remaining integration

Tasks 9–16: orchestration, Stop/resume, event logging, key
sheet, real-cell isolation/canary acceptance, documentation and CI. The system
Keychain/Stop carry from Part 4a also remains.
