# Part 2 plan — revision 2 change log (pre-flight rulings F1–F31, 2026-10-01)

Plan: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-10-01-localdot-core-part2.md`
(was 8,792 lines, now 9,170; 18 tasks). Line numbers below are the new ones. Spec: one line changed
(217). Inputs: `localdot/.superpowers/sdd/2026-10-01-localdot-core-part2/preflight-scan.md` and the
rulings in `progress.md`, plus the controller's F31 and Task 1 deviations sent during the pass.

Task 1 was already committed when I checked (`d9063fd`, `6d6f019`). Its text changed only for F21,
F9, F10 (`rm -fv`), F26 (Interfaces) and the two built deviations. After `biome format`, the plan's
Task 1 code now equals the committed files byte for byte, except `docker-cli.ts`, where the
implementer braced the single-statement `if`/`for` bodies (cosmetic, left as written in the plan).

## Findings

- **F1 (relay order).** `desktopStreamRoute` no longer upgrades the viewer first: `relay()` dials the
  cell, reports `connecting`, and completes the viewer's upgrade from the upstream's `open`; the
  dial-phase `close` listener on the raw socket terminates the upstream if the viewer leaves first;
  an upstream error before `open` (ws reports a non-101 answer as an error) gets the viewer
  `refuse(socket, "502 Bad Gateway")`. Code 6286–6359 (relay 6302–6359), intro 5804–5807,
  Interfaces 5828–5831, closing Interfaces 9063–9065. Test: the fake Selkies now checks basic auth on
  upgrades (`verifyClient`, 6053–6058), and the "refuses a stream upgrade…" test gained the 502 case
  (6174–6187). S8 `host.mjs` got the same order and a 502 (1697–1747). No "wait for live" was added
  to the tests: with dial-first the upstream is open before the viewer's `open` fires.
- **F2 (restart test).** Split into "restarts an exited desktop … keeps the gate's published ports"
  (4081–4105, endpoints `toEqual(before)`) and "restarts an exited gate … reads its new published
  ports" (4107–4126, both base URLs change). Review Focus 2 (122–127), Step 6 note (4754–4759).
- **F3 (pump hang).** The endless source's `pull` is `async` and awaits `setTimeout(r, 1)` before
  enqueuing; `pulls += 1` stays first, so a pull in flight at cancel was already counted (8144–8152).
  `pumpFrames` unchanged.
- **F4.** `StaticFile.body: Uint8Array<ArrayBuffer>` (5883); Interfaces 5824.
- **F5.** Import orders fixed: `lock.test.ts` 2610, Task 6a `main.ts` 2791, `spec.test.ts` 3443–3445,
  `doctor.ts` 4990, `status-stream.test.ts` 5514–5516, Task 10 `main.ts` snippet 5745–5753 (now sorted
  by path), `pump.test.ts` 8110, `render-worker.ts` 8348. Global Constraint note on
  `pnpm exec biome check --write <files>` (98–99).
- **F6.** `fake-docker.ts` computes each match before its branch: `image` 3774, `network` 3786,
  `connect` 3798, `volume` 3812, `action` 3825, `container` 3845; `let m` removed. Route order unchanged.
- **F7.** Dropped `src` from `DesktopFrame`'s effect deps (8494) with a two-line reason (8477–8478).
  Why: the 250 ms poll taps any track whose id differs from `tapped.current`, and a new `src` loads a
  new document whose Selkies client creates a new `MediaStream` track (new id), so the poll re-arms by
  itself; the effect never reads `src`. Biome confirms: `[src, onSource]` → "This hook specifies more
  dependencies than necessary: src"; `[onSource]` → clean.
- **F8.** Task 3b states the resulting chmod line (1352–1354); Task 5 extends it "keeping every
  earlier entry" to include `/usr/local/bin/localdot-plank` (2260–2262). No later chmod rewrite exists.
- **F9.** Every `pnpm test:docker -- <file>` is now `pnpm test:docker <file>`: 575, 846, 1246, 1512,
  2312, 2560, 4859, 5133. Per-file counts stand (Task 1's becomes 7 for the new test, below).
- **F10.** `NAME_PREFIX = "localdot-"` and `cellNames(id, prefix = NAME_PREFIX)` (3586–3597);
  orchestrator dep `namePrefix` (4315–4316, 4383, 4399, used at 4473); the orchestrator Docker test
  passes `localdot-test-` (4777, 4787), asserts the prefixed name (4808) and its Step 7 checks go by
  `name=localdot-test-` for containers, networks and volumes (4859–4863). Doctor: new
  `isolatedNetworkSpec(name)` (no labels, 3600–3607; `internalNetworkSpec` = it plus the label,
  3609–3611), used for the probe (5046–5048); spec test 3456–3465, doctor test 4930–4931; Interfaces
  3416–3430, 4882–4883. `removeAll` uses `docker rm -fv` with the built comment (358–360). e2e:
  `desktopContainer(cellId)` filters `label=localdot.cell=<id>` and `label=localdot.role=desktop`
  (8731–8737); both specs take the id from the POST `/api/cells` response (8829–8832, 8912–8914) and
  assert `localdot-desktop-<id>` (8861–8862, 8918–8919). Task 13's manual cleanup no longer suggests
  removing `localdot-*` objects by pattern; it removes one cell by id (8013–8017).
  `sample-record.ts` unchanged: it is written in Task 7, before `spec.ts` exists, spells the default
  names, and creates nothing in Docker. `fake-orchestrator.ts` builds no names. `main.ts` keeps the
  default prefix (no new env knob), so the e2e cells stay `localdot-<role>-<id>`.
- **F11.** New Task 2 Step 2 (618–652) generates `cells/desktop/cua-requirements.txt` in a throwaway
  container of the pinned base (`docker run --entrypoint /bin/bash`, `apt-get install python3-venv`,
  `pip download --only-binary=:all: cua-driver==0.30.4`, one `name==version --hash=sha256:…` line
  per wheel from `pip hash`, `docker cp` out, `docker rm -fv`). The Dockerfile copies it and runs
  `pip install --no-cache-dir --require-hashes -r /opt/cua/requirements.txt` (709–716); the now
  unused `ARG CUA_DRIVER_VERSION` is gone. The build step checks it binds: zero the `cua-driver` hash
  with a portable `sed` into the file, build (expects pip's `THESE PACKAGES DO NOT MATCH THE HASHES`),
  restore, build from cache (757–771). Steps renumbered 3–6 (no cross-references to them existed).
  Files block 596, Interfaces 604–606, file map 146, Global Constraint 92–94.
- **F12.** `shot` outputs are package-relative `e2e/out/<name>.png` with a note that pnpm runs the
  script in `apps/web` (7192–7201, 8005–8006, 8646–8649).
- **F13.** `#current(id, entry)` (4671–4675): a loop goes on only while `#live` still holds the entry
  it set or read and the orchestrator isn't disposed. `#waitReady` (4608–4643) captures its entry,
  checks `#disposed` up front, and re-checks after the desktopd probe, the stream probe, the inspect
  and the sleep. `#watch` (4647–4669) checks after its sleep, after `#exitedContainer`, and after the
  backoff (identity of the restarting entry). `#startContainers` (4576–4606) now resolves `false` when
  superseded: it re-checks before starting the desktop and before writing ports, and only marks
  `failed` if still current; `create`, `start` and `#watch` call `#waitReady` only on `true`. New test
  "keeps a cell stopped when the stop lands during the restart backoff" (4153–4180) with a `sleep`
  option on `setup` (3926, 3940). The Part 3 obligation about two `#watch` loops after `start()` in a
  backoff is removed: the restart's post-backoff identity check now ends the old loop, and a
  superseded `#startContainers` no longer starts a second readiness loop. Interfaces 3424–3430,
  Decisions 9146–9148, `dispose()` comment 4438.
- **F14.** Task 10's `main.ts` block keeps `server.on("error")` with the port-in-use message
  (5776–5781).
- **F15.** `doctor.test.ts` uses a `freePort()` listen(0) probe in every `runDoctor` call (4911–4918).
- **F16 (mechanism changed).** A raw `http.request` path would not reach the guard either:
  `@hono/node-server` 2.1.3's `buildUrl` (`dist/index.mjs` 168–180) sends any path with a dot segment
  or a `%` through `new URL()`, which folds `../` and `%2e%2e/` before Hono routes. The tests use the
  scan's other fix, `%2f`-encoded separators, aimed at a real file outside the served directory:
  stream proxy 6127–6131 (`ld-proxy-outside.txt`), `static-ui` 7111–7114 (`ld-ui-outside.txt`).
- **F17.** `Stage.test.tsx` (8556–8583) renders `<Stage>` for a ready cell in jsdom and reads the
  notice. Review Focus 3 points at Task 13 (129–131), Review Focus 4 at `Stage.test.tsx` (132–135);
  Task 14 Files 8045–8046.
- **F18.** Task 14 Step 2: "5 tests pass (2 pump, 3 frame source)" (8321).
- **F19.** Task 5 states `function startDesktop(name: string, scale: 1 | 2): { port: number; desktopd: number }` (2293–2294).
- **F20.** `afterEach(cleanup)` in `App.test.tsx` with the reason (7039–7053); Task 13's note now
  credits it for closing the socket and fixes the jsdom URL (`ws://localhost:3000/...`, 7994–7997).
- **F21.** Line 41 (Part 1 is merged into `main`), Global Constraint 48–49, Task 1 Step 1 (205–212):
  no `git switch -c`; the step checks `git branch --show-current`.
- **F22.** SIGHUP check: `h="$(mktemp -d)/h"`, `(cd … && exec env LOCALDOT_PORT=4795 LOCALDOT_HOME="$h" node …) &`,
  then `ls -A "$h"` (2820–2828).
- **F23.** `toHaveText("Starting…", { timeout: 30_000 })` (8831).
- **F24.** `create()` reserves the keyd port in `#reservedKeydPorts` before its first await and frees
  it in `finally` (4390, 4474–4478, 4503, 4530). No test (none ruled).
- **F25 (deferred).** One Part 3 obligation line (9109–9112): request timeout plus background
  reconcile.
- **F26.** Files blocks: Task 3b `.gitignore` (1281), Task 11 `static-ui.ts` stub (5817–5818),
  Task 14 `scripts/check-hygiene.mjs` (8044), Task 15 `spec.test.ts` and `main.ts` (8667–8669). File
  map (146–174): `cua-requirements.txt`, `spikes/s8-hosted-client/package.json`,
  `apps/daemon/package.json`, `port.ts`, `apps/web/src/cells/types.ts`, `Mascot.tsx`,
  `e2e/daemon.ts`, `.github/workflows/ci.yml`, `docs/spikes/SUMMARY.md`, `scripts/check-hygiene.mjs`.
  Interfaces: Task 1 (195–203: `dockerExecAs`, `waitFor(label, pred, ms, everyMs = 1000)`, `rm -fv`,
  the blocking note), Task 11 `readStatic` (5824).
- **F27.** The claim now reads: tokens named after Tailwind 4's theme namespaces in a `:root` block
  that M4 moves into `@theme`, `--duration-*` being localDot's own: Global Constraint 88–90, Task 12
  Interfaces 6441–6443, `theme.css` intro 6862–6864, closing Interfaces 9132–9136, Decisions 9156–9158.
  Token names unchanged.
- **F28.** `hudFor` maps a `starting` cell whose `error` matches `RESTART_NOTE`
  (`/; restarting \(attempt \d+ of \d+\)$/`, the note the orchestrator already sets) to
  "Reconnecting…" with the note as caption and a Stop action (7327–7341). Stop, because the stream's
  own "Reconnecting…" states offer it and F13's "a user's Stop must win" needs a way to stop during a
  restart. New test (7303–7313); counts 3 → 4 (7366) and 15 → 16 (8000). Task 13 Interfaces
  7231–7235; closing Interfaces record the note's shape as a contract (9046–9048). Spec: line 217 now
  names `WhiteSur-Light-xhdpi`. The "A cell crashes" row (661) is unchanged: it already says the UI
  shows "Reconnecting…", which is what the ruling makes true.
- **F29.** Task 6a: intro 2577–2579, Files 2582–2583, Interfaces 2590, the two trivia (2810–2813:
  SUMMARY D18's quote gets back `'Decision'): C: Theatre"`; `DEFAULT_PORT` loses `export`, nothing
  imports it at HEAD), port tests in Step 4 (2817–2819), commit adds both files (2834). Decisions 9166.
- **F30.** `fileURLToPath`/`join(OUT, …)` for Task 3b's shots (1497, 1504, 1506–1508);
  `dirname` dropped from `e2e/daemon.ts` (8724); the extractor exits 1 if `rel="manifest"` survives
  (1585–1588); NOTICE.md names Selkies tag `2.0.0` (`addons/selkies-dashboard`, `selkies-web-core`),
  the `SELKIES_RELEASE` pinned by linuxserver's base Dockerfile (8081–8084); the redundant ignores are
  dropped in Task 3b (1508–1510), because Task 1 had already committed them; `useOptionalChain` gone
  (`#waitReady`/`#watch` guards use `live?.state`, `DesktopFrame` 8484), `noNonNullAssertion` gone
  (orchestrator Docker test 4823–4826). `noDescendingSpecificity` left, as ruled.
- **F31 (controller, during the pass).** Global Constraint (103–106) and Task 1 Interfaces (201–203).
  Checked per task: Task 1 had the case (keyd stand-in reached by `curl` through `dockerExec`); now a
  worker thread (473–478, 498–499, 525). Task 2: no host server (`--network none`). Task 3: the test
  is a client of the container (fetch, a ws client held open with `sleepSync`); nothing in-process is
  reached. Task 3b, Task 5 part 3, Task 6 (`DockerClient` is async), Task 9 (doctor's port probe is
  in-process but no container reaches it): none. Task 8 Docker test: the orchestrator runs in-process
  but only calls out; readiness is awaited through `subscribe`, never `waitFor`; the host check
  targets 4750, where the test runs nothing. Task 11 (unit, not Docker): fake Selkies, daemon and
  client are all in-process but every wait is a promise; no sync helper. Task 15 e2e: the daemon is a
  child process with inherited stdio (no pipe a blocked worker must drain), the browser is its own
  process, and the specs' `execFileSync` calls block only the Playwright worker, which serves nothing.
  No other change was needed.
- **Task 1 deviations.** (a) worker-thread listener as above. (b) `trap 'exit 0' TERM INT` in
  `relay.sh` (402–403), the new last test (562–570), "7 tests pass" (576), Interfaces line 196.
  Nothing in Task 8 assumed a 10 s gate stop (its unit tests use the fake; the Docker test has no
  timing on stop; the e2e's "Stopped" waits up to 60 s), so nothing else changed.

## Hand-derived values for added or changed tests

- Gate, "exits cleanly on docker stop": SIGTERM reaches PID 1 `sh`; the trap runs once the loop's
  `sleep 1` returns, so the gate exits 0 within ~1 s → `{{.State.ExitCode}}` = `0`, elapsed < 3000.
  Without the trap: SIGTERM ignored, SIGKILL after 10 s, 137. Count 6 → 7.
- Spec: `internalNetworkSpec("n")` matches `{Name: "n", Driver: "bridge", Internal: true,
  Options: {gateway_mode_ipv4: "isolated"}, Labels: {"localdot.cell": "1"}}`; `isolatedNetworkSpec("p")`
  equals the same without `Labels`; `cellNames("X", "localdot-test-").desktop` =
  `localdot-test-desktop-X`. Still 6 spec tests.
- Orchestrator, desktop restart: create's gate start takes ports 50000 (8081) and 50001 (8082). The
  desktop dies; note "desktop container exited with 137; restarting (attempt 1 of 2)" (backoff
  `[0, 0]`); restart: gate start → 304 (running, no new ports), desktop start → `starts` 2; ports read
  back 50000/50001 → `endpoints` equal `before`; ready entry has no `error`.
- Orchestrator, gate restart: gate dies ("gate container exited with 137"); gate start → `starts` 2,
  new ports 50002/50003; desktop start → 304; desktopd `http://127.0.0.1:50002` ≠ `…:50000`, stream
  `…:50003` ≠ `…:50001`; no `error`.
- Orchestrator, stop during backoff: backoff `[60_000]`, `sleep(60000)` returns a held promise. Note
  "… (attempt 1 of 1)"; `stop()` sets stopping, desktop stop → 304, gate stop → 204, stopped; the
  backoff resolves; `#current(restarting)` is false → the watch returns. After 50 ms: state
  `stopped`, last change `stopped`, desktop `starts` 1. This test also passes on the pre-F13 code,
  whose post-backoff `state !== "starting"` check already covered this case (run in scratch: 13/13
  either way); the new guards' other paths (stop or remove during the inspect, the probes or the
  restart's container start; stop-then-start during the backoff) are traced, not tested.
- Orchestrator totals: create 2 + lifecycle 5 + restarts 4 + reconcile 2 = 13; with spec 6, 19.
- Doctor: each test gets an OS-assigned free port, so `port-<n>` is ok and test 1's `report.ok` is
  true even with a daemon on 4750; the first `POST /networks/create` body is
  `isolatedNetworkSpec(probe)` → `Internal: true`, no `Labels`. Still 6.
- Proxy traversal: `${prefix}/..%2fld-proxy-outside.txt` survives fetch, `buildUrl` and Hono's
  `decodeURI` (`%2f` stays encoded), matches `/cells/:id/desktop/:ticket/*`, decodes to
  `/../ld-proxy-outside.txt`, resolves to `tmpdir()/ld-proxy-outside.txt` (exists) → outside the
  vendor dir → 404. Same for `/assets/..%2f..%2f…`. With the guard removed: 200 (run in scratch).
- `static-ui`: `/assets/..%2f..%2fld-ui-outside.txt` → `/assets/../../ld-ui-outside.txt` from `dist`
  → `tmpdir()/ld-ui-outside.txt` → 404 (200 without the guard, run in scratch). Still 2.
- Proxy 502: authorization `Basic d3Jvbmc=` → fake `verifyClient` false → 401 → upstream `error` +
  `close` before any viewer upgrade → `refuse(socket, "502 Bad Gateway")` → the viewer's error reads
  "Unexpected server response: 502". Relay test stream states: `connecting` (dial), `live` (upgrade),
  `stalled`, `live`, `none`; 1012 test ends `disconnected`. Still 5.
- `hudFor`: note "desktop container exited with 137; restarting (attempt 2 of 5)" matches
  `RESTART_NOTE` → `{label: "Reconnecting…", caption: note, action: "stop", live: false}`; busy →
  action `none`. A plain `starting` cell still reads "Starting…". hud 4; web after Task 13: 9 lib +
  3 App + 4 hud = 16.
- Pump: each read now resolves on a 1 ms timer, so the test's 20 ms timer fires; `stop()` cancels;
  no pull starts after cancel and `pulls` counts at pull start, so `pulls` stays equal. Ran in 41 ms.
- `Stage`: jsdom has no `MediaStreamTrackProcessor` → `frameTapSupport()` gives the reason → the
  alert's `textContent` is "This browser has no MediaStreamTrackProcessor. Open localDot in Google
  Chrome or another Chromium browser." Web after Task 14: 16 + 2 pump + 3 frame source + 1 = 22.

## Toolchain runs (scratch copy, outside the repo)

Scratch: `…/scratchpad/part2-fix/repo` = `git archive b778394` plus every code block of the edited
plan applied in task order, partial edits hand-applied (`assemble2.py`, which finds each block by
the line before its fence). Packages linked read-only from the localdot pnpm store (TypeScript
7.0.2, Biome 2.5.15, Vitest 5.0.3, vite 8.3.1, hono 4.13.12, @hono/node-server 2.1.3, ws 8.22.0,
@types/ws 8.18.2, zod 4.6.5, esbuild 0.28.2, tsx 4.23.15, sharp 0.35.5); React 19.3.0 and its types
from `jev-lab`; @testing-library/react 16.3.2 (copied), @testing-library/dom 10.4.1 and jsdom 29.0.1
from `bambu-garden`; @playwright/test 1.61.1 from `rebirth-roulette`. Nothing in the repo was
touched; no Docker was run.

- `tsc --noEmit -p` for `apps/daemon`, `cells/desktop/desktopd`, `packages/protocol`, `apps/web`
  (includes `App.test.tsx` and `Stage.test.tsx`), `apps/web/e2e` → all `exit 0`. The first run
  printed `stream-proxy.test.ts(54,22): error TS7031: Binding element 'req' implicitly has an 'any'
  type.` (the union-typed `verifyClient`); fixed by typing it `{ req: IncomingMessage }`.
- `biome format --write .` then `biome check .` with the repo's `biome.json` plus Task 12's
  `files.includes` → `Checked 147 files … Found 1 warning.` (`app.css` `noDescendingSpecificity`,
  left as ruled). An earlier `organizeImports` error on `main.ts` was my merge of Task 10's imports
  below `./event-log.ts`; the snippet itself is sorted, and the new Global Constraint note covers
  merging.
- Vitest: `vitest run apps/daemon cells packages` → 206 tests, 205 pass, 1 fails (below);
  `vitest run apps/web/src` (jsdom resolved from the scratch root through a module hook) → 22 pass.
  Old relay with the new proxy tests → 3 fail (timeouts), new relay → 5 pass. Guard removed → the 3
  traversal assertions fail (200 vs 404).
- Shell: `bash -n`/`sh -n`/`node --check` clean on the extractor, `relay.sh`, `host.mjs`, the pin
  step (and its inner script), the tamper block and the SIGHUP block; the pin loop and the tamper
  `sed` simulated on fake wheels with the host's `pip hash`. `host.mjs` against a Selkies-like
  upstream that answers only after the client's first message: `viewer got: echo:SETTINGS,{}`;
  upstream gone: `Unexpected server response: 502`. SIGHUP block (run in the scratch daemon dir):
  `exit 129`, home lists `cells daemon-token index.sqlite sessions`, no `daemon.lock`. Busy port:
  `port 4796 is already in use`, exit 1.

## Found while verifying, not applied (outside F1–F31)

- **Task 6b's `ulidTime` vector is wrong.** `expect(ulidTime("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(1_469_918_176_385)`
  pairs the ULID spec README's `ulid()` example with the timestamp of its other example. Decoding
  `01ARZ3NDEK` gives 1,469,922,850,259 (by hand and by the plan's `ulidTime` in scratch:
  "expected 1469922850259 to be 1469918176385"). Fix: `ulidTime("01ARYZ6S41TSV4RRFFQ69G5FAV")` is
  1,469,918,176,385. Task 6b's Step 4 fails until this changes.
