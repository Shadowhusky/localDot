# localDot Core — Part 7: Replay (M6) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish milestone M6 "Replay" and success criterion 4 ("any session replays with
scrubbing, a step timeline and 'jump to live', and exports to MP4"). The daemon records every live
session as a fragmented MP4 without decoding or encoding anything, whether or not anyone watches.
Each session gets an entry in a session index with a cover thumbnail. The Theatre gains its Replay
mode: the same PixiJS stage and `sceneAt` overlays as live, driven by a scrubber with step
chapters, typed event ticks, hover thumbnails, speeds up to 8×, skip idle, before/after compare and
"Jump to live". A session exports to an MP4 with the overlays burned in, rendered frame by frame by
the same renderer.

**Architecture:** Recording happens **in the daemon** (P7-R1). For each live session the daemon
opens one more client on the cell's Selkies WebSocket, through the same gate endpoint and
credential the stream proxy uses. It acts as a passive viewer that never sends settings or input.
Every H.264 access unit it receives is stamped on arrival with the daemon's monotonic clock,
converted to session microseconds (`EventLog.toSessionT`), and handed unchanged to mediabunny's
`EncodedVideoPacketSource`. The muxer writes `recording/video.mp4` as a fragmented MP4 with one GOP
per fragment and a timescale of 1 000 000. So a media timestamp *is* the session time of the
event log's envelope `t`, and the "index from event-log time to media time" is the identity
(P7-R3). The muxer holds the open fragment in memory until the next key frame. So every frame
also goes, before it is muxed, to an append-only GOP journal on disk. A fragment's journal is
deleted once the fragment's bytes and its line in `fragments.jsonl` are written. After a crash, or
a disk-full stop, recovery does three things:
- it truncates the file to the last indexed fragment;
- it muxes the journal into one more fragment and appends it;
- it appends an `mfra` random-access box.

A recording still being written is served as its committed fragments plus a freshly built `mfra`.
So the browser seeks any recording, live or cut off, with a few range reads (P7-R2).

The browser replays inside the existing render worker. Its replay mode reads the recording with
mediabunny over `UrlSource` (bearer header, range requests, a 32 MiB cache) and decodes with
WebCodecs. It presents the last frame at or before the replay time, and samples the same
`sceneAt(model, t, view)` as live. The overlays are therefore the live overlays by construction
("replay equals live", research §4.1). When a stretch has no video (the recorder failed, the
recording was expired by retention, or the user had control), the worker presents the `observe`
screenshot in effect instead.

Export runs in a dedicated worker. It uses the same `PixiPresenter` and `sceneAt` on its own
OffscreenCanvas at a fixed 30 fps, encodes with mediabunny's `CanvasSource` (WebCodecs
`VideoEncoder`), and streams the MP4 straight into a file the user picks with the File System
Access API. Nothing about an export passes through the daemon.

**Tech Stack:** Everything Parts 2 and 3 pinned:
- host Node 25.6 (cells Node 24.21.0), pnpm 10.29.3, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3;
- Hono 4.13.12, ws 8.22.0, zod 4.6.5;
- React 19.3.0, Vite 8.3.1, PixiJS 8.21.0;
- @playwright/test 1.63.0 on system Chrome;
- sharp 0.35.5 (already in the lockfile; the daemon now depends on it too).

New: **mediabunny 1.61.0** (MPL-2.0, published 2026-09-29), in `apps/daemon` (muxing, recovery)
and `apps/web` (demuxing, decoding, export). It is the only new npm download.

**Spec:** `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-core-design.md`.
The relevant sections are "Intent", "Success criteria" (4), "Architecture" ("event log + recorder",
"taps the same stream for recording"), "One click, end to end" ("It works with zero, one or many
viewers, and a replay renders exactly what the live view showed"), "Action gateway and live view"
(determinism, closed-form springs, the step timeline with thumbnails, "Clock": "The daemon stamps
every event and every incoming video chunk with its own monotonic clock"), "Interface" (Glance,
Watch and Replay), "Setup and operations" (`~/.localdot/` holds sessions: events, `observe`
screenshots, video, thumbnails), "Error handling", "Testing" ("End to end: … replay scrubbing; MP4
export") and "Repository" (mediabunny MPL-2.0). Research:
`/Volumes/Husky's SSD 4T/Projects/docs/superpowers/research/2026-09-30-localdot/visualization-ux.md`
§3.1 (recording, replay, export), §4.1, §4.9 and §4.11, with `dot-openai.md` §4.8 and
`grokbot-xai.md` §5.12 (neither ships a replay; "Scrubbable replay … Add retention controls and
export proof videos").

**Binding interfaces:**
- Part 3: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-10-01-localdot-core-part3.md`,
  "Interfaces Part 4 builds on": `EventLog.toSessionT`/`originOf`, `FrameStore`, `LiveSessions`,
  `foldEvents`/`sceneAt`/`cameraFor`, `PixiPresenter`, `WorkerIn`/`WorkerOut`, `StageHandle`,
  `useLiveSession`, `stepRows`, `StepRow`, `thumbnailUrl`.
- Part 2: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-10-01-localdot-core-part2.md`,
  "Interfaces Part 3 builds on": `CellOrchestrator.endpoints(id).stream`, `StreamEndpoint`,
  `STREAM_PING_MS`/`STREAM_STALL_MS`, `TopBar`'s disabled Replay, session metadata (Task 6b).

**Plan format:** M6 is an interface-and-test plan (`jobs/PLAN-WRITING.md`, "Plan format by
milestone"). Each task gives:
- exact interfaces, types, routes and on-disk formats;
- every test, by name, with its input and expected result;
- implementation notes covering the algorithm, constants and traps.

Production code appears in full only where an exact value is the point:
- the schemas;
- the byte formats (the Selkies video header, the journal record, the `mfra` box);
- the closed-form playback math;
- the synthetic H.264 test stream;
- the takeover privacy gate (Task 11, `full` review tier);
- every Review Focus pin and every security test.

**This is Part 7 of the core plan.** It runs right after Part 3 (M2), on branch `feat/core-part7`
created from Part 3's tip, and depends on nothing in M3–M5. Replay renders generically from the
event log and the recording: the agent and safety events that M4 and M5 will emit already have
schemas, and here they fold into typed timeline marks (Task 5). M5's takeover markers and M7's
second screen plug into the seams listed in "Interfaces later milestones build on". M9 ships before
M8, so M8's "what changed" flash is a seam only.

## Global Constraints

- Repo root: `/Volumes/Husky's SSD 4T/Projects/localdot`.
  - Work on branch `feat/core-part7`, created from the tip of `feat/core-part3`
    (`git switch -c feat/core-part7 feat/core-part3`). Never commit on `main`.
  - Quote the path in every shell command (it has a space and an apostrophe).
- Commit messages are conventional `type(scope): summary`. **Never add `Co-Authored-By` or any AI
  attribution line.** This is a user rule and overrides any harness default.
- **Never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container.** Containers get
  named volumes, `docker cp`, Docker's archive API or build contexts only. Runtime data lives in
  `~/.localdot` (`LOCALDOT_HOME` overrides). A session's files live in
  `<home>/sessions/<id>/`: `events.jsonl`, `session.json`, `summary.json`,
  `frames/<frameId>.webp`, `thumbs/<frameId>.webp` and `recording/` (Task 2 fixes the layout).
- Build paths from `fileURLToPath(import.meta.url)`, never `new URL(...).pathname`.
- Ports, all bound to `127.0.0.1`:
  - the daemon and UI on `4750` (`LOCALDOT_PORT` overrides), the brain's tool API on `4751`;
  - keyd listeners on `4760–4789`;
  - spikes and e2e harnesses on `4790–4799` (the e2e daemon on `4790`).

  Inside a cell: `desktopd` on `7700`, Selkies on `3000`. Nothing in Part 7 opens a port on a cell
  or changes a cell spec.
- Auth is cookie-free.
  - HTTP accepts the install token only as `Authorization: Bearer <token>`. Every Part 7 route sits
    under `/api/*`, behind the existing token middleware.
  - WebSocket clients always offer `localdot.v1` and `localdot.token.<token>` together, and the
    server selects only `localdot.v1`.
  - The recording, frames and thumbnails are fetched with the header: mediabunny's `UrlSource`
    gets `requestInit.headers.authorization`, and images become blob URLs. The token never goes
    in a URL.
  - The recorder reaches Selkies only through `endpoints(cellId).stream` (the gate's published
    port and the per-cell basic-auth credential), exactly as the stream proxy does.
- Secrets never enter a container, and every LLM call goes through keyd. Part 7 adds no secret and
  makes no LLM call. Recordings show surrogates, never real keys, because a cell holds no real key.
  Typed text stays masked at the source.
- Docker-backed suites:
  - they are `*.docker.test.ts`, run with `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker <file>`,
    **with no `--` before the file**;
  - they name everything they create `localdot-test-*` and remove it with `docker rm -fv` in
    `afterAll`;
  - every probe whose output a test checks also asserts its exit status;
  - no server runs on a Docker test's own thread (the Docker CLI helpers block it).

  Browser suites run with `pnpm --filter @localdot/web e2e`. The replay and export specs need **no
  Docker**: they replay a seeded session (Task 12). The recorded-puppet acceptance (Task 16) needs
  `LOCALDOT_DOCKER_TESTS=1`.
- Hygiene:
  - no [avatar-name] names or assets anywhere (`pnpm hygiene` enforces this);
  - no binary fixtures committed: test video is generated in code (`synthStream`, Task 4), test
    images with sharp;
  - nothing logs a token, a session title or a path under `$HOME`;
  - named exports only (default exports only in tool config files), small focused files, comments
    only for non-obvious rules;
  - relative imports with explicit `.ts`, workspace imports by package name;
  - run `pnpm format` before `pnpm lint`, and fix `organizeImports` with
    `pnpm exec biome check --write <files>`.
- Pinned toolchain: Node 24+ (host 25.6), pnpm 10.29.3, TypeScript 7.0.2, Biome 2.5.15,
  Vitest 5.0.3, Playwright 1.63.0 on system Chrome, **mediabunny exactly `1.61.0`**. mediabunny is
  never patched or forked, and is used unmodified (MPL-2.0 file-level copyleft; Task 3).
- The daemon is started with `node --import tsx src/main.ts` from `apps/daemon` by anything that
  must stop it. `pnpm … start` is a terminal convenience only.
- UI, under the Theatre direction:
  - follow `~/.agents/skills/apple-design/SKILL.md`: respond on pointer-down, track drags 1:1 from
    where they were grabbed (scrubber, compare wipe), make every animation interruptible from its
    current value, use critically damped springs, and honour `prefers-reduced-motion`,
    `prefers-reduced-transparency` and `prefers-contrast: more`;
  - near-black `--color-void`, and every colour is a token in `apps/web/src/theme.css`;
  - **no purple or violet, no gradients, no emoji**;
  - xenon `#3FB5DE` appears **only while the agent has control**. In replay that means the stage's
    rim and overlays at a replay time whose scene has `control`. The scrubber, ticks, chapters and
    controls stay neutral, and kinds are told apart by shape, weight and text, never by a new hue;
  - every UI task ends with a screenshot check of the rendered page.
- Determinism: the overlays are `sceneAt(model, t, view)` and nothing else. Render time has no
  `Math.random()` and no wall clock in the scene. Export renders by frame index, never by wall time.
- Tests: run only the suites a task touches (`pnpm exec vitest run <paths>`). Before the final
  review, run the full `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm hygiene`.

## Review Focus

Six inputs or failure modes most likely to bite a user, which no ordinary task test exercises. Each
gets a pinning test, written out in full in the task that owns it.

1. **Seek accuracy.** Scrubbing to any session time must show the frame that was on screen at that
   time, never the next one, and never one decoded without its key frame. The frame is the last
   frame whose arrival stamp is ≤ t, and decoding starts from the last key frame ≤ t. This must
   hold for a live (growing) recording as well as a finished one, at every frame boundary
   (`t_i`, `t_i + 1 µs`, the midpoint, `t_{i+1} − 1 µs`).
   - Pins: Task 8, "seek accuracy (Review Focus 1)" (packets, daemon side), and Task 13, "shows
     the frame on screen at any scrubbed time" (decoded pixels, in Chrome).
2. **A crash mid-recording.** A daemon killed with SIGKILL at an arbitrary frame must leave a
   recording whose every frame whose `push` resolved is present, in order, byte-identical, and
   seekable without reading the whole file.
   - Pin: Task 8, "a crash mid-recording (Review Focus 2)". It spawns a real child, SIGKILLs it at
     five points and recovers.
3. **Disk full.** ENOSPC in the middle of a session must stop the recording, never the session. The
   committed prefix must stay playable. The manifest says `disk-full` from that time on, and the
   recorder never starts below its free-space floor.
   - Pins: Task 8, "disk full (Review Focus 3), the writer"; Task 10, "disk full (Review Focus 3),
     the session".
4. **A 2-hour session's memory and CPU during scrub and export.**
   - Daemon:
     - the event log streams to the replay as NDJSON in bounded memory (Task 12, "streams a
       2-hour log in bounded memory");
     - the recording is served from disk by range (Task 12).
   - Stage: `sceneAt` stays cheap on a 2-hour model (Task 5, "a 2-hour session scene costs under
     0.2 ms").
   - Browser:
     - scrubbing a 2-hour recording holds at most three decoded frames and a bounded heap (Task 13,
       "scrubs a 2-hour session in bounded memory");
     - exporting one keeps the encoder queue and heap bounded (Task 15, "exports a 2-hour session
       in bounded memory").
5. **Overlay determinism across two renders.** Two separate loads of the same session must draw
   identical overlay pixels at the same replay time. Two exports of the same range must render
   identical frames before encoding.
   - Pins: Task 13, "draws the same overlays at the same time in two separate loads"; Task 15,
     "renders identical frames in two exports".
6. **Privacy of exported files and recordings.**
   - The recorder writes nothing while the user has control. It drops no agent frame and keeps no
     user frame, not even in the journal.
   - An exported MP4 carries no session id, title, home path, token, event log or `udta`/`meta`
     box, and is never uploaded anywhere.
   - Pins: Task 11, "records nothing while the user has control" (`full` tier); Task 15, "exports
     carry no identifying data and never leave the page".

## Where recording happens (summary of P7-R1)

The spec answers the question: "Timing is owned by the backend, not the viewer. It works with
zero, one or many viewers, and a replay renders exactly what the live view showed". It also says
"the daemon … taps the same stream for recording" and "The daemon stamps every event and every
incoming video chunk with its own monotonic clock". Glance mode, the default for tasks the user
doesn't watch, runs the gateway at Fast precisely because nobody is watching. Those are the
sessions a user most needs to replay. The three options compare as follows:

| | In the browser (WebCodecs → mediabunny → daemon) | In the daemon, from the Selkies stream (chosen) | In the cell |
|---|---|---|---|
| Records when nobody watches | **No**: no page, no frames | Yes | Yes |
| Records a hidden or throttled tab | Unreliable (rAF and timers throttle) | Yes | Yes |
| Extra CPU | A full re-encode in the viewer | ≈ 0: remux only (44 µs per frame measured, Node 24) | A second x264 encode at 2× (S1: 107–250 % container CPU already) |
| Clock | Viewer's, mapped | **Daemon's monotonic clock, the event log's own** | Cell's, mapped through `desktopd` pings |
| Trust | Trusted page | Trusted host process | **Untrusted cell writes the evidence of what the agent did** |
| Survives a cell reset | Yes | Yes (`~/.localdot`) | No (the recording lives in the cell) |

The daemon's recorder is one more Selkies client per live session. Spike S9 (Task 1) measures what
that client costs the cell (Q7) and confirms its handshake (Q1, Q2). If Selkies turns out to encode
per client and the cost is significant, the fallback is a contained change behind the recorder's
`FrameFeed` interface: tap an attached viewer's relay while one exists, and dial the cell only when
none does. That fallback is described in Task 9.

## Protocol events this plan relies on

Replay adds **no event type** and changes no event schema. It reads:

| Event | Used for |
|---|---|
| `session.start` (`screen`, `title`) | camera space, card title, timeline origin |
| `session.end` (`reason`) | duration, verdict, end of the playback map |
| `agent.state` | HUD, `scene.control` (rim, xenon), resting cursor |
| `step.start` / `step.end` | chapters, step rows as of t, before/after, step keys |
| `action.intent/target/dispatch/cancel/result`, `text.progress`, `screen.settle` | the overlays (Part 3's model, unchanged), ticks (click, type, key, cancel), busy spans |
| `observe` (`frameId`) | thumbnails, cover, hover previews, before/after, the no-video backdrop |
| `plan.set` / `plan.update` | the plan rail as of t (M4 emits them; without them the rail says "No plan") |
| `control.change` | **the recorder's privacy gate** (Task 11), takeover marks and "not recorded" gaps |
| `approval.request/resolve`, `pause.change`, `tool.start/end`, `file.change`, `memory.change`, `key.use`, `step.verify` | typed timeline marks through `markOf` (Task 5): the typed fallback for M4/M5 producers that don't exist yet |
| `heartbeat`, `thought.delta`, `tool.output`, `camera.hint` | ignored by replay (no mark; `thought.delta` and `tool.output` are too frequent to tick) |

Anything a later milestone adds to the `LocalDotEvent` union lands in `markOf`'s `default` branch.
It becomes a neutral mark labelled with its type until a later plan gives it its own row.

## File map

Created or modified in this part, as exact paths relative to the repo root:

```
spikes/s9-recorder/{package.json,probe.mjs,FINDINGS.md}                                  (Task 1)
packages/protocol/src/{recording.ts,recording.test.ts,index.ts}                          (Task 2)
THIRD-PARTY.md, apps/web/scripts/{notices.mjs,notices.test.mjs}, apps/web/package.json,
  apps/daemon/package.json, pnpm-lock.yaml                                               (Task 3)
packages/stage/src/testing/{h264-synth.ts,h264-synth.test.ts,index.ts}, packages/stage/package.json   (Task 4)
packages/stage/src/{model.ts,scene.ts,marks.ts,marks.test.ts,long-session.test.ts,index.ts}           (Task 5)
packages/stage/src/replay/{playback-map.ts,clock.ts,busy.ts,timeline.ts,*.test.ts,index.ts}           (Task 6)
apps/daemon/src/recorder/{boxes.ts,journal.ts,writer.ts,boxes.test.ts,journal.test.ts,writer.test.ts}  (Task 7)
apps/daemon/src/recorder/{recover.ts,view.ts,recover.test.ts,seek.test.ts,crash.test.ts,
  diskfull-writer.test.ts,testing/crash-child.ts,testing/full-fs.ts}                     (Task 8)
apps/daemon/src/recorder/{wire.ts,annexb.ts,feed.ts,wire.test.ts,feed.test.ts,testing/fake-selkies.ts} (Task 9)
apps/daemon/src/recorder/{session-recorder.ts,recorder.ts,disk.ts,manifest.ts,
  session-recorder.test.ts,recorder.test.ts}, apps/daemon/src/gateway/live.ts, apps/daemon/src/main.ts (Task 10)
apps/daemon/src/recorder/{control-gate.ts,control-gate.test.ts}                          (Task 11)
apps/daemon/src/sessions/{summary.ts,index-store.ts,ndjson.ts,thumbs.ts,retention.ts,routes.ts,
  *.test.ts}, apps/daemon/src/event-log.ts, apps/daemon/src/app.ts,
  apps/daemon/src/recorder/testing/seed-session.ts, apps/daemon/src/seed-main.ts         (Task 12)
apps/web/src/replay/{recording-source.ts,replay-video.ts,decode-policy.ts,decode-policy.test.ts,
  backdrop.ts}, apps/web/src/stage/{render-worker.ts,worker-protocol.ts,StageCanvas.tsx,Stage.tsx},
  apps/web/e2e/{seed.ts,replay-pins.spec.ts}                                            (Task 13)
apps/web/src/replay/{useReplay.ts,replay-view.ts,replay-view.test.ts,ReplayView.tsx,Scrubber.tsx,
  ReplayControls.tsx,CompareView.tsx,SessionsRail.tsx}, apps/web/src/shell/{TopBar.tsx,PlanRail.tsx,
  StepRow.tsx}, apps/web/src/App.tsx, apps/web/src/app.css, apps/web/src/theme.css,
  apps/web/e2e/replay-ui.spec.ts                                                         (Task 14)
apps/web/src/export/{export-worker.ts,export-protocol.ts,exporter.ts,export-plan.ts,
  export-plan.test.ts,sink.ts,ExportSheet.tsx}, apps/web/e2e/export.spec.ts               (Task 15)
apps/web/e2e/recorded-session.spec.ts, README.md, docs/replay.md                         (Task 16)
```

---
