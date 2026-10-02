# Part 4b plan review 2 — fix pass 1 (keyd integration, M3)

Plan: `2026-10-01-localdot-core-part4b-keyd-integration.md` (12,766 lines). Line numbers are the
revised plan's (`L1234`); `v1 L…` is `part4b-plan-v1.md`. Read against:
- `part4b-fix1.diff` (all of it), `part4b-review-1.md`, `part4b-rulings.md` (P4b-C1 to C3) and
  the revision log (as claims only);
- Part 4a as built, `feat/core-part4a` at `6bda612` (Task 9 committed since the brief), read with
  `git show`;
- Part 2 as built, `feat/core-part2` at `354b699` (Task 13 `b97bc42`, the vendored client, a
  stream-proxy fix), plus a read-only look at Task 14's uncommitted CSP in `static-ui.ts`;
- Part 3's plan (revision 6) for the interfaces 4b edits; the Part 2 and 4a plans where 4b builds
  on unbuilt code.

Nothing was edited but this file. No network call, no Docker.

## 1. Review-1 findings

"Fails on v1" means the pinning test was checked against v1's code by reading it.

| # | Verdict | Where | Pinning test, and does it fail on v1? |
|---|---|---|---|
| C1 | ADDRESSED | `#rewireIfLost` returns first for a paused cell (L8369–8377); the reconcile keeps a paused desktop frozen and never probes or rewires it (L8319–8328); the fake now stops a paused container and refuses to start one, as Docker does (L4439–4453) | kill-switch "keeps a frozen computer frozen when keyd restarts" (L7971). Fails on v1: v1's `#rewireIfLost` (v1 L6086–6095) has no paused check, so the desktop is stopped, rewired and started (`starts` 2, `paused` gone). Also fake-docker "pauses as Docker does" (L4255). |
| I1 | ADDRESSED | `reconcile()` reads `inventory()` once and `#stopSkipped` touches only this home's skipped folders, by exact name, stopping and removing nothing (L7396–7406, L7561–7574); the label sweep and the fake's `/containers/json` are gone | "stops the containers of a cell whose record can't be read…" (L7022) and "never touches a cell of another home…" (L7060). Both fail on v1: `#removeOrphans` (v1 L6142–6177) deletes the containers and networks of every labelled id outside the store (containers carry `localdot.cell=<id>` in Part 2 as built). |
| I2 | ADDRESSED as ruled; **incomplete, see new I-1** | a failed pause closes the cell in keyd (L8236–8240, `StopOutcome.closed`); Resume revokes before it thaws or mints (L8250–8256) | "closes the cell in keyd when the desktop cannot be frozen…" (L7879) and "revokes again before it mints…" (L7926). Both fail on v1 (v1 L6658–6700: no close, no revoke in `resume`). |
| I3 | ADDRESSED | `SELFTEST_CHECKS` and `selfTestPassed` require each of the eleven ids exactly once, all ok (L2224–2247); `#waitReady` names a missing check (L7546–7553); readiness keeps Part 2's capped reader (L6499–6545) | protocol "fails a report that leaves a check out…" (L1791), readiness "…leaves a check out" (L6002), orchestrator "names a check the self-test left out…" (L7117). All fail on v1 (`checks.length > 0 && every ok`, v1 L1636–1638; no `missing` text). |
| I4 | ADDRESSED | desktopd `gateway` check on the network's first host address, ports 53 and 80 (L6114, L6218–6255); `#subnet(…, { isolated: true })` refuses an internal network whose IPAM has a gateway, and the create is undone (L7429, L7593–7611), the same test Part 2's doctor uses (`gatewayVerdict`) | desktopd "fails when the network's gateway address answers, even with a refusal" (L5762) and the new line in "every way out" (L5751); orchestrator "refuses an internal network that has a gateway address…" (L7087). All fail on v1 (no such check or refusal). |
| I5 | ADDRESSED | the oneshot installs the system copy with `openssl x509 -addtrust serverAuth` (L5481); `ca-system` passes only on the CA's DER plus exactly `300c300a06082b06010505070301`, and fails on any plain copy (L6297–6313); NSS stays `C,,`; Docker test counts anchors and runs `openssl verify -purpose codesign`, curl and Python (L5276, L5318, L5381) | desktopd "fails unless the system store trusts the cell's CA for TLS server auth only" (L5831) fails on v1, which passes a plain anchor. Residual recorded (L12458, R30) but understated: Minor 6. |
| I6 | ADDRESSED | `new DockerClient(findDockerSocket().path)` (L8865), matching Part 2's built `main.ts` | none possible, as review 1 said |
| I7 | ADDRESSED for the daemon; **not for Part 2's web shell, built after the pass: new I-2** | capped `/selftest` read (L6499–6545); `inventory()` and `SkippedCellsError` kept (L7408–7427); `--noproxy '*'` on every direct probe (L7640–7652); `clamp` on the new texts (L7542, L7553, L7607); counts re-stated. `orchestrator.ts`, `store.ts`, `readiness.ts`, `docker.ts`, `types.ts`, `main.ts`, `app.ts` and `api.ts` are unchanged on Part 2 from `1ba1659` to `354b699`. | — |
| I8 | ADDRESSED | via P4b-C2, §2 | §2 |
| M1 | ADDRESSED | bytes counted as read (L11988), a process counted only once memory was read (L11991); the canary run scans for the marker too and needs its raw-file, base64-file, environ and memory hits (L12065–12072, L12163–12168) | (Minor 9: base64 alignment) |
| M2 | ADDRESSED | `surrogateEnvClash` (L2040), routes 409 `name-taken` before any PUT (L3999) | routes "refuse a name whose variable…" (L3611) |
| M3 | ADDRESSED | Part 2's `button:active` exists as built (`theme.css`, with the reduced-motion opacity); nothing in 4b sets a transition or transform on a button; focus trap (L10347) | KeysSheet "keeps Tab inside the open sheet" (L9927) |
| M4 | ADDRESSED | text field drawn as dots (L10155, CSS `-webkit-text-security`), test asserts `type: "text"`. A browser without `-webkit-text-security` shows the key as typed (Chrome and Safari draw dots); `autocomplete="off"` also keeps it out of Chrome's form history. | — |
| M5 | ADDRESSED | renamed (L11831, table L11496) | — |
| M6 | ADDRESSED | Vitest global setup builds once and removes the folder (L3300–3330, L3380, L3389); `keydBinary` and the e2e build folder go on exit (L3212, L8937); e2e keyd killed on exit (L8952) | — |
| M7 | ADDRESSED | `os: "linux"` (L11117) | — |
| M8 | ADDRESSED | frozen gate restart keeps the desktop frozen; a frozen desktop that dies fails the cell (L8378–8433) | L7981, L7994 (both fail on v1). Edge cases: Minors 1 and 2. |
| M9 | ADDRESSED | Resume revokes first, so it throws before any thaw while keyd is offline; route 503 (L8278–8295) | L7938; routes L8106 |
| M10 | ADDRESSED | Tasks 12a (L9028) and 12b (L9724) | — |
| M11 | ADDRESSED | three notes (L12448–12456) | — |
| M12 | ADDRESSED | noted (L3452, L12387, L12464) | — |
| M13 | ADDRESSED | L5060 | — |
| M14 | ADDRESSED | `starting` cells refreshed (L8838) | L8683. Race: Minor 3. |

## 2. P4b-C2 (public-address discovery)

**Conforms.**
- **NAT-PMP first.** `Learn` asks the default gateway (`route -n get default`, `/proc/net/route`)
  over UDP 5351 on a connected socket, resending at 250 ms doubling to 3 s (L873–910, L1087–1205).
  Private or shared answers count as "behind another NAT".
- **One STUN provider, behind `-stun off`.** `DefaultSTUN = "stun.cloudflare.com:3478"` (L788),
  asked only when the router gives no public answer; `-stun off` and `-natpmp off` (L1266–1282).
  Tests, the harnesses and the e2e keyd pass both `off`; no Go test calls `DefaultGateway` or a
  real STUN server.
- **Retry while unknown.** `Keep` re-asks every 30 s while unknown, every 5 min once known
  (L912–930, L1260); pinned by `TestKeepAsksAgainSoonWhileTheAddressIsUnknown` (L558).
- **Shown everywhere.** `/v1/status.hairpin` (L1233–1247); the daemon reads a missing or unknown
  state as `unknown`, never `active` (L1949–1956, L3895); `doctor`'s `hairpin-guard` fails on
  `unknown` (with keyd's reason) and `off` (L4074–4133); the Keys sheet says it (L10318–10344);
  the top bar's dot goes hollow (`guard`, L9644, L10661). Egress is not cut while unknown, as ruled.
- **"Never send PCP MAP" is sound.** PCP has no read-only external-address query: the address
  only comes back in a MAP (or PEER) response, and a MAP creates or refreshes a mapping, an inbound
  hole toward the Mac, which a security daemon must not open as a side effect. A lifetime-0 MAP is
  a delete whose answer for a mapping that does not exist carries no guaranteed address, and
  ANNOUNCE carries none. PCP servers that keep NAT-PMP (RFC 6887 App. A) still answer version 0;
  every other reply (version 2, result code 1, silence) falls back to STUN or reports
  unknown/off, and the parser handles each (L1139–1154). An option for M9, not a defect:
  UPnP-IGD's `GetExternalIPAddress` is read-only and more common than NAT-PMP on home routers.
- Notes: Minors 4, 5 and 8.

## 3. The controller's orchestrator fixes

All three are applied and pinned, and each test fails on Part 2 as built:
1. **Cached ports.** Allocation counts the on-disk records, every cached record and in-flight
   reservations (L7420–7427). Pinned by "counts a running cell whose folder was deleted by hand…"
   (L7132).
2. **`SkippedCellsError` names the folder and the containers** (L7380–7395, L7408–7416), via
   `store.folder(id)`; Part 2's `api.test.ts` still finds the id. Pinned by L7142. Wording:
   Minor 7.
3. **`#remove` marks the cell `stopping` before its first await** (L7477–7478). Pinned by "emits
   no failure while a remove runs…" (L7158); Part 2's "lets a remove that lands while readiness
   awaits its probe win" moves to `["starting", "starting", "stopping", "removed"]` (L7195), which
   matches that test as built.

## 4. N1–N4 and the decisions

- **N1 (a resumed cell is watched again): sound.** `#pause` and `#unpause` each detach a fresh
  `#watch`; the previous loop exits at its next `#current` check, so only one loop runs (L8338–8367).
- **N2 (the reconcile asks keyd): sound and needed.** Part 3's Task 12 makes the reconcile
  background (`void orchestrator.reconcile()`), so the monitor's first "came up" can reach a cell
  with no state. The paused branch precedes it, so a frozen cell is never rewired; an offline keyd
  reads as wired (readiness then times out), as before. It does widen new I-1: a daemon restart now
  rewires a computer whose freeze failed.
- **N3: sound.** `minmax(0, 1fr)` and `min-width: 0`.
- **N4: sound.** Part 3 adds `DockerRequest.timeoutMs`; Part 2's client sends through `#send`.
- **R28: sound.** The daemon owns the list; an image without a check never gets ready.
- **R29: sound.** The IPAM refusal mirrors Part 2's doctor `gatewayVerdict` (unset gateway is
  absent, `""` or `invalid IP`), which S3 verified on Engine 29.2, so it does not refuse a good
  engine. In the cell, an unassigned `.1` times out on ARP inside the 2 s bound and passes.
- **R30: sound for OpenSSL, cost understated** (Minor 6).
- **R31: sound.** Two concurrent first saves of `a-b` and `a_b` can both pass the check; not worth
  more than a note.
- **Changed decisions:** R7 and R14 are sound; R15's new cost line matches `inventory()` (an
  out-of-range record is skipped, so its cell is stopped and closed); R16 is P4b-C2; R6 is sound
  except for new I-1.

## 5. New findings

### Critical

None.

### Important

**I-1. Stop's fall-back (a failed freeze closes the cell in keyd) does not hold: the first restart,
rewire or reconcile reopens the cell and boots the computer with fresh surrogates.**

Where: L8236–8240 (the close), L8410–8433 (the watch restart), L7440–7453 and L7459 (`#rewireIfLost`
and N2), L12461 and R6's cost line (L12522).
- After `keyd.close`, the cell stays `ready`, or stays `starting` when the pause was refused
  because a crash restart was in progress. That second case is the one review 1 named for I2.
- Stop during a gate or desktop crash's restart backoff: `#pause` throws `not ready`, keyd closes
  the cell, and then the watch's queued restart runs, because nothing replaced its `restarting`
  entry. In `#startContainers`, `isWired` is now false, so the desktop is stopped, `wire()` reopens
  the cell with new surrogates for every web key, the desktop boots and readiness passes. The
  computer is back, unfrozen, with working stand-ins and egress, seconds after Stop reported
  `closed: true`.
- Later, any of these does the same:
  - a keyd restart (the monitor calls `rewireIfLost`; L12461 accepts this one);
  - a daemon restart (the reconcile's N2 call, not recorded);
  - a gate crash (the watch restart, not recorded).
- This is C1's harm ("boot whatever the agent left in its home, unfrozen, with working
  surrogates"), for the computers whose freeze failed. The cell also keeps showing `ready`/`Live`
  in the HUD, so the user cannot see that it was not frozen.

Fix: when the pause fails, close in keyd at once (unqueued, as now), then run Stop computer
(`cells.stop(id)`). It is queued, closes keyd again and stops both containers, so a restart queued
after it finds its entry superseded and skips. "Stopped" is durable across keyd, daemon and gate
restarts, and the HUD shows it. Add `stopped` to `StopOutcome`, update R6, L12461, the README and
M5's note (L12391–12395). Pin it with two tests:
- the gate dies with a real backoff (for example `restartBackoffMs: [300]` and a real `sleep`) and
  Stop lands during it: afterwards both containers are stopped, `keyd.cells.has(id)` is false, the
  state is `stopped` and the desktop still has 1 start;
- the pause is refused (`failRequests`), then `cells.rewireIfLost(id)`: the desktop still has
  1 start and keyd has no cell.

**I-2. Tasks 12b and 13 do not compile against Part 2's web shell as built (`b97bc42`), and Task
12b's "App.test.tsx passes unchanged" is false.** The fix pass took Part 2's Tasks 13–15 in plan
form (Verification L12759). Since then they were built:
- `TopBar` (L10666): `<Mascot size={16} />`. The built `Mascot()` takes no props (`.brand .mascot`
  sizes it in CSS), so the web typecheck fails. Use `<Mascot />`. Part 3's `<Mascot size={18} />`
  has the same problem, which is Part 3's to fix.
- Task 13's `resume` (L11282) calls `api$.current.post`. The built `useCell` has no `api$` and
  posts through `api`, so this does not compile. Use `api.post` and depend on `api`.
- L10881. `useKeys` fetches `/api/keyd` on mount and every 5 s, so two built `App.test.tsx` tests
  fail:
  - "forgets a rejected token…" asserts `fetchImpl` was called once (now `/api/cells` and
    `/api/keyd`);
  - "stops and restarts the computer from the HUD…" asserts the exact call list, which now holds
    `GET /api/keyd`.

  Filter those assertions to `/api/cells` paths (or count cell calls only), and say so in the step.

Re-check the other Task 12b and 13 anchors against `b97bc42`: `App.tsx`, `app.css`, `hud-state.ts`
and the test helpers matched where I compared them.

### Minor

1. **A desktop paused in Docker but not marked paused can never start.** In `#startContainers`
   (non-frozen), a paused desktop counts as running, so its start gets Docker's 409. The HUD's
   `failed` state offers only Start. Ways in:
   - a frozen gate's restart fails;
   - a reconcile finds the gate dead beside a paused desktop (it marks the cell `failed`);
   - a Start sent to a frozen computer through the API.

   Fix: Start stops a paused desktop and boots it afresh (the user asked for a start), or the start
   route answers 409 "resume it first" while the cell is paused.
2. **Resume during a frozen gate's restart backoff strands the cell in `starting`.** `#unpause`
   replaces the `restarting` entry, so the queued restart is skipped, and the watch it detaches
   returns at once because the state is not `ready`. Also, `#startContainers(…, frozen)` sets
   `starting` without `paused`, so Paused and Resume vanish for that moment. Fix: let `#unpause`
   act only from `ready` (the route answers 409 otherwise), and carry `paused` on the frozen
   `starting` entry.
3. **`refreshRunningCells` runs outside the cell's queue.** For `starting` cells (M14) it can
   interleave with `wire()`: if it mints on the old keyd cell and then writes `surrogates.sh` after
   `wire()` has reopened the cell, the computer boots with stand-ins of a closed cell. It fails
   closed, with dead stand-ins until the next start. Fix: queue the refresh per cell (an
   orchestrator method), or skip a cell not yet wired.
4. **The guard's freshness.**
   - `active` can be stale for up to 5 minutes after a network change: the new address is not
     denied while the UI says active.
   - One lost UDP round turns a known guard `unknown` (doctor FAIL, hollow dot) until the next
     30 s retry.
   - While unknown, a STUN query goes to Cloudflare every 30 s for as long as the state lasts.

   Fix: re-learn when `DefaultGateway()` changes (a cheap 30 s check), give a known guard one
   round's grace, and back off to the 5-minute cadence after a few failed rounds.
5. **`doctor` can never pass for a user who opted out.** `-stun off` on a router without NAT-PMP
   means `off` or `unknown`, so the doctor exits 1 for good. Record that M9's doctor needs a
   warning level (Interfaces, L12386–12387).
6. **R30's cost is wider than recorded.** Besides GnuTLS (git's HTTPS, GLib), these skip a
   `TRUSTED CERTIFICATE` and so cannot use a key bound to a host:
   - Go programs such as `gh`: they read `SSL_CERT_FILE`, which is set, but parse only
     `CERTIFICATE` blocks;
   - rustls-based tools;
   - Java's keystore hook.

   Review 1 rated C3's own risk low, since the CA key never leaves keyd's memory. Surface the
   trade-off to the controller: keep R30, or record C3's residual and keep a plain anchor. Either
   way, git can get its own plain bundle through `GIT_SSL_CAINFO`, which OpenSSL does not read.
7. **`SkippedCellsError`'s wording.** "remove their containers" contradicts R14 ("a fixed record
   starts the cell again"); say to remove the containers only if the folder is removed. "can't be
   read" is also wrong for R15's case, an out-of-range record.
8. **The guard state is invisible to assistive technology.** In the `guard` state the Keys button's
   accessible name stays "Keys", and the dot is `aria-hidden`. Add the state to the name, for
   example "Keys, hairpin guard unknown".
9. **The canary's base64 coverage.** The control is planted exactly as the scanner encodes it
   (offset 0, unpadded), so it cannot expose the scanner's alignment blind spot: a canary inside a
   longer base64 blob at offset 1 or 2 mod 3 is never searched for. This predates review 1. Fix:
   add the two shifted encodings, with the partial edge groups trimmed.

## 6. Against the code built since the pass

- **Part 4a `fb12271` (the policy) holds.**
  - Task 14's expectations still match: `ip-literal` for IPv4 literals and `[::1]` (the literal
    check runs before the bracket rule), `host-invalid` for `localhost` (one label fails
    `validName` before `Denied`), `host-denied` for `printer.local`, and `port-not-allowed`.
  - 4b sends no non-canonical port.
  - Hosts and base URLs reach keyd as ASCII: the form sends `new URL(x).href`, and `bindingJson`
    refuses anything else.
- **The scrubber's empty-replacement refusal** (`fa07db9`) predates `56990a5`, and 4b builds no
  replacement.
- **netguard** is unchanged since `56990a5`, and Task 1's anchors (`static`, `nat64`, the denied
  map's last line, the four pass-list lines) match exactly.
- **Task 1's `cmd/keyd` and `admin` edits** sit on 4a's plan text: `run`'s flag check, `init`,
  `Close`, the `status` reply, and `shortHome`/`socketClient`/`adminCall` with `bytes` and `net`
  already imported. They need a re-sync if 4a's later tasks change those.
- **Part 2's Task 14 CSP** (uncommitted: `default-src 'self'`, `connect-src 'self'`,
  `form-action 'none'`) breaks nothing in 4b's UI:
  - no inline style or script anywhere in the plan;
  - same-origin fetches only;
  - `KeyForm`'s submit calls `preventDefault()` first, so `form-action` never applies.

  `keys.spec.ts` runs under it once it lands.
- **Part 2's daemon side** matches the plan's anchors: `#current`, `#records`, `#queued`, `clamp`,
  `codeOf`, `statusOf`, `isStatus`, `inventory()`, the fake Docker's `failRequests`, `holds`,
  `refusal` and `gatewayOnInternal`, `doctor.ts`'s `runDoctor` and `skipped`, `doctor-main.ts`,
  and `localdotHome`.
- **Global Constraints hold in the diff.**
  - No bind mounts.
  - The new Docker probes assert exit statuses (including `openssl verify`'s 2), and output is
    merged stdout+stderr as `dockerExec` gives it.
  - `localdot-test-*` names and `rm -fv` are unchanged, and no `--` precedes a test file.
  - No server runs on a test thread next to the synchronous Docker helpers.
  - The test CA minted in the Task 7 cell is test-only.
  - No AI attribution.
  - Hygiene patterns are not tripped (`sk-weather-123456` is too short for the key rule).

## 7. Verdict

**Fixes needed.** Two small, targeted fixes:
- I-1: on a failed freeze, fall back to Stop computer, with two tests;
- I-2: rebase the Task 12b and 13 web snippets and the App test expectations on `b97bc42`.

C1 and I1–I8 are otherwise fixed and pinned by tests that fail on v1, and P4b-C2 is met. The
Minors can ride along. A check of the I-1 and I-2 changes is enough; no full re-review is needed.
