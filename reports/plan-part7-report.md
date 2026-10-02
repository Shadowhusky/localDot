# plan-part7 report: the M6 "Replay" plan (Part 7)

**Status: DONE_WITH_CONCERNS.** The plan is written, committed and pushed. Everything I could run
without Docker or Chrome was run and passes. The concerns below come from what this machine
couldn't run.

- **Branch:** `claude/plan-part7`, based on `origin/planning` at `607e321`, which includes the
  review-tier and plan-format ruling.
- **Plan:** `docs/superpowers/plans/2026-10-01-localdot-core-part7-replay.md`, 4 870 lines,
  16 tasks.
- **Format:** an interface-and-test plan, as `PLAN-WRITING.md`'s "Plan format by milestone"
  requires since `607e321`. It shows full code only for the schemas, the byte formats, the
  closed-form playback math, the synthetic H.264 test stream, the takeover gate (`full` tier) and
  every Review Focus and security pin.

## Where recording happens, and why

**In the daemon.** For each live session the daemon opens one more passive client on the cell's
Selkies WebSocket (the same gate endpoint and credential the stream proxy uses). That client sends
no settings, input or acks. Each H.264 access unit is stamped on arrival with the daemon's
monotonic clock, then remuxed as is into a fragmented MP4 by mediabunny: nothing is decoded or
encoded.

The spec settles the question:
- "It works with zero, one or many viewers, and a replay renders exactly what the live view
  showed";
- "The daemon stamps every event and every incoming video chunk with its own monotonic clock";
- "taps the same stream for recording".

Glance, the default mode, runs exactly when nobody watches. A browser recorder records nothing
then, and a hidden tab records unreliably. A cell recorder adds a second x264 encode at 2× (already
107–250 % CPU in S1), runs on another clock, and puts the record of what the agent did in untrusted
hands.

Remuxing measured about 44 µs per frame in Node 24.

Two unknowns are routed to spike S9 (Task 1), which runs before any recorder code:
- **Q1 and Q2, the handshake:** does the passive `#shared` sequence alone yield video, and does it
  leave the user's viewer untouched?
- **Q7, the cost:** does Selkies encode per client? If it does, `ViewerTapFeed`, a change contained
  behind the `FrameFeed` interface, taps an attached viewer's relay instead.

## Tasks (review tier)

1. Spike S9: the recorder's view of the Selkies stream (light).
2. Protocol: the recording layout, the manifest, `SessionCard` and the replay API schemas (light).
3. mediabunny 1.61.0 pinned, with its MPL-2.0 notice shipped in the UI build (light).
4. Synthetic H.264 test media whose decoded picture tells which frame it is (light).
5. Stage: the replay model (steps, observes, plans, typed marks) and a scene index for long
   sessions (light).
6. Stage: busy spans, the skip-idle playback map, the replay clock, chapters and ticks (light).
7. Daemon: the fMP4 writer, the GOP journal and the fragment index (light).
8. Daemon: recovery and the served view, with the crash, disk-full and seek pins (light).
9. Daemon: the passive Selkies feed (light).
10. Daemon: the session recorder and the Recorder service, with `LiveSessions` hooks, startup
    recovery and shutdown (light).
11. **Recording pauses while the user has control (full).**
12. Daemon: `EventLog` tail recovery, NDJSON events, the session index, thumbnails, retention, the
    replay routes and the seeder (light).
13. Web: replay in the render worker (mediabunny, WebCodecs, the observe backdrop) and the browser
    pins (light).
14. Web: the Theatre's Replay mode: the sessions rail, the scrubber, speeds, skip idle, keys,
    compare and jump to live (light).
15. Web: MP4 export with the overlays burned in, written into a file the user picks (light).
16. Acceptance on a real cell, the docs and the full suite (light).

## Decisions (P7-R1 to P7-R17)

Each decision's reason and its cost if wrong are in the plan.

- **R1:** recording happens in the daemon, as a passive Selkies client.
- **R2:** storage is one fMP4 per session, with one GOP per fragment, an append-only file,
  `fragments.jsonl`, a per-GOP journal, and recovery that appends the journal and an `mfra`. A
  live or cut-off recording is served as its committed fragments plus a fresh `mfra`, at a stable
  `?upto=` snapshot.
- **R3:** media time is session time. The timescale is 1 000 000, so the log-to-media index is the
  identity.
- **R4:** the recorder asks for a key frame after 2 s of motion, and once when the screen goes
  still.
- **R5:** retention is 20 GB and 30 days, with an 8 GB cap per session and free-space floors of
  2 and 1 GB. Expiry removes only the video.
- **R6:** thumbnails come from observe screenshots through sharp, never from the video.
- **R7:** the session index is a SQLite `session_cards` table, rebuildable from the session
  folders. `EventLog` recovers from the log's tail.
- **R8:** the overlays are `sceneAt` alone, in the same worker as live. Export renders by frame
  index at 30 fps.
- **R9:** scrubbing follows a decode policy: key-frame previews while dragging, an exact frame on
  release, and a jump to the key frame during play.
  - Speeds run from ½× to 8×.
  - Skip idle compresses quiet stretches of 1.5 s or more to 400 ms, and says so.
- **R10:** privacy:
  - nothing is recorded during takeover;
  - exports carry no identifiers or metadata and are never uploaded;
  - no pixel redaction, because a cell holds only surrogates and secret fields are masked at the
    source.
- **R11:** export runs in the browser with WebCodecs and mediabunny, streamed into a picked file.
- **R12:** stretches without video replay over the observe screenshots.
- **R13:** mediabunny's MPL-2.0 handling: unmodified, with a notice and the source location.
- **R14:** no new protocol event. A typed `markOf` fallback covers M4 and M5 events.
- **R15:** Replay unmounts the Selkies iframe.
- **R16:** the recorder hooks `LiveSessions`.
- **R17:** the browser pins run on seeded synthetic sessions, with no Docker.

**Review Focus:** seek accuracy (Tasks 8 and 13), a crash mid-recording (Task 8), disk full
(Tasks 8 and 10), a 2-hour session's memory and CPU (Tasks 5, 12, 13 and 15), overlay determinism
(Tasks 13 and 15), and the privacy of recordings and exports (Tasks 11 and 15). Every pin is
printed in full.

## Verified (scratch copy, pinned toolchain: Node 24.21.0, TS 7.0.2, Vitest 5.0.3, zod 4.6.5, mediabunny 1.61.0)

- **mediabunny's muxing path in Node.**
  - Annex B goes in without a description.
  - Fragmented writes are append-only until `finalize`.
  - Timestamps are kept, and with `frameRate: 1e6` they are µs-exact at 2 hours (156/156
    boundary seeks exact).
  - ffprobe reads the output.
- **A mediabunny 1.61.0 limitation, found and pinned.** Its `trun` flags only the first sample of a
  fragment as a key frame, so the plan cuts one GOP per fragment. Before the fix
  `getKeyPacket(1.5)` returned 1.0; after it, 1.4.
- **Crash recovery.** The journal's frames, muxed into their own fragment, plus an appended `mfra`:
  53/53 packets back, and ffmpeg decoded all 53 with the right frame identity.
- **The synthesized `mfra`.** A seek in a 1 799-fragment file went from reading the whole 5.9 MB to
  4 reads.
- **The plan's code blocks.** Tasks 2, 4 and 6 were extracted from the plan and run: their tests
  pass and `tsc` is clean.
- **Task 5.**
  - Part 3's stage code was extracted from its plan and patched as Task 5 says. All 23 stage tests
    pass, including Part 3's own.
  - The 2-hour pin discriminates: Part 3's scene took 0.99 ms per call, and the indexed one is
    under the 0.2 ms bound.
- **The recorder pins (Tasks 7, 8, 10 and 11):** 21/21 pass as printed, against prototypes. They
  cover SIGKILL at five points, ENOSPC at the writer and session level, the free-space floors and
  the takeover gate (two gate bugs were found and fixed while doing this).
- **Task 12's long-log pins.** The reopen pin fails on Part 1's `EventLog` (1 008 ms) and passes
  with tail recovery (1 ms). NDJSON streaming of a 55 MB log retained a peak heap of 0.6 MB.
  Part 1's 21 `EventLog` tests pass unchanged.

## Not verified (no Docker or Chrome here)

- every Selkies question (S9, Task 1);
- the browser pins, the UI and export (Tasks 13–15);
- the route security test (it needs `createApp` as built);
- the summaries, index, thumbnails and retention, and the feed tests;
- the Docker acceptance (Task 16);
- Biome on the plan's long lines.

The plan's "Assumptions" section lists 14 points on unbuilt Part 3 code, for the pre-flight.

## Top concerns

1. **S9 is a hard gate.** The recorder rests on Selkies serving a headless passive client, and on
   that client being cheap, both unproven. The fallbacks are written: `SETTINGS` as primary, and
   `ViewerTapFeed`.
2. **`REQUEST_KEYFRAME` on a still screen is unknown.** Without it, a replay of a *live* session
   shows the last action's frames late. Crash safety doesn't depend on it.
3. **Task 12 edits Part 1's `EventLog`** (tail recovery). All 21 of its tests pass against the
   change; it still deserves a careful review.
4. **The plan is about 4.9k lines,** more than the "a third of 12k" target, because six pins and
   the takeover gate are printed in full as required.
