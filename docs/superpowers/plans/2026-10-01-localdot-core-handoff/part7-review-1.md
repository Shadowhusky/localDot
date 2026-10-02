# Part 7 plan review 1: Replay (M6)

- **Plan:** `docs/superpowers/plans/2026-10-01-localdot-core-part7-replay.md` on `origin/claude/plan-part7` at `af14d3d`. It runs to 4,870 lines, with 16 tasks and P7-R1…R17. Line numbers below are the plan's (`L1234`).
- **Read against:**
  - the spec: Success criteria, Architecture, "One click", Clock, Event log, Overlays, Interface, Setup and operations, Error handling, Testing, Repository and Milestones;
  - `jobs/PLAN-WRITING.md` (the interface-and-test format);
  - Part 3's plan ("Interfaces Part 4 builds on", `LiveSessions`, `toSessionT`, `FrameStore`);
  - `feat/core-part2` at `b02765f`: `event-log.ts`, `app.ts`, `stream-proxy.ts`, `watchdog.ts`, `orchestrator.ts` (`CellApi`), `static-ui.ts` (CSP), `packages/protocol/src/events.ts`;
  - the vendored Selkies client `apps/web/vendor/selkies/assets/selkies-core-BbKps5RD.js`.
- **Scope:** this review edits nothing except this file.

## 1. Spec coverage

| Spec requirement | Task | Verdict |
|---|---|---|
| M6: recorder (fMP4 via mediabunny) | 7–11 | covered |
| M6: thumbnails | 12 (from `observe` frames), 14 (hover, rail) | covered |
| M6: session index | 12, 14 | covered (rebuildable from the folders, as the spec's Event log rule asks) |
| M6: replay UI | 13, 14 | covered |
| M6: MP4 export | 15, 16 | covered |
| SC4: "any session replays…" | 10 (records with no viewer), 13 (backdrop when there is no video) | covered |
| SC4: "…with scrubbing" | 13 (decode policy), 14 (scrubber) | covered; play mode has a defect (I3) |
| SC4: "…a step timeline" | 5, 6, 14 | covered |
| SC4: "…'jump to live'" | 14, 16 | the pill is covered; the automatic follow is not workable as specified (I7) |
| SC4: "…exports to MP4" | 15, 16 | covered |
| Interface: Replay = scrubber, step chapters, speeds up to 8×, skip idle, before/after, jump to live | 6, 13, 14 | covered |
| Clock: "stamps … every incoming video chunk with its own monotonic clock" | 9 (`arrivalMicros`), 10 (`toSessionT`) | covered |
| Architecture: "taps the same stream for recording"; "zero, one or many viewers" | 9, 10 (P7-R1) | covered; the S9 gate needs more cases (I1) |
| Determinism: "rendering the same log twice produces identical frames" | 13 and 15 (pins) | covered |
| Overlays: only in the viewer | 13, 15 | covered |
| Setup and operations: `~/.localdot/` holds sessions (events, observe screenshots, video, thumbnails) | 2 (layout), 12 | covered |
| Error handling: a cell crashes, or the stream drops | 9 (backoff), 10 (`stream-lost` gap) | covered |
| Error handling: a stream stall | 9 (Part 2's `StallWatchdog`) | covered |
| Testing, end to end: "replay scrubbing; MP4 export" | 13–16 | covered |
| Repository: mediabunny (MPL-2.0) | 3 (exact pin, no patches, notice shipped as `/assets/licenses/…`) | covered and correct: MPL-2.0 §3.2(a) for the minified Executable Form, and the file-level copyleft is untouched because the files are unmodified |

**The protocol events Replay relies on** (checked against `events.ts`):
- **Overlays and the model:** `session.start` and `session.end` (`reason` is `done`, `stopped` or `error`), `agent.state`, `step.start` and `step.end` (`ok`, `failed`, `blocked`, `cancelled`), and Part 3's `action.*`, `text.progress`, `screen.settle` and `observe` (`frameId` is a ULID in Part 3).
- **The plan rail:** `plan.set` and `plan.update`.
- **The privacy gate and the `takeover`/`handback` marks:** `control.change` (`holder`, `reason`).
- **Typed marks through `markOf`:** `approval.request` and `approval.resolve`, `pause.change`, `tool.start` and `tool.end`, `file.change`, `memory.change`, `key.use` and `step.verify`.
- **Ignored:** `heartbeat`, `thought.delta`, `tool.output` and `camera.hint`.

Every schema the plan reads exists. The plan adds no event, so keyd's JSON Schema is unchanged. `markOf` misses `key.use` with `decision: "ask"` (m10).

## 2. What I ran (scratch copies under `/tmp/job-review-plan-part7/`, Node 24.21.0, Vitest 5.0.3, TS 7.0.2, zod 4.6.5, mediabunny 1.61.0)

| Run | Result |
|---|---|
| Task 2 `recording.test.ts`, as printed | 2/2 pass |
| Task 4 `h264-synth.test.ts`, as printed | 4/4 pass |
| Task 7 `boxes.test.ts` (boxes and journal), as printed | 3/3 pass |
| Task 8 `seek.test.ts`, `crash.test.ts` (five real SIGKILLs of a `tsx` child) and `diskfull-writer.test.ts`, as printed | 7/7 pass against my own prototypes of `writer.ts`, `recover.ts` and `view.ts`, written only from the plan's interfaces and implementation notes. The pins are satisfiable, and the notes are enough to write those three files |
| Task 11 `control-gate.test.ts`, the three pure `ControlGate` cases | 3/3 pass. I did not run the two `SessionRecorder` cases (they need Task 10's recorder) |
| Task 12 `long-log.test.ts` on Part 1's `EventLog` (`feat/core-part2`) | the reopen pin **fails as the plan says**: 911 ms against a 200 ms bound. The NDJSON pin passes |
| Task 12 tail recovery, implemented from the notes, on that `EventLog` | `long-log` passes 2/2. Part 1's `event-log.test.ts` (21) passes unchanged, and so do `event-stream.test.ts` and `app.test.ts` (39) |
| Probe: ms → s float conversion for seeks (`(t/1000)/1000` against `t/1e6`) | the two differ by 1 ulp for 82 of 300 VFR timestamps. mediabunny still returns the exact frame for all 300 (0 wrong), so this is not an issue |
| Probe: `flushIdle`, and when an idle IDR commits | durations come from the gaps between timestamps. The flush duration is kept only for a fragment's last sample. **An IDR that arrives on a still screen stays pending, so the previous fragment commits only when that IDR is handed to the muxer at the next `flushIdle`** (this matters for I2) |
| Probe: recovery of a two-GOP journal tail with `minimumFragmentDuration: Infinity` | key packets at `[0, 10]` instead of `[0, 10, 20]`. The tail's second IDR loses its sync flag (m1) |
| mediabunny typings and source | every API the plan names exists. `bitrate` is deprecated in favour of `quality`. The Mp4 muxer stamps `creationTime = Date.now()`, which can't be configured (m7). Blob workers exist, but only on paths the plan doesn't use (m8) |

**Not run:**
- Task 5's 2-hour stage pin (Part 3's stage isn't built);
- Task 10's suites and the gate's recorder-level pins;
- Task 9's feed and wire tests (the wire test is described, not printed). I checked the header layout and the `#shared` handshake by reading the vendored client: both match;
- every browser pin and all UI;
- Docker and S9.

## 3. Findings

### Critical

None.

### Important

**I1. S9 is a real gate for a recorder alone or beside a viewer, but it skips the orders and transitions the design depends on, and puts no bound on GOP length.** (Task 1, L352–390; Task 9, L2311–2312 "Text messages outside the handshake are ignored"; P7-R1)
- **Evidence:**
  - Q2 tests the probe joining while the Theatre is already open (L358). The usual order is the reverse: `beforeRun` dials the recorder before the first step (L2528), and the user opens Watch later or leaves for Glance.
  - Part 2's relay comment (`stream-proxy.ts`) records that Selkies "streams nothing until it has" a client's settings.
  - The vendored shared client does more than the plan's handshake:
    - it handles `PIPELINE_RESETTING` (the minified handler sits where the client logs "Shared mode: Primary pipeline reset");
    - it runs a watchdog that re-sends `START_VIDEO` with backoff after "no video chunk for N ms".

    The recorder ignores every text after the handshake. Its ping-and-pong liveness keeps the socket "live" while no video arrives, so a reset caused by a viewer's `SETTINGS` could silently stop the recording.
  - A viewer whose `SETTINGS` differ from what the recorder got alone (encoder, full colour, size) changes the stream's format. Task 10 then ends the recording with `recorder-error` (L2463).
  - If `REQUEST_KEYFRAME` has no effect, the gate sets `KEYFRAME_EVERY_MS = 0` and records only the seek cost (L388–390). The writer then holds the whole open GOP in memory (L1713), and the plan sets no bound on that GOP. A long continuous-motion GOP becomes unbounded RAM.
  - The `ViewerTapFeed` fallback only helps while a viewer exists, which is not the Glance case.
- **Smallest fix:**
  - Add to Q2:
    - (a) the recorder first, then the Theatre connects;
    - (b) the Theatre leaves while the recorder stays, and video must keep flowing within 2 s;
    - (c) the Theatre reconnects.

    In each, assert that the recorder's codec and size don't change and log every text message the recorder receives.
  - Make Task 9 mirror the shared client: re-send `START_VIDEO` on `PIPELINE_RESETTING`, and after `STREAM_STALL_MS`-scaled silence while the screen is moving (or simply redial). Add a fake-Selkies test for "a `PIPELINE_RESETTING` resumes video".
  - Add to the gate: "if Q5 finds no working `REQUEST_KEYFRAME` and Q6's longest GOP under motion exceeds 10 s, BLOCKED (the writer's memory and seek costs are unbounded)".

**I2. The idle policy asks for a key frame again for every key frame it gets, so on a still screen it can loop forever.** (Task 10 "Idle", L2483–2486; frame path step 6, L2467; P7-R4 "Never while still")
- **Evidence:**
  - The policy calls `flushIdle` and `requestKeyframe()` "once per idle period", and the test says "Further ticks add nothing until frames resume" (L2546–2548).
  - When Selkies honours the request (the outcome S9 Q5 hopes for), the IDR is a frame, so frames have "resumed". It also becomes the writer's pending frame (probe above). Nothing more arrives, so 500 ms later a new idle period begins, `flushIdle` runs, and the policy asks again.
  - The loop yields an IDR roughly every 0.6 s on a still screen:
    - At 2560×1600 4:4:4 that is hundreds of KB per IDR: gigabytes per idle hour, against the 8 GB session cap and the 20 GB retention budget.
    - Every live viewer gets the same IDRs if Selkies encodes once.
    - Each IDR opens an activity span (step 6), so skip idle never compresses a still stretch.
  - `FakeFeed` never answers a request, so no test can see the loop.
- **Smallest fix:**
  - Track `idleKeyRequested`. A key frame that arrives while it is set:
    - is flushed into the muxer at once, which commits the fragment that holds the last change;
    - adds no activity;
    - does not end the idle period.

    Only a delta frame, or a frame more than `IDLE_FLUSH_MICROS` after the request, starts a new period.
  - Give `FakeFeed` an `answerKeyRequests` option, and add the case "asks once per still stretch even when every request is answered, and the answer adds no activity".

**I3. Play-mode decoding can re-seek the same key frame forever, and export uses play mode, so both can show a stale frame.** (Task 13 `nextDecodeStep` table, L3581–3584; Task 15 worker, L4191–4192)
- **Evidence:**
  - The play row `targetMs − nextMs > JUMP_AHEAD_MS → seek-key` has no condition that a newer key frame exists. After `seek-key` shows key K, either:
    - `nextMs` is K's successor, still more than 1.5 s behind, so the policy seeks K again; or
    - `nextMs` is unspecified or null, and the first play row then does a full `seek-exact`, the decode the jump was meant to avoid.
  - Crossing a skip-idle segment always triggers the jump: 400 ms of playback covers at least 1.5 s of session time. In a still stretch after a burst, the frame on screen was the burst's *last* frame, but `seek-key` shows the GOP's *first*. So the video sits behind the overlays for the whole idle stretch: the opposite of "never shown out of time" (P7-R9).
  - Export "uses `ReplayVideo` only in play mode with increasing targets (sequential decode, no seeks after the first)". That contradicts the same policy, and export frames inherit the stale key frames.
  - Every pin seeks while paused, so none sees this.
- **Smallest fix:**
  - Play `seek-key` only when `targetKeyMs !== null && targetKeyMs > (shownKeyMs ?? −∞)`; otherwise `advance`. After `seek-key`, the iterator restarts at the key (`nextMs` = its successor).
  - Export never uses `seek-key`: it uses `exact` (decode forward to the last frame ≤ t).
  - Add `decode-policy` rows: "play never re-seeks the key frame it shows" and "play across an idle jump inside one GOP advances".
  - Add an export probe check that the presented frame's timestamp equals the last frame ≤ `sessionMsAt(i)` for every frame (Task 15's pin can assert it through `sourcesBetween`'s sibling).

**I4. The privacy gate (full tier) has an open ordering seam at start, and the hand-back half of M5's rule is missing.** (Task 10, L2393–2394 and L2513–2514; Task 11; "Interfaces later milestones build on", L2490–2498)
- **Evidence:**
  - `Recorder.start` reads `backlog = eventLog.read(sessionId)` when it builds the deps. `subscribe` is attached later, inside `SessionRecorder` (whose `start()` is async). If anything awaits between the two, a `control.change` appended in that window is in neither, and the gate records the user's whole takeover.
  - The bypass hunt (L2952–2957) doesn't list this.
  - The closing interface says the change is appended "before the first user input reaches the cell". It says nothing about hand-back. Unless the agent's `control.change` is appended only *after* the user's input path is closed, frames showing the user's last keystrokes are admitted from the next key frame.
- **Smallest fix:**
  - Subscribe first, synchronously, then read the backlog and fold it de-duplicated by `seq`, in `Recorder.start` itself before any `await`.
  - Add to the bypass hunt and as a pin: "a `control.change` appended between `Recorder.start` and `SessionRecorder.start` still closes the gate".
  - Add to the M5 seam: "`control.change { holder: "agent" }` is appended only after the user's input path is closed".

**I5. Recovery under a disk that is still full can leave a torn `mfra`, and the route then serves the file as if it were complete.** (Task 8 recovery steps 4–5, L1792–1801; Task 10 `#fail`, L2494–2498; route table, L3089 "`complete` for the states `complete` and `recovered`")
- **Evidence:**
  - `#fail("disk-full")` runs `recoverRecording` straight away, typically on the same full disk. Step 5's `mfra` append (about 28 bytes per fragment, e.g. 50 KB for 1,800 fragments) can fail part-way.
  - Task 10 says the view "serves that prefix with a fresh `mfra`" (L2496–2498). The route opens `recovered` with `complete: true`, so it serves the file as is, torn tail included. mediabunny reads a garbage `mfro` from the last 16 bytes.
  - `recoverRecording` takes no `fs`, so this path can't be pinned. Review Focus 3's writer pin restores the space first (L2084).
- **Smallest fix:**
  - Give `recoverRecording(dir, format?, fs?)`.
  - On any write failure, truncate back to the last good `endOffset` and return `state: "recovered", complete: false`, recorded in the manifest (for example a `finalized: boolean` field). The route then uses `complete: manifest.finalized`.
  - Add a pin: "recovery on a still-full disk leaves a file whose served view plays every committed fragment".

**I6. A manifest that is merely invalid deletes the recording at startup.** (Task 10 `readManifest`, L2440 "null when absent or invalid"; `recoverAll`, L2519–2523; Task 2 `activity.max(200_000)`, `gaps.max(10_000)`)
- **Evidence:**
  - `recoverAll` removes "a recording dir without a manifest". Because `readManifest` returns `null` for an *invalid* manifest too, any of these deletes `video.mp4`:
    - a schema mismatch (a future `v: 2` after a downgrade);
    - an activity array past its `max`, which is reachable when long sessions write many spans, especially with I2's loop;
    - a field the recorder wrote out of range.
  - No step caps the activity array before writing.
- **Smallest fix:**
  - `readManifest` returns `{ ok: false, reason }` for an invalid manifest, distinct from `null` for an absent one.
  - `recoverAll` removes a dir only when the manifest is absent *and* there is no `fragments.jsonl` and no non-empty `video.mp4`.
  - The session recorder merges the oldest activity spans before reaching the cap.
  - Add a pin: "an unparseable manifest never deletes a video".

**I7. Replaying a live session gets no new events, and the follow rule keys on video that may never commit, so "go-live" can't happen as specified.** (Task 14 loading, L4011–4019; follow rule, L3940–3944 and L4064–4066)
- **Evidence:**
  - `useReplay` reads the events once, as an NDJSON snapshot ("complete lines inside the file's size at the call", L3015). The only live poll is `GET /recording` every 2 s, for `upto`. So the model, chapters, ticks, overlays and `endMs` freeze at load time, while "`endMs` … refreshed with the follow rule" (L4018) has no mechanism behind it.
  - `followRule` compares against the recording's `lastMs`. On a still screen with no idle IDR (the S9 outcome the plan accepts, L4581–4583), `liveNowMs − lastMs` grows past `LIVE_EDGE_MS` and the rule answers `refresh` forever. Playback then hits the frozen map's end and pauses, and `followRule` requires `playing`.
- **Smallest fix:**
  - While the session is live, each 2 s poll also fetches `GET /events?fromSeq=<next>` (NDJSON), folds the new events into the page and the worker, and rebuilds the map with the new `endMs`.
  - The edge test uses `max(lastMs, last event t)`.
  - Add `replay-view.test.ts` cases for a still live session (go-live once the playhead reaches the last event), and a jsdom case that a poll extends the chapters.

### Minor

- **m1. Recovery muxes a multi-GOP tail as one fragment.** (L1794)
  - **Evidence:** at a crash the journal can hold two GOPs: GOP *n* closes only when the frame after the next IDR arrives. `minimumFragmentDuration: Infinity` puts both in one fragment, and the second IDR loses its sync flag (verified: key packets `[0,10]`, not `[0,10,20]`). `fragments.jsonl`/`tfra` then get one entry. Seeks still decode correctly, but from the earlier key.
  - **Fix:** use `FRAGMENT_MIN_SECONDS` (0) and one entry per `moof`, and assert the key flags in the crash pin.
- **m2. Hand-back residue isn't documented.** Frames encoded in the last milliseconds of a takeover can arrive after `GIVE` and be admitted if one is a key frame. The first key frame after hand-back also shows whatever the user left on screen. That is the same picture the model sees next, so it is acceptable.
  - **Fix:** say so in P7-R10 and `docs/replay.md`, and optionally resume only on a key frame received at least 100 ms after `GIVE`.
- **m3. `readTail` can stop too early.** (L3319–3323) "Grow the window until a newline is found" should be "until a *parseable* complete line is found, or the file start". Otherwise a trailing run of complete but unparseable lines longer than the window gives `lastSeq = -1` and duplicate `seq`s.
  - My implementation with that rule passes every pin and all 21 of Part 1's tests. Otherwise the change is correct and compatible: the index check `has !== 1 || MAX(seq) !== lastSeq` catches every inconsistency Part 1 can leave, including index rows ahead of a shortened log and a failed insert or rebuild before a crash.
  - **Fix:** add a test with more than 64 KiB of invalid trailing lines.
- **m4. The NDJSON route is shadowed.** Part 1 registers `GET /api/sessions/:id/events` in `createApp` (`app.ts` L60) before `replayRoutes` would, so the first handler answers JSON whatever the `Accept` header.
  - **Fix:** modify Part 1's handler in `app.ts` (add it to Task 12's Modify list), or register `replayRoutes` first.
- **m5. `upto = 0` is unspecified.** A live recording before its first commit (possibly for a long time on a still screen) has none. `openRecordingView` indexes `entries[upto − 1]`.
  - **Fix:** the route answers 404 for `upto = 0`, the page treats it as no video yet (backdrop), and `routes.test.ts` gets a case.
- **m6. Two printed pins fail on a correct build.**
  - The export privacy pin's `/export/i.test(r.url())` (L4284) matches the export worker's own chunk, `GET /assets/export-worker-<hash>.js`, requested when the export starts. Exclude same-origin `GET /assets/`.
  - The seeder writes no manifest `gaps` or `activity` for its takeover (L3067, L3383–3387). Without a `user-control` gap, `sourceAt` answers `video` inside the takeover, which fails `sourcesBetween` (L4297) and the "takeover gap card" UI case. Specify that the seeder writes the manifest's gaps and activity exactly as `SessionRecorder` would.
- **m7. Exports aren't quite metadata-free.** mediabunny 1.61.0 writes the export's wall-clock time into `mvhd`, `tkhd` and `mdhd` (`creationTime = Date.now()`, which can't be configured). That is the export date, not an identifier, but P7-R10 and `PRIVACY_NOTE` should not say "no metadata". Also, `CanvasSource({ bitrate })` is deprecated: use `quality`.
- **m8. Assumption 10 is wrong in its wording.** It says mediabunny "uses no blob workers in 1.61.0". It does:
  - `MediaStreamVideoTrackSource`'s unthrottled timer (`misc.js`);
  - the colour/alpha splitter and merger.

  The CSP `default-src 'self'` blocks them. None is on the plan's paths.
  - **Fix:** state the constraint instead: never use `MediaStreamVideoTrackSource`, and keep `alpha: "discard"`.
- **m9. The key-request cadence is untested against the viewer.** `KEY_REQUEST_MIN_GAP_MS = 250` (L2155) is far below the vendored client's own throttle: 1,500 ms in shared mode, 500 ms as primary. P7-R4 says S9 Q5 measures the bitrate cost of forced IDRs, but Q5 measures only latency.
  - **Fix:** add bytes per second with and without requests, as the viewer sees them, to Q5, and default the gap to at least 500 ms.
- **m10. `markOf` misses a decision.** `key.use` with `decision: "ask"` has no row; give it one (for example `Asked to use a key → <host>`, tone `attention`).
- **m11. The wiring is missing.** `RecorderDeps` has no index, summary or retention hook. Yet Task 12 says `Recorder.stop` writes `summary.json`, invalidates the index and runs retention (L3344, L3360). Add `onFinished?(sessionId)` to `RecorderDeps` and wire it in `main.ts`.
- **m12. The index route scales with every event.** `SessionIndex` pages over `EventLog.listSessions()` (L3352), which `COUNT`s a `LEFT JOIN` over every event row. That is O(all events) per page.
  - **Fix:** page over the `sessions` table directly.
- **m13. Retention can expire a video while a replay is reading it.** The open replay then gets 404s mid-scrub.
  - **Fix:** skip sessions with an open view, or document the fallback to the backdrop.
- **m14. Format slips:**
  - the file map omits `endpoint.ts`, `run-desktop.sh`, `crash-stream.ts`, `fake-feed.ts`, `diskfull-session.test.ts`, `probe.ts`, `GapCard.tsx`, `burn-in.ts`, `ci.yml` and `docs/measurements/…`;
  - Task 1 has no "Acceptance" line;
  - Task 5's "Consumes … Task 15's `SessionModel.frames`" means Part 3's Task 15;
  - `apps/web/e2e/seed.ts` imports `../../daemon/src/...` by relative path, against the "workspace imports by package name" rule. Export `SeedResult` from a daemon `testing` entry, or duplicate the type.

## 4. On the questions the job asked

- **Is the passive Selkies client sound?**
  - **What matches:** the header layout (type, flags, frame id, region, width, height, u16 at 10) and the `#shared` handshake (`MODE websockets` → `STOP_VIDEO` → 250 ms → `START_VIDEO`) match the vendored client. In shared mode, its main-thread path never sets the frame id it acks, so it appears to send no `CLIENT_FRAME_ACK`. Its worker transport also acks, and I couldn't tell from the minified code whether shared mode uses it, so Q8 is the right check. Credential handling equals the relay's and is pinned.
  - **What is missing:** the reset and re-start behaviour, and the client orders the design depends on (I1).
- **Is S9 a real gate with workable fallbacks?**
  - It is real: BLOCKED with transcripts if Q1 and Q2 fail.
  - The fallbacks (`SETTINGS`, `ViewerTapFeed`) are workable but incomplete:
    - `ViewerTapFeed` can't help when nobody watches;
    - `SETTINGS` from the recorder can conflict with a later viewer's;
    - nothing bounds the GOP (I1).
- **What happens with no key frame on a still screen?**
  - The plan's answer is honest: the newest GOP stays uncommitted, a live replay lags until motion resumes, and the journal keeps crash safety.
  - It misses three things:
    - an early session can have `upto = 0` (m5);
    - the follow rule then never goes live (I7);
    - when key frames *are* available, the idle policy loops (I2).
- **Interfaces:** they match Part 2 as built and Part 3's closing interfaces:
  - `CellApi` `get` and `endpoints`, `StreamEndpoint { baseUrl, authorization }`, `STREAM_PING_MS`/`STREAM_STALL_MS`, and `StallWatchdog { pingEveryMs, stallAfterMs, ping, onChange; start, touch, stop, lastAt }`;
  - `EventLog.subscribe((sessionId, event))`, wrapped per session, `read`, and Part 3's `toSessionT` and `LiveSessions`;
  - the CSP for workers, `connect-src` and blob images;
  - `/api/*` token middleware.

  The one conflict is m4.
- **Task 12's `EventLog` change:**
  - It is correct and compatible with existing logs. Part 1's logs, index schema and recovery outcomes are unchanged, and only the cost changes.
  - Verified: Part 1's 21 tests, 39 dependent daemon tests and both long-log pins pass, and the reopen drops from 911 ms to well under the bound.
  - The one gap is m3.
- **The Review Focus pins:**
  - **Present:** seek accuracy (daemon: passes; browser: paused seeks only, see I3), a crash (passes, five SIGKILLs), a full disk (passes with the space restored; still-full recovery is unpinned, I5), and 2-hour memory (stage: not run; daemon log: passes; browser: printed).
  - **Determinism:** printed, sound.
  - **Privacy:** the gate pins pass at gate level. The export pin needs m6, and the gate needs I4's ordering pin.
  - **CPU at 2 hours** is only proxied: seek p95 under 1 s, and the export fps is annotated, not bounded. That is acceptable for a light-tier UI.
- **Enough detail:**
  - The daemon recorder tasks (7, 8) are complete enough to write once: my prototypes passed the printed pins first time.
  - Tasks 10, 13 and 14 need the I2, I3 and I7 policy fixes before they can be written once correctly.

## 5. Verdict

**FIXES_NEEDED.** 0 Critical, 7 Important, 14 Minor. No Critical, so per `jobs/PROCESS.md` the fix pass needs no re-review.
