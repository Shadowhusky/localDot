# keyd cell lifecycle verification — 2026-10-02

Part 4a Task 15 is implemented: the manager opens and lists cells, issues their
proxy token and public CA, mints scoped surrogates, attaches a durable task
budget, and revokes or closes the cell. Production listener requests are limited
to ports 4760–4789; tests use ephemeral listeners and local fake upstreams.

Revoke drops all of the cell's surrogates, detaches its task (including keyless
local model routes), and interrupts in-flight HTTP and CONNECT connections. The
listener and CA remain for a later task. Close also removes those resources.
Session spend and an explicitly chosen limit survive both operations and a
replacement cell. The daemon still needs to stop/pause the cell's processes in
Part 4b: revocation alone deliberately leaves ordinary web egress available.

Review found and fixed three lifecycle problems: cleanup of an old cell could
delete a replacement's CA, shutdown could admit new cells, and failed budget
persistence could report a task as started. Lifecycle operations now share the
manager lock, shutdown is terminal, and failed task starts restore the previous
account attachment and limit. The ledger's persistence failure remains sticky
and fails further spending closed. Manager-to-cell/registry/vault/budget lock
order has no reverse callback into the manager.

Validation:

- All 11 Go packages pass `go test -race ./... -timeout=120s` (egress 31.559 s).
- Six original manager tests and six additional integrity tests cover the public
  lifecycle, role and CA restrictions, replacement concurrency, failed writes,
  invalid budgets, keyless Stop, and session-spend continuity. A further budget
  test covers failed updates of existing and replacement task accounts.
- Seven Stop/lifecycle integrity tests pass ten consecutive race-enabled runs
  (6.316 s). Stop tests require actual stream and tunnel closure; client read
  timeouts do not count as success.
- Sixteen distinct injected regressions are caught by runtime assertions:
  ignored task errors, invalid limits, post-shutdown admission, retained revoked
  credentials or keyless tasks, live connections/listeners after Stop/Close,
  stale CA files, role and CA-binding bypasses, out-of-range ports, failed-start
  visibility/limit rollback, and the replacement cleanup race. One mutation
  selector was initially ambiguous; its corrected scoped retry was caught.
  No compile failure is counted as detection.
- Darwin and Linux `go vet ./...`, module tidy, formatting and repository hygiene
  checks pass.

Local evidence: `/tmp/localdot-keyd-task15-full.log`,
`/tmp/localdot-keyd-task15-repeat.log`,
`/tmp/localdot-keyd-task15-mutation-run.log`, and
`/tmp/localdot-keyd-task15-mutation-retry.log`.

Task 16's admin socket/command, Task 17's acceptance probes, and Part 4b's daemon
and UI integration remain. This is not M3 acceptance evidence by itself.
