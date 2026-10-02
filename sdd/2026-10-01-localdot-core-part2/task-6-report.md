# Task 6 report: Docker Engine client over the Unix socket

**Status: DONE_WITH_CONCERNS.** The client is built to the brief and verified. The concern is one
deviation: two error paths the brief's code leaves open now reject with a `DockerError`. It comes
with RED evidence and mutation checks, for the controller to accept or veto. Below that are three
carry-forward notes for later tasks.

Branch `feat/core-part2`, base `8e9262f`. The working tree is clean after the commit.

| Commit | Message |
|---|---|
| `46bb349` | `feat(daemon): Docker Engine client over the Unix socket` |

The commit has no `Co-Authored-By` line or any AI attribution (checked with grep).

## Test summary

| Check | Result |
|---|---|
| `pnpm exec vitest run apps/daemon/src/cells/docker.test.ts` | 7/7: the brief's 5, plus 2 for the deviation |
| `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/docker.docker.test.ts` (no `--`) | 1/1 (only this file ran). Without the opt-in: 1 skipped |
| `pnpm test` (non-Docker) | 19 files, 161 tests passed (Task 5 left 18 / 154: +1 file, +7 tests). `docker.docker.test.ts` is excluded |
| `pnpm format` | rewrapped the two new `.ts` files to the 100-column width (formatting only); no tracked file changed |
| `pnpm lint` | exit 0, no fixes |
| `pnpm typecheck` | exit 0 |
| `pnpm hygiene` | exit 0 |

The real engine, read through this client (`GET /v1.47/version`, read-only):
`Version 29.2.0, ApiVersion 1.53, MinAPIVersion 1.44, Os linux, Arch arm64` (Docker Desktop
4.60.0). These are the values the brief expected. The default socket is `/var/run/docker.sock`,
which on this Mac is a symlink to `~/.docker/run/docker.sock`; `DOCKER_HOST` is unset. A real
404 carries Docker's message:
`docker 404 on /containers/localdot-test-definitely-missing/json: No such container: …`.

## Steps

- **Step 1.** `docker.test.ts` was written as the brief gives it.
- **Step 2, RED.** `Error: Cannot find module './docker.ts' imported from …/docker.test.ts`. That is
  Vitest 5's wording for the brief's "Failed to load url" (Task 5 saw the same). No tests ran.
- **Step 3.** `docker.ts` and `docker.docker.test.ts` were written as the brief gives them.
- **Step 4, GREEN.** 5/5 unit, and the Docker test passed.
- **Then the deviation** (below), by TDD: two new tests, RED on the brief's code, then the fix,
  then GREEN at 7/7.
- **Step 5.** `pnpm format && pnpm lint && pnpm typecheck`, then the commit. The brief's Step 4
  command was re-run on the committed tree: 7/7 and 1/1.

**The Docker test gates the pin.** I set `DOCKER_API` to `v1.99`, then to `v1.40`, and restored
the file byte-for-byte (checked with `cmp`). Each value fails the test with
`DockerError: docker 400 on /version: …`. See carry-forward note 1 for what that body contains.

## Deviation: two error paths reject instead of hanging or crashing

The brief's code has two failure paths, and I probed both against it from a scratch script on a
fake socket (Node v25.6.0):

1. **A malformed JSON reply** (`200`, `application/json`, body `{"Id":`). `JSON.parse` runs inside
   the response's `"end"` callback, outside the promise executor's synchronous scope. Its
   `SyntaxError` is therefore an **uncaught exception**, and the promise never settles. The daemon
   has no `uncaughtException` handler (`apps/daemon/src/main.ts`), so the daemon would exit.
2. **A reply cut off mid-body** (headers and a partial body, then the socket closes). Node emits the
   response's `"error"` only when a listener exists (`IncomingMessage` `onError`: "An error is
   emitted only if there are listeners attached"). The brief's code has none and gets no `"end"`,
   so the promise **never settles**. Nothing crashes, but a caller such as the orchestrator's create
   or stop would wait forever. This is not the F25 timeout: Node reports this failure as an event,
   and the fix reacts to that event. A wedged socket that sends nothing and never closes still
   hangs until F25 adds a timeout. No timeout was added.

**Fix** (in `docker.ts`):
- One `unreachable` handler builds the brief's `DockerError(0, "<code>; is Docker Desktop
  running?")`. It now listens on both the request (`r.on("error")`, as before) and the response
  (`res.on("error")`, new, with a one-line comment explaining why).
- A JSON body is parsed inside `try`/`catch`. On failure it rejects with
  `DockerError(<HTTP status>, "malformed JSON reply", path)`. The body is not echoed into the
  message, because a container-inspect reply carries the cell's env, including its tokens.
- What the two paths now produce:
  - `docker unreachable on /containers/c1/json: ECONNRESET; is Docker Desktop running?` (cut off)
  - `docker 200 on /containers/c1/json: malformed JSON reply` (malformed)

**Tests** (added after the brief's five, which are unchanged):
- `rejects a reply cut off mid-body as DockerError 0`. The server writes the headers with
  `content-length: 100` and 9 bytes of body, then calls `res.destroy()` from the write callback.
- `rejects a malformed JSON reply as DockerError`. It expects `status: 200` and "malformed JSON" in
  the message.
- A small `listen(handler)` helper now holds the temp-socket setup, and the brief's `fakeDocker` is
  built on it. Its behaviour is the same, and the five brief tests pass unchanged.

**RED on the brief's code** (the two new tests, with the brief's `docker.ts`):
```
× rejects a reply cut off mid-body as DockerError 0   → Test timed out in 5000ms.
× rejects a malformed JSON reply as DockerError       → Test timed out in 5000ms.
Uncaught Exception: SyntaxError: Unexpected end of JSON input
  ❯ IncomingMessage.<anonymous> apps/daemon/src/cells/docker.ts:69:55
Tests  2 failed | 5 passed (7)   Errors  1 error
```
**GREEN after the fix:** 7/7.

**Mutations.** Each fix was removed alone, and the file was restored byte-for-byte (`cmp`):
- Without `res.on("error")`, only the cut-off test fails (timeout).
- With a bare `JSON.parse`, only the malformed test fails (timeout plus the uncaught `SyntaxError`).

Cost if vetoed: revert about 10 lines in `docker.ts` and the two tests plus the `listen` helper.

## Carry-forward notes

1. **For Task 9's doctor: a version mismatch hides behind a raw body.** When the engine rejects
   the pinned API version, Docker Desktop's proxy answers `/version` with **HTTP 400 and a body
   shaped like a version reply, with no `message` field**:
   `{"Platform":{"Name":"Docker Desktop 4.60.0 (218231)"},"Version":"","ApiVersion":"","Os":"","Arch":""}`.
   Other endpoints give the engine's clear text, for example
   `{"message":"client version 1.40 is too old. Minimum supported API version is 1.44, …"}`. So the
   plan's `runDoctor` would show that raw JSON as the `docker-socket` detail, for an engine older
   than 27 or a future engine whose minimum passes 1.47. It would also mark the engine checks
   "skipped". The doctor could treat a 400 from `version()` as "Engine does not serve API v1.47".
   I checked this with read-only `curl` GETs.
2. **For Task 9's doctor: the socket path.** `dockerSocketPath()` reads only `DOCKER_HOST` and
   otherwise uses `/var/run/docker.sock`. It ignores the CLI's current context (`desktop-linux` →
   `~/.docker/run/docker.sock`). Docker Desktop's "Allow the default Docker socket to be used"
   setting controls whether `/var/run/docker.sock` exists. Where it is off, the client reports
   unreachable while `docker` works. The doctor's detail could suggest
   `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`. This is as the brief specifies, so I left
   it unchanged.
3. **F25 still stands.** No per-request timeout was added, as instructed. After this change, only a
   wedged socket (no bytes, no close) can leave a request pending.

Minor, and left as the brief has it: the Docker test compares versions as decimals
(`Number("1.53")`). That is right for today's two-digit minor versions but would misorder an
eventual `1.100`.

## Docker hygiene

- This task only made read-only calls:
  - `GET /version` through the client;
  - one `GET` on a non-existent `localdot-test-*` container (404);
  - `curl` GETs on non-existent `localdot-test-*` networks and on `/version` at out-of-range versions.
- Nothing was created, pruned, restarted or touched.
- Afterwards, no `localdot-test-*` containers, networks or volumes exist.
- No path under `/Volumes/Husky's SSD 4T` was mounted.

## Files

- `apps/daemon/src/cells/docker.ts` (new)
- `apps/daemon/src/cells/docker.test.ts` (new: the brief's 5 tests plus 2)
- `apps/daemon/src/cells/docker.docker.test.ts` (new, as the brief gives it)
