# Task 8 report: container specs and the cell orchestrator

**Status: DONE_WITH_CONCERNS.** The five modules, the fake Docker API and three test files are built
to the brief and all nine controller rulings. Every check is green: the unit suites, `pnpm test`,
lint, typecheck, hygiene and the Docker test (3/3 on four runs). Docker hygiene is clean.

The concern is not a blocker, and it needs a ruling. With no per-cell serialisation of start, stop
and remove, a Start that lands while a Stop is still in flight is silently lost (real-Docker
evidence under Concerns).

Branch `feat/core-part2`, base `2f6d921`. The working tree is clean, and nothing is pushed (no
upstream).

| Commit | Message |
|---|---|
| `043e6a7` | `feat(daemon): container and network specs for a cell's gate and desktop` |
| `a2531c0` | `feat(daemon): cell orchestrator with isolated networks and hardened containers` |
| `977b1ff` | `test(daemon): run a real cell through create, isolation, restarts, stop, start and remove` |

No commit carries `Co-Authored-By` or any AI attribution: a grep of the bodies for
co-authored/claude/anthropic/generated finds 0. `977b1ff` was amended once, before any push, to fold
in the `beforeAll` fix described below.

## Test summary

| Check | Result |
|---|---|
| `spec.test.ts` | 7: the brief's 6, plus 1 for bounded logs |
| `orchestrator.test.ts` | 19: the brief's 13, plus 6 (rulings 3, 4, 5, and `v=true`) |
| `readiness.test.ts` (new file) | 6: ruling 3 |
| Stability | the three unit suites, 15 repeated runs: 15 × 26/26 green (before the readiness file existed) |
| `pnpm test` | 25 files, 226 tests (194 at base + 32) |
| `pnpm format`, then `pnpm exec biome check --write apps/daemon/src/cells`, then `pnpm lint` | exit 0. Formatting only: the formatter rewrapped some lines, and I put braces on one wrapped `if` |
| `pnpm typecheck` | exit 0 (5 projects) |
| `pnpm hygiene` | exit 0 |
| `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/orchestrator.docker.test.ts` | 3/3 on 4 runs, 26.5–27.6 s each. Per test: create ~2–3 s, restarts ~17 s, stop/start/remove ~6.5 s |
| Docker failure path | a deliberate `throw` right after the cell is ready: afterAll left no container, network, volume or temp dir, and dangling stayed 23 |
| Skipped Docker run (no opt-in) | 3 skipped, no temp dir left (before the `beforeAll` fix it leaked one: before=0, after=1) |

Host: Node v25.6.0, pnpm 10.29.3, Docker Desktop Engine 29.2.0 (API 1.53, 10 CPUs). Images:
`localdot/desktop:dev` `5131850d32ba`, built 18:41 BST right after `123f443`; `localdot/gate:dev`
`bd63e486e20b`, whose `relay.sh` I checked equals the repo's.

## RED evidence

- **`spec.test.ts` first:** `Error: Cannot find module './spec.ts'`. That is Vitest 5's wording for
  "Failed to load url", as in Tasks 5–7. No tests ran.
- **`orchestrator.test.ts`, written in full before the implementation:** `Error: Cannot find module
  './orchestrator.ts'`.
- **Non-vacuity, by mutation.** I added tests for behaviour that the brief's code (or mine) already
  had, so each was shown non-vacuous by a mutation that breaks one guard. Every mutation below was
  reverted afterwards (checked with `cmp` against a backup).

| Mutation | Test that fails |
|---|---|
| M1: drop `#reservedKeydPorts.add(keydPort)` | gives two concurrent creates different keyd ports |
| M2: `#current` ignores `#disposed` | ends the readiness loop on dispose without touching the cell |
| M3: drop the guard after `probeDesktopd` | lets a remove that lands while readiness awaits its probe win (`streamProbes: 1`) |
| M4: drop the guard after the backoff sleep | keeps a cell stopped when the stop lands during the restart backoff |
| M5: no percent-encoding in `objectPath` | percent-encodes the names it reads from a cell record (the victim network is deleted) |
| M6: container delete without `v=true` | removes each container with its anonymous volumes |
| M7: `if (health?.ok)` → `if (health)` | keeps waiting while desktopd answers ok:false; fails with the last detail when readiness times out |
| M8: keep the previous ports on a restart | restarts an exited gate … reads its new published ports (`50000` stays `50000`) |
| R1/R2: drop the `AbortSignal` (desktopd / stream) | the matching never-answers test times out at 5 s; the 3 s default test fails |
| R3: default timeout 30 s | bound each request at 3 s unless told otherwise |
| R4: drop `if (!res.ok) return undefined` | gives no answer when desktopd refuses the token, whatever the refusal carries |
| spec: drop `User`, `PidsLimit: 64`, either `LogConfig`, or set `max-file` to 5 | the gate test, the gate test, the logs test (each `LogConfig` separately), the logs test |

Two first attempts did not bite, and I fixed both before relying on them:
- **M3 survived at first.** The guard after `probeStream` masked the missing guard after
  `probeDesktopd`. The test now also counts stream probes, so it pins the first guard on its own.
- **My first M8 changed nothing.** At that point the live entry has no ports yet. I redid it by
  capturing the previous ports before the start.

## Rulings and the tests that pin them

| # | Ruling | Pinned by |
|---|---|---|
| 1 | Gate: `CapDrop ["ALL"]`, `ReadonlyRootfs`, `SecurityOpt ["no-new-privileges"]`, `PidsLimit 64`, user `nobody` | `spec.test` "is read-only, unprivileged, capability-free and bound to 127.0.0.1" (now asserts `User: "nobody"` and `PidsLimit: 64`). Docker test 1: `true [ALL] [no-new-privileges] 64 nobody`, and `id -u` in the gate is 65534 |
| 1 | The gate starts on egress and joins the internal network afterwards | `orchestrator.test` "provisions networks…": gate start < internal connect < desktop start. Docker test 1: the gate holds `.10` on both networks, the desktop `.11` on the internal one only |
| 1 | Desktop: the brief's limits, `CapDrop ["NET_RAW"]` | `spec.test` "drops NET_RAW…". Docker test 1: `[NET_RAW] []`, `SecurityOpt` `[]`, `PidsLimit` 4096, only `volume:/config`, and a raw socket exits 1 with "Operation not permitted" |
| 2 | Bounded logs: `json-file`, `max-size 10m`, `max-file 3` on both containers | `spec.test` "rotates both containers' json-file logs…". Docker test 1: `{{json .HostConfig.LogConfig}}` of the gate and the desktop equals that object |
| 3 | The probes set their own per-request timeout | `readiness.test`: "stops waiting for a desktopd that never answers" and "…a stream that never answers" (50 ms, under 1 s); "bound each request at 3 s unless told otherwise" (`AbortSignal.timeout` is called with 3000 for both probes) |
| 3 | `ok:false` means not ready yet | `orchestrator.test` "keeps waiting while desktopd answers ok:false and is ready only once it answers ok" (ready only at probe 4), the brief's readiness-timeout test, and `readiness.test` "…hands back a not-ready answer as it is" |
| 4 | Names come from the daemon's ULID through `namePrefix` (default `localdot-`, test `localdot-test-`) | `spec.test` "derives every Docker object name…". Docker test 1: `desktop === localdot-test-desktop-<id>` |
| 4 | Percent-encode names the daemon did not mint before they go into an API path | `orchestrator.test` "percent-encodes the names it reads from a cell record into Docker API paths": a hand-edited record with `gate = "../networks/<victim>"`. After `remove()` the victim network still exists, and the request went to `/containers/..%2Fnetworks%2F<victim>` |
| 4 | Docker test checks and cleanup filter by the test prefix, never by label | the Docker test (by reading the code): every name is `cellNames(id, "localdot-test-")`. afterAll removes the exact names of each cell id it saw or stored. No label filter, no broad prefix sweep, which would also hit other suites' `localdot-test-gate` |
| 5 | After every await in `#watch`/`#waitReady`, continue only if the same entry is current | `orchestrator.test` "lets a remove that lands while readiness awaits its probe win" (M3) and "keeps a cell stopped when the stop lands during the restart backoff" (M4) |
| 5 | `#waitReady` honours `#disposed` | `orchestrator.test` "ends the readiness loop on dispose without touching the cell" (M2) |
| 5 | A Stop during a restart backoff leaves the cell `stopped` | `orchestrator.test` "keeps a cell stopped when the stop lands during the restart backoff" (M4) |
| 5 | `create()` reserves the keyd port before its first await; two concurrent creates differ | `orchestrator.test` "gives two concurrent creates different keyd ports" → {4760, 4761} (M1) |
| 6 | Killing the gate gives new endpoints; killing only the desktop keeps them | `orchestrator.test` (fake): "restarts an exited gate … reads its new published ports" (M8) and "restarts an exited desktop … keeps the gate's published ports" |
| 6 | The same, on real Docker | Docker test 2. `docker kill` the gate gives new desktopd and stream URLs: desktopd answers ok through them, and the desktop still reaches `gate:3128`. `docker kill` the desktop restarts it behind the same endpoints, and desktopd answers ok again. Restart notes "attempt 1 of 5" and "attempt 2 of 5"; Docker's own `RestartCount` stays 0 for both |
| 7 | Run as `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker <file>` (no `--`) | run that way four times (above) |
| 7 | `localdot-test-*` resources, removed with `docker rm -fv` | the orchestrator's container delete sends `force=true&v=true` (`orchestrator.test` "removes each container with its anonymous volumes"). The afterAll backstop is `removeAll` (`docker rm -fv`, `network rm`, `volume rm -f`) |
| 7 | Every probe asserts its expected exit status | the Docker test's `probe(container, status, …cmd)`. Observed and pinned: `curl https://example.com` 6, `curl http://host.docker.internal:4750/` 6, `getent hosts example.com` 2, `/dev/tcp/<gate>/3128` 0, raw socket 1, `id -u` 0 |
| 7 | No server on a Docker test's thread | the Docker test starts none (the 3128 probe needs only the gate's listener) |
| 8 | Docker is shared: no prune or restart, other objects untouched, no bind mounts | by inspection of the code and my own commands (see "Docker usage" below) |
| 9 | Conventional commits in logical steps, no attribution | the three commits above |

Earlier carries also verified:
- Task 1: `PidsLimit 64` bounds the gate's socat fork listeners (spec test and Docker inspect).
- Task 5: the readiness probe times out on its own.
- Task 6: the restart path relies on 304 resolving `undefined` (the gate start and desktop start in
  the restart tests).

## Deviations from the brief (accept or veto)

1. **`spec.ts`:** `User: "nobody"` on the gate (ruling 1). The image already says `USER nobody`;
   the spec now pins it even if `LOCALDOT_GATE_IMAGE` names another image. Also `LogConfig` on both
   containers (ruling 2).
2. **`orchestrator.ts`:**
   - `objectPath(kind, name, action?)` puts every name and ID into the path through
     `encodeURIComponent` (ruling 4). Names minted by the daemon are unchanged by it.
   - Container deletes, in `remove()` and in `create()`'s undo, pass `v=true` through one
     `#removeContainer`. That is the API's `docker rm -fv`, so an image `VOLUME` line can't leak
     anonymous volumes. The named home volume survives it, as the Docker test's remove step proves.
   - Everything else is the brief's code. It already carried the F13/F24 guards: identity checks
     after every await, `#disposed` in `#current`, and the keyd reservation before the first await.
3. **`testing/fake-docker.ts`:**
   - It percent-decodes path segments, as Docker does, so an encoded name resolves.
   - It removes its temp socket dir on `close()`.
   - Otherwise it is the brief's code, F6-compliant: `const m = RE.exec(path)` before each branch.
4. **`orchestrator.test.ts`:**
   - `setup()` takes an optional `probeDesktopd` override, so a probe can be held open.
   - `afterEach` removes the temp homes.
   - Six tests added (in the table above). The brief's 13 are unchanged apart from formatting.
5. **`readiness.test.ts`:** a new file (6 tests) that pins ruling 3. `readiness.ts` is the brief's
   code. I checked whether the stream probe's unconsumed body piles up connections through the gate,
   which has `PidsLimit: 64`. It doesn't: undici reused one connection for 10 probes, so no change.
6. **`orchestrator.docker.test.ts`**, beyond the brief:
   - exact exit statuses;
   - the Docker-level checks for rulings 1 and 2, plus the static addresses;
   - the egress network is checked gone after remove;
   - the real-Docker restart test (ruling 6);
   - a `readyAgain` helper that unsubscribes;
   - the home, store and orchestrator are built in `beforeAll`, because Vitest runs a skipped
     describe's body, so the brief's version leaked a temp dir on every non-opt-in run;
   - afterAll: `dispose()`, `remove(…, {purgeHome})`, then the exact-name `rm -fv` backstop for every
     cell id seen or stored, then the temp home is removed.

## Concerns

1. **A Start that lands during a Stop is lost (needs a ruling).** `stop()` ends with an
   unconditional `#set(stopped)`, and start, stop and remove for one cell are not serialised. I
   measured this on real Docker (scratch script, `localdot-test-` cell, removed afterwards): Stop at
   1.38 s, Start at 2.38 s while the desktop was still stopping.
   - The Start's own steps got 304s and launched readiness.
   - Readiness then saw the stopping desktop exit and emitted `failed: desktop container exited with 0`.
   - Stop's final set overwrote that with `stopped` at 5.74 s, and both containers ended stopped.
   - So the end state is consistent, but `start()` resolved OK (the API returns 202) and the user's
     newer Start was dropped, with a spurious `failed` event in between.
   - The brief's guarantee ("a stop, a remove or a newer start … wins") covers only the watch,
     readiness and start loops, not `stop()` itself.
   - Proposed fix (~15 lines and one test): a per-cell promise queue for `start`, `stop`, `remove`
     and the restart's `#startContainers`, with the backoff sleep and readiness outside it. A Start
     then waits for an in-flight Stop and wins, and a Stop during a start waits for the start's Docker
     calls (seconds), then wins.
   - Alternatively, Task 10's API could serialise per cell. I didn't build either, because it
     changes the brief's design.
2. **The Docker test takes ~27 s, not the brief's 2–4 minutes.** A real cell is ready 1.4 s after
   `create()` returns. A scratch timeline shows desktopd answering `ok:true` (2560×1600, hidpi ok),
   Selkies' `/api/health` answering 200, and `xfce4-panel` already running at that moment, so
   "ready" isn't premature.
3. **F25 is still open (deferred to Part 3).** Docker requests have no timeout, so a wedged socket
   hangs `create`, `start`, `stop`, `remove` and `reconcile`.
4. **The brief's design, noted for later tasks:**
   - A restart whose readiness then fails (say, the desktop crashes again while booting) fails the
     cell at once instead of spending the remaining backoff attempts.
   - `failed` entries spread `live`, so `endpoints(id)` still returns the last ports of a cell that
     failed in readiness or in the watch. Task 10's stream-ticket route already requires `ready`;
     Task 11 should gate on state too.
5. **Housekeeping.**
   - `$TMPDIR` holds ~130 `local dot's orch-*` and ~170 `ld-fake-docker-*` dirs from runs before
     mine (12:1x, 18:5x and 19:0x BST, likely other agents' scratch runs of the plan's tests). My
     suites leave none (300 before, 300 after), and I left the others alone.

## Docker usage (ruling 8)

- No prune, no restart of Docker, and no other container, network, volume or image touched. No bind
  mounts.
- Everything the tests and my two scratch scripts created was named `localdot-test-*` and removed by
  exact name.
- One exception: at the start I ran `docker run --rm --entrypoint cat localdot/gate:dev /relay.sh`
  to check the gate image matched the repo. It was an unnamed container, removed at once, with no
  volume (the gate image declares none).

Final hygiene, after the last runs:

```
$ docker ps -a --filter name=localdot-test
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ docker network ls --filter name=localdot-test
NETWORK ID   NAME      DRIVER    SCOPE
$ docker volume ls --filter name=localdot-test
DRIVER    VOLUME NAME
$ docker volume ls --filter dangling=true   → 23 rows (baseline 23)
```

---

# Controller follow-up (2026-10-01): two fix commits

The controller accepted the five deviations. Both fixes are on `feat/core-part2` on top of
`977b1ff`, made in `/Volumes/Husky's SSD 4T/Projects/localdot`.

A note on where I worked: mid-task, the harness switched my working directory to the
`localdot-keyd` worktree. That worktree is on `feat/core-part4a`, another lane, so committing there
would have put these fixes on the wrong branch. I followed ruling 9 instead, touched nothing in
`localdot-keyd`, and never used `git stash`.

| Commit | Message |
|---|---|
| `bfd71bb` | `fix(daemon): queue each cell's start, stop and remove so a Start during a Stop runs after it` |
| `9caec83` | `fix(daemon): load only well-formed cell records and skip unreadable ones instead of failing the list` |

Neither commit has an attribution line (grep finds 0 over `2f6d921..HEAD`). I amended `9caec83`
once, before any push, to fold in the test temp-dir cleanup described below.

**Final verification (after both commits):**
- `pnpm format`, then `pnpm lint`: exit 0;
- `pnpm typecheck`: exit 0;
- `pnpm hygiene`: exit 0;
- `pnpm test`: 25 files, 253 tests (226 before these fixes + 6 queue + 21 loader);
- the five cells suites, run 10 times: 10 × 68/68.

The Docker test ran once on the final code: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
apps/daemon/src/cells/orchestrator.docker.test.ts` gave 4/4 in 33.4 s (create 2.3 s, restarts
17.8 s, Stop then Start 5.4 s, stop/start/remove 7.5 s). Docker hygiene afterwards:

```
$ docker ps -a --filter name=localdot-test
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ docker network ls --filter name=localdot-test
NETWORK ID   NAME      DRIVER    SCOPE
$ docker volume ls --filter name=localdot-test
DRIVER    VOLUME NAME
$ docker volume ls --filter dangling=true   → 23 rows (baseline 23)
```

## Fix 1: a per-cell operation queue (`bfd71bb`)

**What it does.** `#queued(id, op)` chains each cell's operations on one promise. Each operation
runs only after the previous one for that cell has settled; a failure doesn't block the next. The
map holds one entry per cell, so different cells never wait for each other, and the entry is
dropped once its tail settles. Through the queue go:
- `create()`: the whole provisioning after the keyd port is reserved, including the undo;
- `start`, `stop` and `remove`;
- the watch loop's restart;
- `reconcile()`, one queued operation per record, which re-reads the record when it runs.

**What stays outside.** Readiness and the restart backoff wait outside the queue, so a Stop never
waits for either.

**The keyd reservation.** It still happens synchronously before `create()`'s first await (F24 is
unchanged; its test still passes).

**Answer to "queue or no race": the watch restart path and reconcile both go through the same
queue.** The restart also re-checks, inside its queued operation, that its `restarting` entry is
still current. So a stop, a remove or a newer start that was queued ahead of it wins, and the
restart does nothing.

**A new test aid.** The fake Docker has `holds`: a request whose `"METHOD path"` is held is recorded,
then answered only when the promise settles, the way a slow real Docker stop keeps its caller
waiting. The tests use it to land a Stop inside another operation's Docker calls.

**Tests.** Each "a2531c0" result below is the same test run against `a2531c0`'s orchestrator.

| Test | Fails on `a2531c0` with |
|---|---|
| **runs a Start that lands during a Stop after it, ending ready with no failure between** (the required test). Stop and Start are called back to back. It asserts the exact events `stopping, stopped, starting, starting, ready` (so no `failed`), 2 gate starts and 2 desktop starts, and both containers running | `expected [ 'stopping', 'starting', 'stopped' ]`: the Start was lost |
| runs a Stop that lands during a restart after it, leaving both containers stopped | `{ gate: false, desktop: true }`: the desktop was left running under a stopped cell |
| runs a Stop that lands during reconcile after it, with no failure between | `expected 'failed' to be 'stopped'` |
| runs a Stop that lands while a new cell starts after it, leaving both containers stopped | `{ gate: true, desktop: false }` |
| drops a restart that queued behind a remove (no Docker start after the remove) | gate starts `2` instead of `1` |
| keeps cells apart: one cell's slow stop holds up no other cell | passes there by construction (no queue at all). It guards against a queue that is too global; the mutation below proves it |
| Docker: runs a Start that lands during a Stop after the Stop, with no failure between (states asserted as soon as both calls resolve, then ready) | on real Docker: `expected [ 'stopping', 'starting', …(3) ]`, plus the old code's spurious `desktop container exited with 0`. Passes on the fix |

In the first draft of "drops a restart…", the baseline gate-start count was taken after the
unqueued restart had already started the gate, so the test passed on `a2531c0`. I moved the
baseline before the kill; it now fails there as shown.

**Mutations of the fix** (each reverted afterwards, checked with `cmp`):

| Mutation | Test that fails |
|---|---|
| Q1: one queue for every cell | keeps cells apart |
| Q2: the restart skips the queue | Stop during a restart; drops a restart behind a remove |
| Q3: reconcile skips the queue | Stop during reconcile |
| Q4: start skips the queue | the required Start-during-Stop test |
| Q5: stop skips the queue | Start during Stop; Stop during a restart; Stop during reconcile; Stop while a new cell starts |
| Q6: no re-check inside the queued restart | drops a restart behind a remove |
| Q7: create skips the queue | Stop while a new cell starts |
| Q8: remove skips the queue | drops a restart behind a remove |

My first Q2 rewrite was a syntax error ("no tests" ran). I redid it, and it fails as listed.

## Task 7 loader fix (`9caec83`)

**(a) Shape guard in `get()`.** `isCellRecord(value, id)` accepts a record only if:
- `v === 1` and `id` matches the folder;
- `createdAt` is a string;
- `scale` is 1 or 2;
- `keydPort` is an integer within `KEYD_PORT_RANGE`;
- both tokens match `/^[A-Za-z0-9_-]{43}$/`;
- all eight `docker` fields are strings matching Docker's own name rule
  `/^[A-Za-z0-9][A-Za-z0-9_.-]+$/` (the addresses fit it too).

The field list is checked complete at compile time with
`satisfies Record<keyof CellDocker, true>`. A failing record, a `v`/`id` mismatch, or a file that
holds `null` is skipped with one fixed line, which never includes file text:
`cell <id>: cell.json does not hold a valid cell record, skipping it`. The invalid-JSON line from
Task 7 is unchanged.

**(b) `list()` catches read errors per entry.** It skips the entry and logs only the code:
`cell <id>: cell.json is unreadable (<code>), skipping it`. `get()` itself still rethrows
non-ENOENT errors, as ruled.

**(c)** The temp-file write sits inside the `try`, so the `finally` removes a partly written
`cell.json.*.tmp`.

**(d)** `ports.test.ts` pins `KEYD_PORT_RANGE` to `{ from: 4760, to: 4789 }`, and checks that 4789
is handed out once 4760–4788 are taken.

**(e)** `list()`'s filter test: a non-ULID folder (holding a valid-looking record) and a
ULID-named file are both passed over, unread and unlogged.

**The mixed test.** Two good records sit next to:
- a malformed but parseable record (`scale: 3`);
- an unreadable record (`chmod 000`, giving EACCES);
- a `cell.json` that is a folder (EISDIR).

`list()` returns the two good records in `createdAt` order, doesn't throw, and logs exactly three
fixed lines (the guard's line, `(EACCES)` and `(EISDIR)`).

**The ENOSPC test.** The fs mock writes the first 16 bytes of the temp file, then throws ENOSPC.
`save()` throws, the folder holds only `cell.json`, and the old record still loads.

**Results on `a2531c0`.** 19 of the 21 new tests fail there:
- 14 shape variants return the malformed record;
- 3 variants (`v` 2, a foreign `id`, `null`) are skipped silently, without the line;
- the mixed test throws `EISDIR: illegal operation on a directory, read`;
- the ENOSPC test leaves `[ 'cell.json', 'cell.json.<hex>.tmp' ]`.

The other two, (d) and (e), pin behaviour `a2531c0` already has, so they can't fail there; the
mutations below prove them.

**Mutations of the fix** (each reverted afterwards, checked with `cmp` and `git diff`):

| Mutation | Test that fails |
|---|---|
| L1: `list()` rethrows | the mixed list test |
| L2: log `err.message` instead of `err.code` | the mixed list test |
| L3: temp write outside the `try` | the ENOSPC test |
| L4–L8: drop the createdAt / scale / upper port bound / integer / stream-token check | the matching variant (scale also fails the mixed test) |
| L9: loosen the Docker name pattern | "a container name climbs out of its path segment" and "an address ends in a newline" |
| L10: skip `v`/`id` mismatches silently | the version, foreign-id and null variants |
| L11: drop `isDirectory()` from the filter | the filter test (the ULID-named file gets read and logged as ENOTDIR) |
| L12: drop the ULID check from the filter | **nothing**. `get()` refuses non-ULID ids itself before reading, so this half of the filter is defence in depth with no observable difference |
| L13: range ends at 4788; L14: `<` instead of `<=` | the port-range pin |

**Interaction with Task 8.** The loader now refuses the hand-edited `../networks/<victim>` record
that the percent-encoding test (ruling 4) saved, so that test failed with `UnknownCellError`. The
loader's refusal of that name is now pinned in `store.test.ts`. To keep the encoding tested on its
own, the orchestrator test hands the record over through a `CellStore` subclass that passes it
over the loader's check for that one id.

**Housekeeping.**
- `store.test.ts` never removed its temp homes, and my 21 tests would have left about 20 per run.
  Its `afterEach` now removes them; the count stayed at 144 across ten runs.
- I deleted the 494 `local dot's cells-*` dirs that my own runs left at 19:53–19:55 (all from
  finished runs) and left everything older alone.

## Remaining concerns

1. **An unreadable record can still crash the daemon.** As ruled, `get()` rethrows non-ENOENT read
   errors, and the orchestrator reads records through it on every state change (`#emit`).
   - If a running cell's `cell.json` becomes unreadable (EACCES, EIO), the next background `#set`
     throws.
   - That rejects a detached readiness or watch promise. The daemon has no `unhandledRejection`
     handler, so Node exits.
   - A 3-line fix: catch in `#emit`, skip the event, and log only the code. I didn't build it; it
     is outside the ruling.
2. **A remove still shows one stray "restarting" note.** While a remove is in flight, the watch
   loop can still emit that note before `removed`. The restart itself is now dropped (pinned).
   Making `#remove` invalidate the loops first would also remove the note, but it would change
   remove's event sequence, so I left it.

## Fix 3: background failures never end the daemon (`365aab9`)

This addresses Remaining concern 1, which the controller accepted. Concern 2 (one "restarting"
note before "removed") stays deferred as a Minor. As before, I worked only in
`/Volumes/Husky's SSD 4T/Projects/localdot`.

Commit: `fix(daemon): keep a background readiness or watch failure from ending the daemon`, with no
attribution.

**The fix has two layers.**
- **`#emit` catches a failed record read.** When `cell.json` is unreadable, it logs
  `cell <id>: cell.json is unreadable (<err.code>); state change not sent` and returns. `#set`
  therefore can't throw out of a loop, and the loops keep going without the event.
- **Every detached loop is caught at the top.** All four launches (three `#waitReady`, one
  `#watch`) now go through `#detach(id, loop)`. Any error that still escapes ends only that loop,
  with `cell <id>: background check stopped (<err.code>)`. Nothing is left `void`-ed except the
  queue's cleanup chain, which can't reject.
- Both lines carry only the cell id and `err.code` (`no error code` if it has none), never a
  message, so no file text or path reaches the log.

**Tests.** Both failed on `9caec83`: a temporary `process.on("unhandledRejection")` listener caught
the escaped rejection.

| Test | On `9caec83` | On the fix |
|---|---|---|
| keeps watching through an unreadable `cell.json`, with no unhandled rejection: `chmod 000` mid-watch, then the desktop dies | the EACCES rejection escaped, and its message carried the file's path | no rejection; the restart still runs (`starts === 2`); the fixed EACCES line is logged |
| ends a background check that throws with one line, and no unhandled rejection: the injected probe throws `EPROBE` with a path in its message | the EPROBE rejection escaped | no rejection; exactly one line, `background check stopped (EPROBE)`; the cell is left as it was (`starting`) |

**Mutations** (each reverted afterwards, checked with `cmp`):

| Mutation | What fails, and why |
|---|---|
| B1: `#emit` without the catch, only the outer layer left | the first test, with `expected 1 to be 2`: nothing escapes, but the watch stops cleanly instead of going on, so the `#emit` catch is what keeps it going |
| B2: `#detach` without the catch | the second test: EPROBE escapes |
| B3: the `#emit` line also logs `err.message` | the first test: the exact fixed line no longer matches |

**Checks.**
- `pnpm format`, `pnpm lint`, `pnpm typecheck` and `pnpm hygiene`: exit 0.
- The cells suites, 10 runs: 10 × 70/70.
- `pnpm test`: 25 files, 255 tests.
- The orchestrator Docker test, once: 4/4 in 34.1 s. Afterwards 0 `localdot-test-*` containers,
  networks or volumes, and dangling volumes are still 23.

## Follow-up round (2026-10-01): Task 8 M1–M14, Task 9 D1–D5, Task 10 items

All three commits sit on `dfaf41f` (Tasks 9 and 10 had landed there), made in
`/Volumes/Husky's SSD 4T/Projects/localdot`. None carries an attribution line (grep finds 0 over
`dfaf41f..HEAD`).

| Commit | Message |
|---|---|
| `cb9370f` (A) | `fix(daemon): harden the cell orchestrator, records and readiness after review` |
| `0170cb6` (B) | `fix(daemon): doctor cleans up stale probes, bounds its first call and passes the context socket` |
| `4384f20` (C) | `fix(daemon): bound slow status sockets and create bodies, and revoke tickets on any removal` |

"RED" below means the new test fails against `dfaf41f`'s source. The fake Docker's additions are
test infrastructure, so they were in place for those runs.

### Commit A: Task 8 items

| Item | Change | Test, and how it fails on `dfaf41f` |
|---|---|---|
| M1 | `CellStore.inventory()` returns `{ records, skipped }`, and `create()` throws `SkippedCellsError` (the API answers 409) while any cell is skipped. A cell folder with no `cell.json` counts as skipped too, because a create that crashed mid-save may have left containers. The record's undo step now comes before the save, so a failed save leaves no folder | store: "reports the ids of the cells it skips…" (`inventory` is not a function); orchestrator: "refuses to create while a cell record can't be read…" (create went ahead); api: "refuses a new cell with 409…" (`SkippedCellsError is not a constructor`) |
| M2 | A create whose start fails emits `removed` before its undo. The fake gained `failRequests` ("METHOD path" prefixes answered with 500) | "emits removed and undoes everything when the desktop cannot start / the gate cannot join its internal network" (`expected 'failed' to be 'removed'`) |
| M3 | The fake answers 409 for a duplicate network or container name, an in-use volume (even with `force`) and removing a running container without force, and 403 for deleting a network with running endpoints | `testing/fake-docker.test.ts` (2 tests; `expected 'ok' to be 409`). Reversing the undo order now fails 3 tests (mutation A1) |
| M4 | In the watch loop, a 404 on inspect sets `failed` ("desktop container is missing: removed outside localDot"); any other error still counts as running | "fails a ready cell whose container was removed…" (stayed `ready`). The guard "keeps watching … through a passing inspect error" passes on both |
| M5 | A stop error other than 304/404 sets `failed` ("stop failed: …"). A loop that `#detach` ends sets `failed` ("background check stopped (<code>)") if the entry it was detached with is still current. The watch's restart now detaches its readiness instead of awaiting it, so each loop is guarded by its own entry | "fails a cell whose stop Docker refuses…" (stayed `stopping`); "fails a cell whose background check throws…" (stayed `starting`) |
| M6 | Readiness uses `#exitedContainer`, so a gate that exits is named at once | "names the gate at once when it exits while the cell starts" (still `starting` after 1 s) |
| M7 | `reconcile()` catches per record and logs `cell <id>: not reconciled (<code>)` | "reconciles every other cell when one record can't be read" (reconcile rejected) |
| M8 | A listener's returned promise is caught; listener failures log `cell <id>: a state listener failed (<code>)` | "catches a listener's rejection…" (3 `ELISTEN` rejections escaped, carrying the path text) |
| M9 | `EnableIPv6: false` on the isolated/internal network specs and the egress spec | spec: "creates every cell network internal…"; Docker test: `{{.EnableIPv6}}` is `false` on both cell networks |
| M10 | The five Docker names must end in `-<id>`, and the three addresses must be dotted quads (0–255, no leading zeros) | 6 new store variants: another cell's name, a missing id, a stranger's container, 3 parts, an octet over 255, a host name (all were loaded) |
| M11 | `probeDesktopd` reads at most 64 KiB and requires a boolean `ok`. Detail copied into `error` (from desktopd or a container's `State.Error`) is clamped to 200 characters | readiness: 5 tests (body over 64 KiB, `ok` a string, `ok` missing, an array, null); orchestrator: "clamps desktopd's detail…" (10,178 characters) |
| M12 | Docker test 1 also probes three raw addresses, each expecting curl exit 7: the internal subnet's `.1`, 192.168.65.254 and 1.1.1.1. It checks the gate's live bindings (`NetworkSettings.Ports`: one `127.0.0.1` binding per relay, on the endpoints' ports). spec.test pins the exact top-level and HostConfig keys of both specs. The EACCES store test and the unreadable-`cell.json` orchestrator test skip as root (`process.getuid() === 0`) | test hardening, so it can't fail on `dfaf41f` by nature; it passes on real Docker |
| M13 | `endpoints()` returns `undefined` unless the cell is `ready`. Records are cached in memory (read once, set on create, dropped on remove), so `get`, `endpoints`, `record`, events and `updateStream` read no disk. `#emit` reads only the cache, which makes Fix 3's `#emit` catch unreachable, so I removed it; `#detach` remains the guarantee. Task 10 still works: its routes and tests use the same `CellApi` | "hands out endpoints only while the cell is ready"; "…for a cell that failed while it held ports" (both returned endpoints); "serves records from memory…" (300 reads, now 0) |
| M14 | Each undo step has a label, and a failed step logs `cell <id>: could not undo <object> (status N / Docker unreachable / code)` | "logs each undo step that fails…" (silent before) |

**Two existing tests changed.**
- "keeps watching through an unreadable cell.json…" now asserts that nothing is logged for the cell
  (the record comes from memory). Its probe reads no records, so only the orchestrator could touch
  the file. On `dfaf41f` it fails with the old `#emit` EACCES lines.
- The encoding test still uses its unchecked store, since M10 also refuses `../networks/…`.

**Mutations, all caught.**
- A1, the undo run in creation order: 3 tests.
- A2, endpoints when not ready: 2.
- A3, `#emit` reading the disk: 2.
- A4, 404 treated as running: 1.
- A5, `#detach` leaving the state: 1.
- A6, a listener's promise left uncaught: 1.
- A7, `create()` ignoring skipped cells: 1.
- A8, reconcile stopping at the first error: 1.
- A9, no clamp: 1.
- A11, no `removed` in the undo: 2.
- A12, silent undo errors: 1.
- A13, a stop error leaving `stopping`: 1.

### Commit B: Task 9 items

| Item | Change | Test, and how it fails on `dfaf41f` |
|---|---|---|
| D1 | Before the probe, the doctor lists `localdot-doctor-probe-*` networks (`GET /networks`, name filter) and removes those created more than 5 minutes ago. Separately, `doctor-main.ts` traps SIGINT/SIGTERM: the first lets the run finish, so the probe is removed, and the doctor then exits with 128 + the signal number; a second exits at once | "removes probe networks a killed doctor left behind, and none another doctor may use" (the stale probe stayed); the new `doctor-main.test.ts` spawns the real CLI against the fake, holds the probe's create, sends SIGINT, then releases it, and expects exit 130 with no network left (`expected null to be 130`, the network leaked) |
| D2 | The first `/version` has a deadline, `versionDeadlineMs` (default 10 s). Past it, the doctor reports `not answering on <socket> after N s` and skips the engine checks | "reports a socket that does not answer…" (on `dfaf41f` it waited for the late answer and reported `ok`) |
| D3 | `gatewayVerdict` requires `IPAM.Config[0].Subnet` and `Internal === true`, with readable reasons. The fake gained a `networkInspect` hook | 3 tests: null IPAM (a `TypeError` text before), no subnet (passed before), not internal (passed before) |
| D4 | After a 4xx create, the doctor doesn't delete by name, since the name may be another doctor's probe; status 0 and 5xx still delete | "leaves a network of its name alone when Docker refuses to create the probe" (the 409's name was deleted); the guard "still removes the probe by name … 5xx" passes on both |
| D5 | `socketCheck` passes any answering socket and names it. The `fix` field is gone from `DockerSocket` and `findDockerSocket`, because nothing uses it once the daemon finds the context socket itself. The socket tests drop their `fix` expectations, and the Docker test runs the doctor on the context socket and expects `docker-socket` ok | "passes the docker context's socket, which the daemon finds too, and names it" (failed with the fix on `dfaf41f`) |

**Mutations, all caught.**
- B1, no sweep: 1 test.
- B2, a sweep that ignores age: 2.
- B3, no deadline: 1.
- B4, no internal check: 1.
- B5, deleting after a 4xx: 1.
- B6, no signal trap: 1.

**A test fix.** The D2 test first left `/version` held forever on the old code, which hung the next
test's `afterEach`. It now releases the hold after 1 s, so the old code fails on its assertion
instead.

**Sanity run.** The real `pnpm --filter @localdot/daemon run doctor` printed six ok lines and exited
0, and no probe network was left.

### Task 10 items (commit C)

| Item | Change | Test, and how it fails on `dfaf41f` |
|---|---|---|
| 1 | The status socket's logic is now `followCell(ws, cells, current)` over a small `StatusSocket` interface. Before each send, a socket buffering more than 1 MiB is terminated, and its close unsubscribes it | "is cut off once over 1 MiB is buffered, and stops listening": a fake socket with `bufferedAmount` set high (`followCell is not a function`) |
| 2 | (pin) After the close, `cells.listeners.size` is 0, via `vi.waitFor` because the server's close lands just after the client's | passes on `dfaf41f`, where the cleanup already worked; mutation C2 (no unsubscribe) fails it |
| 3 | `DELETE /api/cells/:id` revokes the ticket in a `finally` | "revokes the cell's stream ticket even when its removal fails" (the ticket still resolved) |
| 4 | `bodyLimit({ maxSize: 1024 })` on `POST /api/cells`, so larger bodies get 413 | "refuses a create body over 1 KiB with 413" (`expected 202 to be 413`) |

**Mutations, all caught.**
- C1, no backpressure: 1 test.
- C2, no unsubscribe on close: 2.
- C3, no body limit: 1.
- C4, revoking only on success: 1.

### Checks (final tree, `4384f20`)

- `pnpm format`, `pnpm lint`, `pnpm typecheck` and `pnpm hygiene`: exit 0.
- The cells, doctor, socket, router and app suites, 3 runs: 3 × 206/206.
- `pnpm test`: 32 files, 343 tests.
- The orchestrator Docker test: 4/4 (34.2 s).
- The doctor Docker test: 2/2.

Both Docker suites also ran before their commits: the orchestrator's on A's changes (4/4) and the
doctor's on B's (2/2).

**Docker hygiene after the final runs.** No `localdot-test-*` containers, networks or volumes, and
no `localdot-doctor-probe-*` network. Dangling volumes number **25**: the baseline 23, plus two
anonymous volumes that are not mine:
- they were created at 20:14 and 20:37 BST, between my Docker runs (20:03, when dangling read 23,
  and 21:00);
- they hold root-owned browser profile folders (`.cache`, `.config`, `.local`, `.pki`);
- the count stayed at 25 through all my later runs.

I left them alone. To check their contents, I mounted each one read-only in a `--rm` container
(`localdot/gate:dev`, no network). That changed nothing, but it did touch them.

### Remaining notes

- `list()` still reads the disk: one read per record per API listing, not per frame.
- `#readPorts` doesn't check the HostIp itself; the Docker test checks the live bindings.
- The deferred Minor (a "restarting" note before "removed") is unchanged.
