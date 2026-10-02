# Global constraints for every Part 4a task (verbatim from the plan, lines 60–100)

Controller note: the worktree /Volumes/Husky's SSD 4T/Projects/localdot-keyd on branch feat/core-part4a already exists (from main 992e82d). Work only there; never touch /Volumes/Husky's SSD 4T/Projects/localdot (Part 2 runs in it). Never commit on main.

## Global Constraints

- Worktree: `/Volumes/Husky's SSD 4T/Projects/localdot-keyd`, branch `feat/core-part4a`, created
  from `main` in Task 1. Never commit on `main`, and never edit, stage or check out anything in
  `/Volumes/Husky's SSD 4T/Projects/localdot` (Part 2 is working there). Quote every path (space
  and apostrophe). Go commands run from `"/Volumes/Husky's SSD 4T/Projects/localdot-keyd/keyd"`.
- Commit messages: conventional `type(scope): summary`. **Never add `Co-Authored-By` or any AI
  attribution line** (user rule; overrides any harness default).
- Shared files are touched only here, minimally, because they will be merged with other branches:
  `.github/workflows/ci.yml` (a new `keyd` job appended, Task 1), `.gitignore` (one line, Task 1),
  `README.md` (one short section, Task 17). Nothing under `apps/`, `cells/`, `packages/`,
  `spikes/` or `scripts/` changes; `scripts/check-hygiene.mjs` already scans every file git tracks,
  Go included, so it needs no change.
- Ports, all bound to `127.0.0.1` only: keyd listeners `4760–4789` (keyd refuses others unless
  `-ports` says so); spikes and e2e harnesses `4790–4799`; the daemon's `4750` and the brain's
  `4751` are not keyd's. Tests never use a fixed port: they ask for port 0.
- Secrets: never a real one, anywhere. Tests use obviously fake values (`real-secret-value-for-test`,
  `real-secret-value-for-spike`, `fake-key-from-webcrypto`) that match none of `pnpm hygiene`'s
  patterns (no `sk-…`, `AIza…`, `gh?_…`, `xox?-…`, bot tokens or PEM private-key headers). The one
  test that touches the login keychain is opt-in (`KEYD_KEYCHAIN_TEST=1`), uses the service
  `localdot-keyd-test` and deletes its fake item. No test reaches the network: upstreams are
  loopback `httptest` servers reached by name through a fake resolver, with exact guard exceptions
  for their ports.
- keyd never logs, audits or returns a secret value, and returns a surrogate only in the admin reply
  that hands it to its cell; audit lines name a surrogate by `surrogate.ID` (12 hex characters of
  its SHA-256), and write any surrogate-shaped text a request carried as `surrogate:<ID>`. No error
  carries a value or the Keychain tool's output. Everything unknown, unparsable or unverifiable is
  refused and audited (fail closed); while the audit log cannot be written, no secret is swapped.
- No [avatar-name]/[avatar-name]/[avatar-name] names or assets anywhere (`pnpm hygiene` enforces it). The GitHub
  repo stays private; nothing in this plan pushes.
- Go: module `github.com/shadowhusky/localdot/keyd`, `go 1.27` with `toolchain go1.27.1`, every
  dependency pinned to an exact version in `go.mod` and `go.sum`; packages under `internal/`, one
  command under `cmd/keyd`; small focused files; errors wrapped with `%w` where a caller inspects
  them; comments only for non-obvious rules, workarounds and provenance (the Apache-2.0 notice on
  `sni.go` is required). Before every commit: `gofmt -l .` prints nothing and `go vet ./...` is
  clean.
- Tests: run only the package a task touches (`go test ./internal/<pkg>/`); `go test -race ./...`,
  `GOOS=darwin go vet ./...` and `GOOS=linux go vet ./...` before the final review. Tests that open
  a Unix socket keep their home under `/tmp` (macOS limits socket paths to 104 bytes;
  `t.TempDir()` is too deep).

