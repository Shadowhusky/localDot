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

## Remaining integration

Tasks 3–16: daemon client/routes, cell proxy/trust
installation and boot checks, orchestration, Stop/resume, event logging, key
sheet, real-cell isolation/canary acceptance, documentation and CI. The system
Keychain/Stop carry from Part 4a also remains.
