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

## Remaining integration

Tasks 2–16: protocol and browser sealing, daemon client/routes, cell proxy/trust
installation and boot checks, orchestration, Stop/resume, event logging, key
sheet, real-cell isolation/canary acceptance, documentation and CI. The system
Keychain/Stop carry from Part 4a also remains.
