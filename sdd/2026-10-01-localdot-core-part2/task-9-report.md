# Task 9 report: `doctor` checks for the Docker prerequisites

**Status: DONE_WITH_CONCERNS**

- **Commit:** `28b5707 feat(daemon): doctor checks for Docker prerequisites` on `feat/core-part2`, on top of BASE `365aab9`. The commit carries no attribution line (checked with grep), and the working tree is clean.
- **Concern 1, the CLI line.** The brief's `pnpm --filter @localdot/daemon doctor` cannot work. `doctor` is a pnpm built-in (`pnpm doctor`, "Checks for known common issues"), and pnpm runs it instead of the script. It answers `ERROR Unknown option: 'recursive'` and exits 1. The working form is `pnpm --filter @localdot/daemon run doctor`. The script keeps the brief's name. The plan's Task 9 Interfaces line and Task 18's README text need `run`.
- **Concern 2, the daemon's socket.** Task 10's daemon builds `new DockerClient()`, which reads only `DOCKER_HOST` and `/var/run/docker.sock`. It ignores the CLI context. The doctor therefore finds Docker through the context and runs every check there. It still **fails** `docker-socket`, says which socket it used and gives the fix, because the daemon would not find Docker on its own. If Task 10 instead built its client from `findDockerSocket()`, the doctor should stop failing in that case.

## Verification

| Command | Result |
|---|---|
| `pnpm exec vitest run apps/daemon/src/doctor.test.ts` | 14/14 (the brief's 6, plus 8 for the rulings) |
| `pnpm exec vitest run apps/daemon/src/doctor-socket.test.ts` | 6/6 (socket discovery against an injected environment) |
| `pnpm exec vitest run apps/daemon/src/cells/docker.test.ts` | 14/14 (12 before, plus `engineVersion` and `compareApiVersions`) |
| `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/doctor.docker.test.ts` (no `--`) | 2/2, about 0.5 s |
| `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/docker.docker.test.ts` | 1/1 (touched: it now imports `compareApiVersions`) |
| `pnpm --filter @localdot/daemon run doctor` | six `ok` lines (below), exit 0 |
| `pnpm format` / `pnpm lint` | format rewrapped only `doctor.test.ts` (the brief's long lines). Lint exits 0. No import-order fixes were needed |
| `pnpm typecheck` | exit 0 |
| `pnpm hygiene` | exit 0 (it scans untracked files too) |
| `pnpm test` | 27 files, 277 tests passed (Task 8 left 25 files and 255 tests: +2 files, +22 tests) |

The brief's Step 3 chain was re-run on the committed tree with all three parts green:
```
ok   docker-socket            /var/run/docker.sock (the default socket; Engine 29.2.0, API 1.53)
ok   docker-engine            Engine 29.2.0
ok   isolated-gateway-mode    internal networks get no gateway address
ok   image-desktop            localdot/desktop:dev
ok   image-gate               localdot/gate:dev
ok   port-4750                127.0.0.1:4750 is free
chain exit=0
```

## Steps and RED evidence

1. **Step 1.** I wrote the brief's `doctor.test.ts` verbatim.
   **RED:** `Error: Cannot find module './doctor.ts' imported from …/doctor.test.ts`. This is Vitest 5's wording for "Failed to load url".
2. **Step 2.** I wrote the brief's `doctor.ts`, `doctor-main.ts`, the `doctor` script and `doctor.docker.test.ts` verbatim.
   **GREEN:** 6/6.
3. **Rulings, by TDD.**
   - **`DockerClient` additions.** I wrote two tests first. RED: `engineVersion is not a function` and `compareApiVersions is not a function`. I then implemented both. GREEN: 14/14.
   - **The fake.** It now refuses out-of-range API versions. No other suite configures the fake's version, and `cells/` stayed at 98/98 afterwards.
   - **`runDoctor` tests.** I added 8 tests, and **all 8 failed on the brief's `doctor.ts`** for the intended reason:
     - too old: the brief's code fails `docker-socket` (`ok: false`).
     - too new, and the refusal without a range: `docker-engine` reads `"skipped"`.
     - socket source and fix: the brief's code shows `ok: true` with no source.
     - the unreachable socket's name: the detail lacks the path.
     - the given probe name: the probe was named `localdot-doctor-probe-e1f73651`, not the given name.
     - the lost create reply: `expected 1 to be +0` networks, so the probe leaked.
     - a failed removal is swallowed, so the check reads `ok: true`.

     `doctor-socket.test.ts` failed to load because the module did not exist yet.
   - **What the brief's code shows on an API mismatch**, as printed through the fake (the body is the real Docker Desktop 4.60 body):
     ```
     FAIL docker-socket            docker 400 on /version: {"Platform":{"Name":"Docker Desktop 4.60.0 (218231)"},"Version":"","ApiVersion":"","Os":"","Arch":""}
     FAIL docker-engine            skipped
     ```
   - I then implemented the rulings. **GREEN:** 14/14 and 6/6.
4. **Mutations.** I applied one mutation at a time, ran the suite and restored the file. Each restore was verified byte-for-byte with `cmp`. Every mutation was caught:

| Mutation | Fails |
|---|---|
| S1 never read the CLI context | context-socket test; DOCKER_HOST-points-nowhere test |
| S2 ask the CLI before checking the daemon's socket | default-socket and DOCKER_HOST tests (they assert the CLI isn't spawned) |
| S3 Desktop-setting advice even when DOCKER_HOST is set | DOCKER_HOST-points-nowhere test |
| S4 accept a context socket that does not exist | "keeps the daemon's socket when no other exists" |
| S5 no `~/.docker/run/docker.sock` fallback | user-socket fallback test |
| D1 no unversioned `/version` | too-old and too-new tests |
| D2 old/new comparison swapped | too-old and too-new tests |
| D3 socket `fix` ignored | socket source/fix test |
| D4 delete only when the create replied | lost-reply/lost-inspect test |
| D5 swallow a failed removal | failed-removal test |
| F1 fake honours every API version | all three readable-refusal tests (the fake drives the 400 path) |

## What changed beyond the brief, and why (each is a controller ruling or follows from one)

- **Ruling 1, readable errors** (`doctor.ts`, `cells/docker.ts`).
  - When `docker.version()` fails with **400**, the doctor asks the unversioned `/version`. That is the new `DockerClient.engineVersion()`, a private `#send(prefix, req)` behind `request`. I confirmed against Docker Desktop with read-only curl that the unversioned path answers even when `/v1.40` or `/v1.99/version` gets the message-less 400.
  - The result: `docker-socket` is **ok** (the socket answered), `docker-engine` fails with a sentence, and the other three checks are `skipped`. The sentences:
    - "Docker Engine 26.1.4 is too old: it serves API 1.24–1.45 and localdot speaks 1.47; update Docker Desktop (Engine 28+)"
    - "Docker Engine 35.0.0 is too new: it serves API 1.50–1.60 and localdot speaks 1.47; update localdot"
    - otherwise, "Docker refused API 1.47, the version localdot speaks (HTTP 400 on /version)"
  - Tests assert that no detail contains `{` or `}`.
  - `compareApiVersions` moved verbatim from `docker.docker.test.ts` into `docker.ts`, so the doctor, the fake and that test share one copy. Its `1.100` self-check is now a non-Docker unit test, which closes the Task 6 deferred minor about the Docker-gated self-check.
- **Ruling 2, socket discovery** (new `doctor-socket.ts`).
  - `findDockerSocket(env, probes)` uses the daemon's own socket (`dockerSocketPath(env)`: DOCKER_HOST, else the default) when it exists. In that case it never spawns the CLI.
  - Otherwise it tries, in order:
    - the active context, read from `docker context inspect` (JSON; it honours DOCKER_CONTEXT, with a 5 s timeout);
    - `~/.docker/run/docker.sock`.
  - The first of these that exists is used, with a `fix`:
    > localdot looks for /var/run/docker.sock (the default socket), which is missing: turn on "Allow the default Docker socket to be used" in Docker Desktop's Settings › Advanced, or set DOCKER_HOST=unix://…

    When the missing socket came from DOCKER_HOST, the fix is only `set DOCKER_HOST=…`.
  - `doctor-main.ts` builds the client from it. `runDoctor` takes an optional `socket`, and the `docker-socket` detail names the source: `path (source; Engine …)`.
  - A socket that comes with a `fix` fails `docker-socket` while every other check still runs against it (see Concern 2). An unreachable socket's detail now starts with the path.
  - The unit tests inject `env` (HOME, DOCKER_HOST), `exists` and `context`. A Docker test pins the real CLI's JSON shape: with the default socket hidden through `exists`, it finds `unix://<context host>` and that socket answers `version()`.
- **Ruling 3, the probe network.**
  - It carries no label, as in the brief.
  - Its default name is `localdot-doctor-probe-<8 hex>`. It is overridable through `runDoctor({ probeNetwork })`, and the Docker test passes `localdot-test-doctor-<hex>` and removes that exact name in `afterAll`.
  - It is now **deleted by name after every outcome**. The brief deleted by Id only after the create replied, so a create whose reply was lost leaked the network (the RED above).
  - A removal that fails, other than 404, fails the check and appends `could not remove the probe network (docker network rm <name>): <error>`.
  - Docker's own event log for the real run: `create localdot-test-doctor-a80f08b5` and `destroy localdot-test-doctor-a80f08b5`, both `type=bridge`, nothing else.
- **Ruling 4.** The unit tests use the brief's `listen(0)` free port. The Docker test keeps the brief's 4798 (the test range). Only the real CLI run checks 4750.
- **Ruling 5.** I ran the Docker tests as `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker <file>`.
  - The leftover check uses `docker("network", "ls", …)`, which throws on a non-zero exit, so a failing CLI cannot pass as "gone".
  - The context test's `execFileSync` throws on a non-zero exit too.
  - The CLI runs' exit codes were asserted: 0 healthy, 1 in the two runs below.
  - No prune, no restart. The only resources touched were the doctor's own probe networks.
- **The fake** (`cells/testing/fake-docker.ts`). A versioned request outside `[MinAPIVersion, ApiVersion]` gets a 400:
  - Docker Desktop's message-less body for `/version`;
  - the engine's "client version X is too old/new" message elsewhere.

  Unversioned paths always pass. Its prefix strip now accepts any `vN.N` instead of only `v1.N`.

Costs if vetoed:
- Dropping `socket` and `probeNetwork` from `DoctorDeps`, plus `doctor-socket.ts`, its tests and the second Docker test: about 150 lines.
- Reverting the 400 path, `engineVersion` and `compareApiVersions`: about 60 lines plus 5 tests.

## Real CLI runs beyond the healthy one (read-only for Docker; the probe is created and removed)

- **`DOCKER_HOST=unix:///tmp/localdot-gone.sock pnpm --silent --filter @localdot/daemon run doctor`** exits 1. With DOCKER_HOST set, the CLI's context is `default`, which points at the same missing path, so discovery falls back to Docker Desktop's user socket:
  ```
  FAIL docker-socket            /Users/richardliao/.docker/run/docker.sock (Docker Desktop's user socket; Engine 29.2.0, API 1.53), but localdot looks for /tmp/localdot-gone.sock (DOCKER_HOST), which is missing: set DOCKER_HOST=unix:///Users/richardliao/.docker/run/docker.sock
  ok   docker-engine            Engine 29.2.0
  ok   isolated-gateway-mode    internal networks get no gateway address
  ok   image-desktop / image-gate / port-4750 …
  ```
- **The same, with HOME set to an empty scratch folder** (`node --import tsx src/doctor-main.ts`), exits 1:
  `FAIL docker-socket /tmp/localdot-gone.sock (DOCKER_HOST): docker unreachable on /version: ENOENT; is Docker Desktop running?`
  The four engine checks read `skipped`, and `port-4750` is ok.
- **The default-socket-off case** can't be produced here without changing Docker Desktop's settings. The Docker test covers it by hiding `/var/run/docker.sock` through `exists`: discovery finds `desktop-linux` → `/Users/richardliao/.docker/run/docker.sock`, and that socket answers.

## Docker hygiene

There were no `localdot-*` networks or containers before or after. The images were not touched. The commands I ran: read-only `docker context`/`image ls`/`network ls`/`events`, curl GETs, and the doctor's own probe networks, all removed.

## Carry-forward and minors

1. **(Concern 1)** Replace `pnpm --filter @localdot/daemon doctor` with `… run doctor` in the plan's Task 9 Interfaces and in Task 18's README block.
2. **(Concern 2)** Decide whether Task 10's daemon should use `findDockerSocket()`. If it does, `findDockerSocket` should keep its `fix` only for the doctor's wording, or drop it, and `docker-socket` would pass via the context.
3. Minor: a doctor killed between the probe's create and delete leaves `localdot-doctor-probe-<hex>`. The random name keeps later runs from failing on it. I added no sweep, on purpose: two doctors running at once must not delete each other's probe.
4. Minor: `doctor-main.ts` keeps the brief's bare `parsePort(process.env.LOCALDOT_PORT)`, so a bad value prints a stack trace (the message is readable at its top). `main.ts` catches the same error and prints only the message.
5. Minor: the second Docker test assumes the active context is a Unix socket, which is true for Docker Desktop. A remote context would fail it.
6. Unchanged (Task 6 deferred): other error replies without `message` are still embedded whole by `DockerError`. The doctor meets the known case, `/version` on an API mismatch, and handles it.
7. A `DOCKER_HOST=tcp://…` is ignored by the daemon (Unix sockets only) and therefore by the doctor too. They are consistent, but the doctor does not say so.

## Files

- New:
  - `apps/daemon/src/doctor.ts`
  - `apps/daemon/src/doctor-main.ts`
  - `apps/daemon/src/doctor-socket.ts`
  - `apps/daemon/src/doctor.test.ts`
  - `apps/daemon/src/doctor-socket.test.ts`
  - `apps/daemon/src/doctor.docker.test.ts`
- Modified:
  - `apps/daemon/package.json` (`"doctor": "tsx src/doctor-main.ts"`)
  - `apps/daemon/src/cells/docker.ts`
  - `apps/daemon/src/cells/docker.test.ts`
  - `apps/daemon/src/cells/docker.docker.test.ts`
  - `apps/daemon/src/cells/testing/fake-docker.ts`
