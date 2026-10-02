# keyd admin API and command verification — 2026-10-02

Part 4a Task 16 is implemented. `keyd` serves HTTP on a private Unix socket,
accepts sealed secret updates, manages cells and task budgets, exposes model
allowlists/prices, and streams events as NDJSON. A per-home exclusive lock
prevents two processes from sharing state. The command reports readiness and
handles SIGINT, SIGTERM and SIGHUP; `verify-audit` validates the audit chain.

The socket, lock and audit files are 0600 inside a 0700 directory. The public
per-cell CA is 0644. An existing ordinary file or symlink at the socket path is
refused. Admin bodies must be one complete JSON object of at most 1 MiB; unknown
fields, null documents, trailing documents/junk and oversized trailing whitespace
are refused. Secret backend error text is not returned by either PUT or DELETE;
PUT diagnostics also avoid printing the backend's text.

Review reproduced and fixed these integration failures:

- Old streams and requests waiting for budget could survive a model or limit
  edit. Manager-mediated policy changes now cancel the old generations and block
  new admission while the policy is persisted. Valid model/limit edits interrupt
  pending gateway work in all brain cells. Existing task spend and credentials
  stay attached. Invalid edits leave running work alone; failed persistence
  retains the old policy and restores fresh admission.
- Secret replacement/deletion could publish a value before invalidating its old
  binding. The manager now cancels affected work and revokes credentials before
  the store operation, serializing Open/Mint against that operation. Even a failed
  store operation revokes old credentials; the caller must explicitly mint again.
- Repeated cleanup of an old process could remove its replacement's socket.
  Shutdown is idempotent, refuses new admin operations, interrupts open reads and
  event streams, and waits for admitted handlers before releasing the home lock.
- Parsing previously accepted trailing JSON and ignored oversized trailing
  whitespace. All of the bounded body is now read and checked before mutation.

Validation on Go 1.27.1, macOS/arm64:

- All 13 packages pass `go test -race ./... -timeout=120s`; egress 32.373 s.
- Six concurrency/Stop test functions pass ten race-enabled runs across admin,
  command and egress packages (1.920 s, 2.739 s, 5.183 s respectively).
- Nineteen deliberate regressions are caught by runtime assertions, with no
  compile failures or survivors: sealed binding authentication, JSON boundaries,
  error reflection, old bindings and policy work, publication order, invalid and
  failed policy edits, shutdown idempotency/draining, file permissions, exclusive
  locking, and refusal to overwrite an unrelated socket-path file.
- A built command in a temporary home passes readiness, private socket/default
  settings, a real cell proxy health request, task start, revoke, close, SIGTERM
  cleanup and `verify-audit` (`audit ok: 7 lines`). File modes match the contract.
- Darwin and Linux vet, tidy, formatting and repository hygiene checks pass.

Evidence: `/tmp/localdot-keyd-task16-full.log`,
`/tmp/localdot-keyd-task16-repeat.log`,
`/tmp/localdot-keyd-task16-mutation-run.log`, and
`/tmp/localdot-keyd-task16-smoke.log`. All test providers and secrets are local
fakes; the command smoke test uses the memory vault. The system Keychain was not
modified by these checks.

Task 17's acceptance probes and Part 4b's daemon/UI integration remain before M3
acceptance. Part 4b must also measure Stop and recovery with the actual host
Keychain backend; these memory-vault checks do not establish that latency.
