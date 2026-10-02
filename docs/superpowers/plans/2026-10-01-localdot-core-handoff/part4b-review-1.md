# Part 4b plan review 1 — keyd integration (M3)

Plan: `2026-10-01-localdot-core-part4b-keyd-integration.md` (10,784 lines, 16 tasks, P4b-R1…R27).
Line numbers below are the plan's (`L1234`). Read against:
- the spec (trust rules, key layer, safety and control, interface, setup, error handling, testing, M3, risks);
- research §3.10;
- Part 4a's plan, rulings and ledger, and its built tree (`feat/core-part4a` at `b441b98`);
- Part 2's built tree and ledger. `feat/core-part2` moved to `cb9370f` (the M1–M14 hardening round) at 21:02, during this review; the plan was verified against `365aab9`;
- Part 3's plan ("Interfaces Part 4 builds on", `part3-rulings.md`).

Nothing was edited but this file.

## 1. Spec coverage

| M3 requirement not in 4a (spec, 4a obligations, carries) | Task |
|---|---|
| Daemon ↔ keyd admin client on the 0600 socket; refuse a socket others can reach (trust rule 6, research §3.10) | 3 |
| React to a new keyd boot: reopen running cells | 4 (monitor), 9 (`rewireIfLost`), 11 (wiring) |
| Open each cell in keyd before its containers start, on Part 2's port; close it on stop and remove | 9 |
| The cell's proxy, token and CA; Chromium's proxy credentials (4a obligation) | 6, 7, 9 |
| CA in the system store and NSS, replaced at each start, gone when the file is | 7 |
| Surrogate variable names (4a obligation) | 2 (`surrogateEnvName`), 7, 9 |
| `desktopd` boot self-test; ready requires it; fails closed; the UI names the failing check | 8, 9 |
| Key form: sealed in the page; the daemon relays ciphertext only; records listed (trust rule 3) | 2, 4, 12 |
| `key.use` and `budget.exceeded` in the session; key use inline in the timeline (spec "Audit") | 11, 13 |
| `audit.ok` in the UI's health; "Key layer offline" (error handling) | 4, 12 |
| Stop: revoke, then pause or stop the cell's processes; fresh surrogates afterwards (P4a-R20, C2) | 10, 13 |
| Canary test (SC5, Testing/Security) | 15 |
| S4 `run.sh`/`chromium.sh` from a real cell; no internet, host, LAN or LM Studio but through keyd | 14 (and 8) |
| keyd listeners refuse requests without the token, including from another container | 14 |
| Surrogate misuse blocked and alerted | 3 (real keyd), 14 |
| Hairpin NAT: learn the public address and deny it (spec risk); special-purpose IPv6 (4a carry) | 1 |
| U+2028 / non-ASCII base URLs (4a carry) | 2, 12 |
| Orphan containers of an unreadable record (Part 2 carry) | 9 (too broad: I1) |
| CI for the keyd-backed suites | 16 |
| LaunchAgent, signed binary | M9 (P4b-R18) |
| `PUT …/task`, model prices and `maxOutputTokens`; the brain's base URLs | M4 (recorded under "Interfaces") |

**Gaps**
- **4a carry C3 has no disposition.** The cell should trust its CA for TLS server auth only (I5).
- **The boot self-test cannot detect a reachable bridge gateway.** Trust rule 1 names that case explicitly (I4).
- **"keyd down → the task pauses" (spec "Error handling")** is neither built nor recorded as M4's (M11).
- **The router's own IPv6 addresses stay outside the deny set.** The spec's risk line says "public address(es)", but Task 1 learns IPv4 only (I8).
- **Stop has no route for a cell without a live session.** "Stop computer" covers this, but the plan never says so (M11).

## 2. Decision verdicts

- **R1, the forwarder: ACCEPT.** One credential-free URL works for every runtime, and Chromium never sees a 407. It fails closed if the forwarder dies. The token is readable in the cell either way.
- **R2, `NO_PROXY` for loopback only: ACCEPT.** Loopback never leaves the cell, so the exemption grants nothing a process there doesn't already have. It beats 4a's "empty".
- **R6, Stop = abort → revoke → settle (≤ 4 s) → pause the desktop only: CHANGE.** Pausing only the desktop is right: the gate holds nothing. The smallest change:
  - When the pause fails, close the cell in keyd.
  - `resume` revokes before it mints.
  - R6's cost line should say that surrogate-free web egress stays open for the whole settle window, because the listener stays.

  See I2.
- **R7, a keyd restart restarts running desktops: CHANGE.** Keep the restart, but skip frozen cells (`if (live?.paused) return;` in `#rewireIfLost`). Resume already rewires them. See C1.
- **R14, the sweep keeps volumes: CHANGE.** Act only on this home's skipped records (`inventory().skipped`, built in `cb9370f`). Close them in keyd and stop their containers rather than removing them. Keep Part 2's `SkippedCellsError`. See I1.
- **R15, the store owns the keyd port range: ACCEPT, once R14 is scoped.** A range change then blocks creation and cuts those cells' listeners until the range is restored, and nothing is removed. Update its cost line, which today says their containers are swept.
- **R16, STUN to Cloudflare and Google, failing open offline: CHANGE.**
  - The privacy-preserving source is the router itself: NAT-PMP's external-address request (RFC 6886, UDP 5351 to the default gateway; PCP likewise). It needs no third party and no new dependency. Keep STUN as the fallback, with `-stun off` documented.
  - Failing open is acceptable, since failing closed would cut all egress, but only if it is visible and retried quickly. Retry every 30 s while the address is unknown, and report `known`/`unknown` in `/v1/status` and the key-layer health.
  - See I8.
- **R17, IPv6 global unicast only, with 4a's integrity-test edges moved: ACCEPT.** The insertion points and the four replaced pass-list lines match the built `guard.go` and `guard_integrity_test.go` exactly. The eight moved edges, the new edges and the NAT64 exemption are correct.
- **R18, LaunchAgent deferred to M9: ACCEPT.** The spec puts install in M9, and M3 lists only keyd's functions.

## 3. Findings

### Critical

**C1. A keyd restart undoes Stop's freeze: the frozen computer reboots, unfrozen, with fresh surrogates.**

Where: L6081–6095 (`#rewireIfLost`), L6102–6116 (the keyd block in `#startContainers`), L7234–7241 (the monitor calls `rewireIfLost` for every cell), R7 (L10614–10618), and L10562 ("a keyd started later than the daemon is noticed within 2 s, and the cells it lost are rewired").

How it happens:
- A frozen cell's entry is `{ state: "ready", paused: true }` (L6783, L6759), so it passes the guard at L6088.
- After any keyd restart, or after keyd is simply started following a Stop, `isWired` is false.
- `#startContainers` first sets a fresh `starting` entry (the built orchestrator), which drops `paused`.
- A paused container reports `State.Running: true`, so the desktop is stopped, rewired (new token, new CA, fresh surrogates for every web key) and started again. Docker Engine stops a paused container: its kill path resumes the container after signalling it.
- The fake answers 409 there instead (L5565–5568), so no unit test can show the reboot. The only test that combines a freeze with a keyd restart goes through Resume (L6457–6465). Under the fake the cell ends `failed` with the flag gone. Either way the freeze is lost.

Impact: the clean boot runs whatever the agent planted in the persistent home (`/config` autostart entries, shell rc files), with working surrogates and web egress, without the user resuming. A user who presses Stop and then stops and restarts keyd hits this exactly.

Fix: make `if (live?.paused) return;` the first check in `#rewireIfLost`. Add a test in `kill-switch.test.ts`: freeze, `keyd.restart()`, `cells.rewireIfLost(id)`, then expect `desktop().starts` unchanged and `cells.get(id).paused === true`.

### Important

**I1. The orphan sweep deletes other daemons' computers, the user's real ones included.**

Where: L6069, L6142–6177, P4b-R14 (L10652–10656), Review Focus 9 (L184–186), and R15's cost (L10660–10661).

Evidence:
- `known` holds only this store's readable records (L6150).
- Every container labelled `localdot.cell=<ULID>` with an unknown id and a name in this prefix is removed, with its networks (L6152–6171).
- That covers far more than an unreadable `cell.json`: every daemon on another `LOCALDOT_HOME` with the same prefix qualifies.
- The e2e harness runs `main.ts` on a temp home with the default `localdot-` prefix (Part 2 plan L8719–8790). `main.ts` has no prefix setting.

Impact:
- Every e2e run deletes the containers and networks of the user's real running computers on the same Docker (homes kept). That includes Task 12's `keys.spec.ts`, which is not gated on `LOCALDOT_DOCKER_TESTS`, and Task 16's full run. This breaks Part 2's F10 ruling: "tests must never touch or leak the user's real cells/volumes".
- A real daemon restarted during an e2e run deletes the e2e's cells.
- An R15 range change sweeps every cell of the home.

Meanwhile `cb9370f` already closed the port-reuse hazard: `CellStore.inventory()` reports skipped ids, and `create()` throws `SkippedCellsError` while any exist.

Fix: drive the sweep from `this.#store.inventory().skipped` only, that is, ids with a folder in this home. For those, close the cell in keyd and stop (not remove) their containers by exact name. Never touch an id that has no folder in this home. Test: two orchestrators on two homes with one prefix; reconciling one leaves the other's containers running.

**I2. Stop fails open when the freeze fails, and Resume can leave the old surrogates valid.**

Where: L6682–6687, L6772–6784, L6692–6700, L5979–5994.

Evidence:
- `pause` throws unless the cell is `ready` (L6775–6777).
- A session stays live while the watch loop restarts a crashed gate or desktop (`starting`). A Docker call can also fail or time out (Part 3's 30 s client timeout).
- Stop then returns `paused: false` and does nothing more. keyd's listener stays open (P4a-R20), so every process keeps its surrogate-free web egress. That is the outcome P4a-R20 says Stop must prevent.
- Separately: if the revoke failed (keyd timed out) but the pause held, `resume` only mints new surrogates (`refresh`, L5979–5994). The surrogates the agent's processes hold stay valid after Resume.

Fix:
- In `stopSession`, when `paused` is false, call `keyd.close(cellId)` (add `close` to `KillSwitchDeps.keyd`). The listener goes, so nothing in the cell has egress. Resume already restarts a cell that keyd lost.
- In `resume`, call `await keyd.revoke(cellId)` before `refresh`. It is idempotent.
- Tests: when the pause is refused, `keyd.cells.has(id)` is false; when the revoke is refused, Resume leaves no first-generation surrogate.

**I3. The readiness gate accepts any non-empty subset of the checks.**

Where: L1636–1638. The fixtures at L4955–4962 (two checks) and L5640–5644 (one check) pin such reports as ready.

Evidence: a desktopd that leaves checks out passes, whether from an image built before a check existed or from a bundling or wiring bug. Success criterion 5 requires "a self-test at every cell boot that fails closed". The daemon rightly recomputes `ok`, but it still trusts desktopd's choice of which checks to run.

Fix:
- Export `SELFTEST_CHECK_IDS` (the ten ids) from `selftest.ts`.
- `selfTestPassed` requires each id exactly once, with `ok`.
- Update the two fixtures, and add a test in which a report missing `dns` is not ready.

**I4. The self-test cannot see a reachable bridge gateway, the one exposure isolated gateway mode exists to remove.**

Where: L4628–4638, L5139–5149, L5158–5176.

Evidence:
- Trust rule 1 says: "no reachable gateway address (with plain `--internal`, Docker Desktop VM listeners answer on the bridge gateway)".
- On an engine that ignores `gateway_mode_ipv4=isolated`, every check here still passes:
  - an internal network has no default route anyway;
  - 1.1.1.1 and 192.168.65.254 are not routed;
  - external DNS is refused;
  - `noDirect` passes any answer but `connected`.
- The doctor checks the mode only when someone runs it (Part 2 Task 9), and nothing checks it per boot.
- Part 2's Docker test probes the gateway slot with curl, but curl's exit 7 is the same for "refused" and "unreachable", so it can't tell the two apart either.

Fix:
- Add an `isolation` check, `gateway`. Take the internal subnet from `/proc/net/route`'s non-default entry and TCP-connect to its first host address on two ports. `connected` or `ECONNREFUSED` means the address answers, so the check fails. `EHOSTUNREACH` or `timeout` passes.
- Outside the cell, where it can't be faked: `#subnet()` refuses a network whose IPAM reports a `Gateway`.

**I5. Part 4a's C3 carry (trust the cell CA for TLS server auth only) has no disposition.**

Where: L4503–4527 and L10682–10687 (R20). The carry is in the 4a ledger: "CARRY → Part 4b: C3".

Evidence:
- NSS gets `C,,`, which is TLS only.
- The system copy (`/usr/local/share/ca-certificates/localdot-cell.crt` → `ca-certificates.crt`, also `SSL_CERT_FILE`) is a plain anchor, which OpenSSL accepts for every purpose.
- OpenSSL's code-signing purpose ignores the CA's serverAuth-only EKU, and the DNS/IP name constraints don't bind a leaf that carries no such names.
- The risk is low, since the key exists only in keyd's memory, but the carry asks for a decision.

Fix: either record it as a decision with the residual, or install the system copy as an OpenSSL `TRUSTED CERTIFICATE` with `-addtrust serverAuth` and check that curl, Python and apt still load the bundle. Pin it with `openssl verify -purpose codesign` refusing a leaf the cell CA signed, while `-purpose sslserver` accepts one.

**I6. Task 11 drops `findDockerSocket()` from the daemon.**

Where: L7215, `const docker = new DockerClient();`.

Evidence: Part 2's `main.ts` builds `new DockerClient(findDockerSocket().path)`, per Part 2's carry ("build the daemon's DockerClient from findDockerSocket() (context-aware), not `new DockerClient()`"). The plan's replacement loses that. On a Mac whose `/var/run/docker.sock` is off, or with another Docker context, the daemon can't reach Docker.

Fix: `const docker = new DockerClient(findDockerSocket().path);`.

**I7. Tasks 8–10 were written against `365aab9`; the built `cb9370f` conflicts with them.**

- **Task 8 (L5407–5453)** replaces `probeDesktopd` and drops `cb9370f`'s `readCapped` (64 KiB) and `isHealth` (a boolean `ok`), Part 2's M11 ruling. It also reads `/selftest` with an uncapped `res.json()`.
- **Task 9's `create` snippet (L6070–6076)** allocates from `this.#store.list()`. Applied as written, it drops `inventory()` and `SkippedCellsError`. `#rewireIfLost` (L6086) and `#removeOrphans` read the store instead of the new `#record` cache.
- **Task 9's orchestrator Docker test edit is incomplete (L6220–6227).** It adds `--noproxy '*'` to two probes only. `cb9370f` added probes that call `http://<gateway slot | 192.168.65.254 | public>:4750/` and expect exit 7. With keydEnv's `http_proxy`, those requests go to the forwarder; keyd answers 403 `ip-literal`, curl exits 0, and the test fails as written.
- **Unclamped detail (L6129, L6134).** desktopd's check details (up to 500 characters each, up to 32 checks) go into the cell's error unclamped; `cb9370f` clamps such text to 200 characters (`MAX_DETAIL`).

Fix: rebase those edits on `cb9370f`:
- keep `readCapped` and `isHealth`, and read `/selftest` through the same capped reader;
- keep `inventory()` and `SkippedCellsError`, and use them for I1;
- add `--noproxy '*'` to every direct probe;
- `clamp` the new texts;
- re-count the expected tests.

**I8. R16: hairpin protection asks two third parties by default, every 5 minutes, and fails open silently.**

Where: L581–582, L643–657, L832–836, L846–851, R16 (L10662–10668).

Evidence:
- Every install sends a STUN beacon to Cloudflare and Google at start and every 5 minutes, for as long as keyd runs.
- Offline at start, or with UDP 3478/19302 blocked, the address stays unknown for up to 5 minutes after the network returns. Only a stderr line says so.
- Cells can open before the first answer arrives, but that window is small.
- Learning is IPv4 only: the router's own IPv6 addresses (its WAN address, other delegated /64s) stay reachable.

Fix: as in the R16 verdict:
- NAT-PMP/PCP to the default gateway first, STUN as the fallback;
- retry every 30 s while the address is unknown, and expose the state;
- record the IPv6 residual.

### Minor

- **M1. The canary scan can pass with nothing read.**
  - `total += end - start` (L10137–10138) counts mapped bytes before any read, and `scanned` counts processes whose files opened.
  - The positive controls live in another `it` (L10294–10311), so `-t "finds the canary"` alone passes on a scanner that reads no memory.
  - Fix: count bytes actually read; scan the marker with the canary in the canary test and require its hits; add one encoded control (the marker's base64 in a file).
- **M2. `surrogateEnvName` maps `a-b` and `a_b` to one name** (L1459–1461), so one key's stand-in shadows the other's in `surrogates.sh`. Fix: refuse a key whose environment name collides with an existing one.
- **M3. UI against apple-design.**
  - There is no pointer-down feedback (`:active`) on the new buttons: Keys, Save, Remove/Delete, the kind toggle, × and Resume. The Global Constraints require it (L104–107).
  - The `aria-modal` sheet (L8506–8513) doesn't keep Tab inside it.
  - Fine as written: colours are tokens (all defined in Part 2's theme), there is no xenon or purple, and reduced motion and contrast are handled.
- **M4. Chrome may offer to save the API key to the user's synced password manager.** It ignores `autocomplete="off"` on `type="password"` (L8378–8387) and can offer this after Save. Fix: use a text input with `-webkit-text-security: disc`, or verify in Chrome that no save bubble appears.
- **M5. Task 14's runtimes test is misnamed.** "Node's fetch, Python, git and apt through sudo" (L10000–10018) runs no git command and no apt fetch, only `apt-config dump`. Add `git ls-remote` and a real `sudo apt-get update`, or rename the test.
- **M6. Leaks.** `keydBinary()` (L2581–2589) and the e2e `startKeyd` (L7286–7287) never remove their temp build folders. The e2e keyd has no kill on process exit (unlike L2633–2635).
- **M7. Task 13's stage-model test omits `session.start`'s required `os`** (L9285). Write `os: "linux"` instead of the note to adjust.
- **M8. A gate restart while frozen loses the freeze flag.** The watch loop restarts the gate through `#startContainers`, which drops `paused`. Docker then refuses to start the paused desktop, or readiness times out on the frozen desktopd. Either way the cell ends `failed` and the HUD loses Resume.
- **M9. Resume with keyd offline returns a bare 500.** It unpauses first, then throws from `isWired` (L6695–6699), and the route has no catch (L6729), so the answer is 500 with the cell already thawed. Check keyd first, or map the error to 503.
- **M10. Task 12 is too big for one implementer.** It is about 1,710 plan lines: 7 sources, CSS, 3 suites, an e2e spec and a screenshot review. Split the key logic (`binding`, `keys-api`, `useKeys`) from the sheet UI.
- **M11. Add three scope notes to "Not in Part 4b".**
  - "keyd down → the task pauses" belongs to M4.
  - Stop has no route for a cell without a live session; "Stop computer" covers it.
  - The IPv6 hairpin residual.
- **M12. `audit-rotated` (`b441b98`) is not surfaced.** The health shows only `audit.ok`. Leave it for M9's doctor, but note it.
- **M13. Task 6, Step 4's text is wrong.** It says the last test "spawns the bundled entry"; it spawns `forwarder-main.ts` through tsx (L3880–3882).
- **M14. `refreshRunningCells` skips `starting` cells** (L7190), so a key changed while a computer boots leaves that computer a dead stand-in until its next start.

### Checked and sound

- **The daemon never holds a plaintext key.**
  - The routes' strict schema refuses `value` and any extra field; Task 4 tests this, and the Playwright spec checks the real POST bodies.
  - keyd rebuilds the AAD from the relayed fields, so the daemon cannot change the binding without getting `bad-seal`.
  - keyd's 400 texts carry no value: the built `vault.ValidValue` and 4a's `ValidValueFor` were read.
- **No secret reaches a cell** other than through 4a's recorded scrubber and passthrough residuals:
  - the container's environment holds no token, CA or surrogate;
  - the files hold surrogates and public material only;
  - the canary never transits the gate or the Docker VM, because keyd dials upstream from macOS.
- **The admin socket.** It is 0600 inside a 0700 folder, and the daemon checks owner and mode before every request. Only the same user, or root, can connect; per P4a-R25 and R13 that is the Keychain's exposure too.
- **Bypass paths are closed.** A cell has:
  - no route, no DNS and no IPv6 (`EnableIPv6: false` in `cb9370f`);
  - no `host.docker.internal`;
  - no path to another cell's port: its gate relays to one fixed port, and another container gets 407 without that cell's token.
- **Docker test hygiene.** Commands have no `--`, probes assert their exit status, no server runs on a test's own thread, and test objects are named `localdot-test-*`.

## 4. Consistency with built code

| Assumption in 4b | Built code or ruling | Status |
|---|---|---|
| Audit and `key.use` redact surrogates as `[surrogate:<ID>]` (R27; L6841, L9160, L9983) | 4a `bfc33b0` writes `[surrogate:<ID>]`. 4a's plan builds `key.use` "from the line as written" (4a L5619). 4a's plan text still says `surrogate:<id>` (ledger carry). | Consistent |
| Task 1's anchors in `guard.go` and `guard_integrity_test.go` | Built `guard.go` (zero address refused, TCP/UDP only) and its pass-list lines match L502–507 exactly | Consistent |
| Seal v1: AAD JSON, `[]` for absent lists, U+2028 refused | Built `seal.go` uses `SetEscapeHTML(false)` and `list(nil) = []`, and its comment names U+2028/U+2029 | Consistent |
| `SURROGATE_PATTERN` | Built `surrogate.go`: tag 2–12, body 22, checksum 6 | Consistent |
| CA excludes bound hosts' subdomains (Task 14's `www.postman-echo.com` passthrough) | 4a `21da3b7` | Consistent |
| `endpoints()` returns undefined unless ready | `cb9370f`. 4b doesn't call it; a frozen cell stays `ready`, and `withReadyCell` answers 409 for it | Consistent |
| Cell store validation | `cb9370f` adds `inventory()`, `SkippedCellsError`, names ending in `-<id>` and dotted-quad addresses. Task 9's store parameter fits, but its `create` and sweep ignore `inventory` | Conflict (I1, I7) |
| `probeDesktopd` | `cb9370f` adds a 64 KiB cap and a boolean `ok` (M11); Task 8 replaces the function | Conflict (I7) |
| Orchestrator Docker test | `cb9370f`'s raw-IP probes need `--noproxy '*'` | Conflict (I7) |
| `MAX_DETAIL` clamp | `cb9370f`; 4b's new detail texts are unclamped | Conflict (I7) |
| The daemon's `DockerClient` | Built `main.ts` uses `findDockerSocket().path` (Part 2 carry); Task 11 uses `new DockerClient()` | Conflict (I6) |
| desktopd's not-ready semantics: `/healthz` answers 200 `{ok:false}` | Unchanged; `/selftest` is asked only once `/healthz` is ok (P3-C16 F1) | Consistent |
| The fake Docker | `cb9370f` adds `failRequests`, and models 409 and 403. Task 5's partial handler snippet must keep them | Adapt |
| Part 3's `LiveSessions`, stop route and `withReadyCell` (Part 3 L7517–7597, L3908–3928) | 4b's replacement keeps the API | Consistent |
| `clipText` (Part 3 L4801–4805) turns control characters into spaces | The router test expects that | Consistent |
| Part 3's interface puts the proxy token and CA path in `desktopEnv` | 4b moves them into files on purpose (R3). Part 3's `startDesktopContainer` doesn't use `desktopEnv` | Deliberate deviation, fine |
| keyd's admin API, ready line, `Opened`, `CellInfo` and the cell-open audit line carrying `port` | 4a plan "Interfaces" and the manager's `admin(cellID, port, …)` (4a L12660) | Consistent |
| Events hub | `b441b98` sends the drop notice ahead of the next event; `KeydEvent` parses it | Consistent |
| `audit-rotated` | `b441b98` adds it; it is not surfaced | Minor (M12) |

## 5. Verdict

**Fixes needed.** C1 must be fixed: one guard and one test. I1–I8 should be fixed before execution: Tasks 8–11 rebased on `cb9370f`, the sweep scoped, Stop made fail-closed, the self-test made complete and given the gateway check, and the C3 and STUN dispositions recorded.
