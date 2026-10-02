# keyd core acceptance — 2026-10-02

Part 4a Task 17 adds the 15 S4 probes against the real in-process proxy,
interception, address guard and scrubber. They use local fake upstreams. They
cover surrogate substitution and reflection, absent and unknown credentials,
role restrictions, private and local destinations, host/SNI/port agreement,
passthrough certificates, misplaced credentials and audit redaction.

The Host-mismatch probe has two cases: an ordinary mismatched authority returns
421; one carrying a surrogate returns 403 at the earlier misplaced-credential
check. Neither reaches the upstream. The original plan expected 421 for both;
the probe preserves the stricter inspection already implemented in Task 12.

The final review reproduced and fixed three remaining gaps:

- Adding an HTTP binding now cancels existing work in every web-capable cell,
  including cells without a surrogate for that secret. Their old streams had
  been created with a scrub set that did not include the new binding.
- A request inspected before a key rotation is synchronously rejected before
  handing headers to a transport if its generation was cancelled. Depending
  only on the asynchronous cancellation callback could offer the new value
  under an old inspection decision.
- Basic credentials glued to the scheme or separated by punctuation cannot hide
  an encoded surrogate. Canonical placement remains strict. The full suite
  caught a regression in the existing Unicode scheme case during this fix;
  that case is retained and passes in the final run.

Verification on Go 1.27.1, macOS/arm64:

- All 13 packages pass `go test -race ./... -count=1`; egress 34.369 seconds.
- The three new regression tests pass ten race-enabled runs (egress 2.197 s,
  keys 1.260 s).
- Each of the three deliberate regressions fails its runtime assertion;
  no compile failure is counted as a caught mutation.
- Native, Darwin/amd64 and Linux/amd64 vet pass. Module verification, tidy,
  formatting, repository lint and hygiene pass. This worktree shares the
  installed repository Biome binary; it does not have its own node_modules.

Evidence: `/tmp/localdot-keyd-task17-final-full.log`,
`/tmp/localdot-keyd-task17-final-repeat.log`,
`/tmp/localdot-keyd-task17-mutation-run.log`,
`/tmp/localdot-keyd-final-review-red.log`, and
`/tmp/localdot-keyd-rotation-admission-red.log`.

The earlier final-review items (binding validation, concurrent intercepted-host
access and the IPv6 refusal message) are covered by the existing suite. The
binding-change stream cancellation and the inspection/value-read race are now
covered by the added tests. Per-task spend survives a Stop/restart under the
same task ID, as required by the amended budget contract.

This completes the core service checks, not milestone M3. Part 4b still needs
daemon/UI integration and real-cell isolation, canary, Stop and recovery checks.
These checks use the memory vault; system Keychain behaviour and Stop latency
during a stalled Keychain operation remain integration work.
