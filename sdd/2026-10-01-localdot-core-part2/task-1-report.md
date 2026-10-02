# Task 1 report: Gate image with address-bound relays, and the Docker test gate

**Status: DONE_WITH_CONCERNS**
Commit: `d9063fd feat(gate): forwarder image with address-bound relays and the Docker test gate`
(on `feat/core-part2`, parent `b778394`; no attribution line).

## What I implemented

- **Docker test gate.** `vitest.docker.config.ts` (verbatim). `vitest.config.ts` replaced with the
  brief's version, which excludes `**/*.docker.test.ts`. Root script
  `"test:docker": "vitest run --config vitest.docker.config.ts"`. Five `.gitignore` entries
  appended.
- **`hostAddress(cidr, offset)`** in `apps/daemon/src/cells/ipv4.ts` (verbatim), with its 2 unit
  tests (verbatim).
- **Docker CLI test helpers** in `apps/daemon/src/cells/testing/docker-cli.ts`: `DOCKER_TESTS`,
  `docker`, `dockerOk`, `dockerExec`, `dockerExecAs`, `publishedPort`, `subnetOf`, `removeAll`,
  `sleepSync` and `waitFor(label, pred, ms, everyMs = 1000)`, exported exactly as the brief's code
  has them (ruling 4). `removeAll` removes containers with `docker rm -fv` (ruling 3).
- **Gate image** `cells/gate/{Dockerfile,relay.sh,build.sh}` (all three verbatim; scripts committed
  100755). `localdot/gate:dev` is 15.6 MB, runs as `nobody` with entrypoint `/relay.sh` (mode 555).
- **Docker-backed gate test** `apps/daemon/src/cells/gate-image.docker.test.ts`: the brief's 6 tests
  with one deliberate deviation (below). The keyd stand-in listener runs on a worker thread instead
  of the test's own event loop.

Rulings applied: (1) no branch step, work done on the existing `feat/core-part2`; (2) no `--` in the
`test:docker` command; (3) `rm -fv`; (4) helper signatures as coded.

## Deviation from the brief: the host listener runs on a worker thread

**The brief's test cannot pass.** First Docker run with the brief's code:
```
 FAIL  apps/daemon/src/cells/gate-image.docker.test.ts > gate image > relays the cell to the host listener bound to 127.0.0.1
AssertionError: expected 'curl: (28) Operation timed out after …' to contain 'host-ok'
- host-ok
+ curl: (28) Operation timed out after 5006 milliseconds with 0 bytes received
      Tests  1 failed | 5 passed (6)
```
**Root cause.** The brief starts the keyd stand-in (`createServer(...).listen(4799)`) in the Vitest
worker, then probes it with `dockerExec`, which is `spawnSync`. `spawnSync` blocks that same event
loop until curl exits. The kernel still accepts the TCP connection, but the handler can't run, so
the response never comes. A Docker-free repro on the host showed the same result:
```
spawnSync curl against an in-process server: 28 "curl: (28) Operation timed out after 3006 milliseconds with 0 bytes received\n"
async execFile curl against the same server: 0 "ok\n"
```
**It also made two negative checks toothless.** Any connection that reaches the blocked listener
just times out, giving curl exit 28, which is non-zero, which the test reads as "blocked". The
following check proves it.

**Fix (test file only; no helper or interface change).** The listener runs in
`new Worker(HOST_LISTENER, { eval: true })`, its own thread and event loop, and the test awaits its
`"listening"` message. `afterAll` calls `terminate()`. A host check showed that a worker-thread
server answers during `spawnSync` (`0 "host-ok\n"`). A port clash rejects `once()` with
`EADDRINUSE`, so the test fails at once instead of hanging until the 600 s hook timeout. After
`terminate()` the port refuses connections (curl 7). There is one comment on why the listener has
its own thread.

### Mutation check: the address-binding tests now have teeth

I temporarily removed every `bind=` from `relay.sh`, so the relays listened on all interfaces as in
S3, ran both test versions against it, and then restored the file (`cmp`-verified byte-identical).
- **M1, the committed test against the mutant:** exactly the two address-binding tests fail.
  ```
  × does not expose the keyd relay on the egress network     (expected +0 not to be +0)
  × does not expose the inbound relays on the internal network (expected +0 not to be +0)
  Tests  2 failed | 4 passed (6)
  ```
- **M2, the brief's original test against the same mutant:**
  ```
  × relays the cell to the host listener bound to 127.0.0.1 5085ms   (the deadlock)
  × does not expose the inbound relays on the internal network 63ms
  Tests  2 failed | 4 passed (6)
  ```
  So the brief's version **passes** "does not expose the keyd relay on the egress network" even
  when the keyd relay is exposed there. The gate test was meant to prove exactly that property.

The final Docker run rebuilt `localdot/gate:dev` from the real files. `docker run … cat /relay.sh`
matches the repo file byte for byte.

## Tests and results (TDD evidence)

**RED** (Step 3): `pnpm exec vitest run apps/daemon/src/cells/ipv4.test.ts`, exit 1
```
 FAIL  apps/daemon/src/cells/ipv4.test.ts [ apps/daemon/src/cells/ipv4.test.ts ]
Error: Cannot find module './ipv4.ts' imported from /Volumes/Husky's SSD 4T/Projects/localdot/apps/daemon/src/cells/ipv4.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```
This was expected because `ipv4.ts` didn't exist yet. Vitest 5.0.3 says "Cannot find module"
where the brief expected "Failed to load url"; the cause is the same.

**GREEN** (Step 5): the same command, exit 0
```
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

**Gate image** (Step 6): `chmod +x … && cells/gate/build.sh` gave
`localdot/gate:dev   15.6MB` (about 16 MB expected). Before running the test I checked BusyBox
`ip -4 -o addr show` inside the image. It prints `11: eth0    inet 172.17.0.3/16 …`, with spaces
before `inet`, so `has_addr`'s `grep -q " inet $1/"` matches. Fractional `sleep 0.1` works.

**Docker test** (Step 8, ruling 2):
`LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/gate-image.docker.test.ts`, exit 0
```
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  5.16s (tests 99%)
```
I ran it green twice: once after the fix and once on the final formatted code.

**Without the variable:** `pnpm test:docker`, exit 0
```
 Test Files  1 skipped (1)
      Tests  6 skipped (6)
```
**Unit suite:** `pnpm test`, exit 0. `Test Files 16 passed (16)`, `Tests 145 passed (145)`, which is
the Part 1 baseline of 143 (measured before any change) plus the 2 ipv4 tests. `vitest list
--filesOnly` lists no `*.docker.test.ts`.

**Ruling 3 check.** I ran a container with an anonymous volume (`-v /data`) and removed it two ways:
```
removeAll (rm -fv): anonymous volume 2f1b6f252002 still exists? false
plain rm -f:        anonymous volume aceeb31003c4 still exists? true
cleaned up the counterfactual's volume: true
```
**Static checks**, each with its exit code captured unpiped:
- `pnpm format`: Biome fixed 2 files, `docker-cli.ts` and the Docker test.
- `pnpm lint`: exit 0.
- `pnpm typecheck`: exit 0.
- `pnpm hygiene`: exit 0.

**Docker hygiene after all runs.** I recorded a baseline before creating anything. Afterwards:
- `docker ps -a --filter name=localdot-test` shows a header only.
- `docker network ls --filter name=localdot-test` shows a header only.
- `docker volume ls --filter dangling=true` shows 23 volumes, the same 23 as the baseline. All of
  them predate this task (hex anonymous volumes and `hentok*`), and 0 are new.
- The network count is 9 before and 9 after, and port 4799 is free.
- Every throwaway container I used for checks (`localdot-test-ipcheck`, `-relaycheck`, `-stopcheck`,
  `-volcheck`) and the `localdot-test-stopcheck` network are gone.
- The images `localdot/gate:dev` and `localdot/probe:test` remain by design, since the brief
  creates them.

## Files changed (commit d9063fd)

- `.gitignore`: 5 entries appended.
- `package.json`: `test:docker` script added.
- `vitest.config.ts`: replaced with the brief's version.
- `vitest.docker.config.ts`: new.
- `apps/daemon/src/cells/ipv4.ts` and `ipv4.test.ts`: new.
- `apps/daemon/src/cells/testing/docker-cli.ts`: new.
- `apps/daemon/src/cells/gate-image.docker.test.ts`: new.
- `cells/gate/Dockerfile`: new.
- `cells/gate/relay.sh` and `cells/gate/build.sh`: new, mode 100755.

## Self-review findings

- I diffed each new file against the brief's code block. These are identical: `vitest.docker.config.ts`,
  `vitest.config.ts`, `ipv4.ts`, `ipv4.test.ts`, `Dockerfile`, `relay.sh` and `build.sh`.
- `docker-cli.ts` differs only in these ways:
  - Biome's line wrapping.
  - `rm -fv` (ruling 3).
  - A one-line comment on why `-v` is there, since a later "simplify" back to `-f` would leak a
    volume per webtop run.
  - Braces on the four bodies Biome wrapped onto a second line. Biome left them brace-less; the repo
    and the brief's own `ipv4.ts` brace every multi-line body (21 cases, none without braces).
- The Docker test differs only in the worker-thread listener (explained above) and Biome's wrapping.
- No narrative comments. Every container and network the test creates is named `localdot-test-*`
  and removed in `afterAll`. Nothing under `/Volumes/Husky's SSD 4T` is bind-mounted; the gate is
  built from a build context and the probe from stdin. The listener binds `127.0.0.1:4799`, inside
  the test range.

## Issues and concerns for the controller

1. **Deviation (above): the worker-thread listener.** It is needed for the brief's own "6 tests
   pass", and it restores the keyd-on-egress check. Please confirm.
2. **The same deadlock can hit later Docker tasks.** Every helper in `docker-cli.ts` is synchronous,
   and so are `sleepSync`/`waitFor` (both use `Atomics.wait`). They all block the test's event loop.
   Any later `*.docker.test.ts` that has a container, or a `waitFor` predicate, reach a server
   running in the test process will hang or time out. Examples are an in-process daemon, a keyd
   stand-in, or a stream proxy, in Task 8's orchestrator test, Task 11 or the e2e harness.
   Worse, its negative checks can pass falsely. Such servers need their own thread or process, or
   the probes need to be async. Worth a note in those briefs.
3. **The gate ignores SIGTERM** (I left `relay.sh` verbatim). `/relay.sh` is PID 1 and sets no
   `trap`, so the kernel drops SIGTERM and `docker stop` always ends in SIGKILL, with exit code 137.
   It measured 1.13 s here only because this Engine reports the container's `StopTimeout` as 1.
   Task 8's `stop()` sends `POST /containers/{name}/stop?t=10`, and its `gateSpec` sets no `Init`,
   so every cell stop would wait the full 10 s on the gate. Two one-line fixes would work: add
   `trap 'exit 0' TERM INT` to `relay.sh` after the relays start, or set `HostConfig.Init: true` in
   `gateSpec`. I didn't change it because it is a cross-task design choice outside this brief.
4. **Minor:** the RED error wording differs from the brief because of the Vitest 5.0.3 message; the
   cause is the same.

---

## Fix report: controller rulings on the three concerns

**Status: DONE.**
Commit `6d6f019 fix(gate): exit cleanly on SIGTERM instead of waiting to be killed` is a new
commit on top of `d9063fd` (not an amend) and has no attribution line.

- **Ruling 1, ACCEPTED: the worker-thread keyd listener.** It stays as committed in `d9063fd`.
  The mutation proof is above under "Mutation check". With every `bind=` removed, both
  address-binding tests fail against the committed test. The brief's in-process version passes
  the keyd-on-egress check falsely.
- **Ruling 2, NOTED for later tasks.** Nothing to do in Task 1.
- **Ruling 3, FIXED: the gate now stops cleanly on SIGTERM.**

### What changed

- **`cells/gate/relay.sh`:** I added `trap 'exit 0' TERM INT` and a one-line comment saying why
  it's needed (PID 1 ignores signals it doesn't trap) and why the relays don't need killing (they
  go down with the container). The trap sits right after the env check. That is before the relays
  start, as ruled, and before the address-wait loop, so a gate still waiting for its internal
  address can also be stopped.
- **`apps/daemon/src/cells/gate-image.docker.test.ts`:** one new test, "exits cleanly on docker
  stop instead of waiting to be killed". It is placed last on the shared gate, with a comment
  saying it must stay last. It runs `docker stop -t 10 localdot-test-gate` and asserts:
  - `.State.ExitCode` is `"0"` (not 137);
  - `docker stop` returned in under 3000 ms.

### TDD evidence

**RED.** I added the test before the trap. Command:
`LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/gate-image.docker.test.ts`.
Exit code 1:
```
 ❯ apps/daemon/src/cells/gate-image.docker.test.ts (7 tests | 1 failed) 15453ms
     × exits cleanly on docker stop instead of waiting to be killed 10403ms
AssertionError: expected '137' to be '0' // Object.is equality
Expected: "0"
Received: "137"
      Tests  1 failed | 6 passed (7)
```
This is the expected failure. The trap-less gate ignored SIGTERM, waited out the full `-t 10`
(10,403 ms) and was SIGKILLed (exit code 137).

**GREEN.** The same command after the trap. Exit code 0:
```
 Test Files  1 passed (1)
      Tests  7 passed (7)
   Duration  5.80s (tests 99%)
```
A verbose run shows the stop test at **597 ms** (that includes `docker stop` and `docker inspect`).
The other six tests take 56 to 167 ms each.

**Extra check, not part of the suite.** I started a gate whose internal address never appears, so
it sits in the address-wait loop, and stopped it with `docker stop -t 10`. It returned in 133 ms
with exit code 0.

**Image check.** `docker run … cat /relay.sh` on `localdot/gate:dev` matches the committed
`relay.sh` byte for byte. Later tasks therefore get the trap version.

### Other checks

| Check | Result |
| --- | --- |
| `pnpm format` | exit 0, "No fixes applied" |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm hygiene` | exit 0 |
| `pnpm test` | exit 0, 16 files, 145 tests |

### Docker hygiene after the fix runs

- `docker ps -a --filter name=localdot-test`: header only.
- `docker network ls --filter name=localdot-test`: header only.
- `docker volume ls --filter dangling=true`: 23 rows, the same 23 as the baseline, 0 new.
- 9 networks, the same as the baseline. Port 4799 is free.
- The throwaway `localdot-test-waitstop` and `localdot-test-relaycheck` containers are removed.

### Self-review against the brief

- `relay.sh` now differs from the brief only by the ruled trap and its comment.
- The Docker test differs only by:
  - the worker-thread listener (ruling 1);
  - the new last test (ruling 3);
  - Biome's line wrapping.
- Every other file is unchanged from `d9063fd`.
