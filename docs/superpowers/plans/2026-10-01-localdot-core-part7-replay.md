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

### Task 1: Spike S9 — the recorder's view of the Selkies stream

The recorder is one more Selkies client, which nothing so far has run headless. S8 ran Selkies'
own client in a page, and Part 3's Task 11 ran two of them. This spike answers the questions the
recorder's constants rest on, on the real image, before any recorder code exists (risk first, as
S8 did for Part 2).

**Review tier:** light (throwaway spike code. It reuses the per-cell stream credential the proxy
already holds, and adds no boundary).

**Files:**
- Create: `spikes/s9-recorder/package.json` (`ws` 8.22.0, already in the lockfile),
  `spikes/s9-recorder/probe.mjs`, `spikes/s9-recorder/endpoint.ts`,
  `spikes/s9-recorder/run-desktop.sh`, `spikes/s9-recorder/FINDINGS.md`

**Interfaces:**
- Consumes:
  - the image `localdot/desktop:dev` (Part 3's);
  - `CellOrchestrator.endpoints(id).stream` (`{ baseUrl, authorization }`, Part 2);
  - the vendored client `apps/web/vendor/selkies/assets/selkies-core-*.js` as the protocol
    reference;
  - `parseSelkiesMessage` (Task 9 writes it; the spike carries its own 15-line copy).
- Produces: `FINDINGS.md`, whose answers fix four values in Task 9 and Task 10:
  - `RECORDER_HANDSHAKE` (the text messages the recorder sends);
  - `KEYFRAME_EVERY_MS`, and whether `REQUEST_KEYFRAME` is needed at all;
  - `IDLE_KEYFRAME` (whether a key frame can be had on a still screen);
  - `FEED_MODE` (`own-connection` or `tap-viewer`).

**The probe** (`probe.mjs`):
- Takes `--endpoint <http://127.0.0.1:port>`, `--authorization "<header>"`, `--seconds <n>`,
  `--mode shared|primary` and `--request-key <ms|off>`.
- Dials `<endpoint>/api/websockets` with the header and `perMessageDeflate: false`. Selkies' client
  uses no subprotocol.
- Logs every text message with its arrival time.
- For binary messages, logs `type`, `flags`, `frameId`, `region`, `width`, `height`, payload bytes,
  key or not, and the NAL types of the payload.
- Writes a summary JSON: frames, key frames, the inter-key intervals, bytes per second, the first
  frame's latency after the handshake, and the latency from each `REQUEST_KEYFRAME` sent to the
  next key frame.
- **It never writes a payload to the repo.** An optional `--dump <dir outside the repo>` keeps the
  raw access units for manual decoding with ffmpeg.

`endpoint.ts` prints a cell's stream endpoint and authorization. It reads
`<home>/cells/<id>/cell.json` through Part 2's `CellStore` and asks Docker for the gate's
published `8082/tcp` port (`docker port localdot-gate-<id> 8082/tcp`, asserting exit status 0), so
the probe dials exactly what the proxy dials. `run-desktop.sh` is S8's script with the container
named `localdot-test-s9` and the stream on `127.0.0.1:4793`. It is used for the questions that need
no daemon.

**Questions** (each answered in `FINDINGS.md` with the raw numbers):
- Q1 **Handshake, alone.** With no other client, does the passive "shared viewer" sequence produce
  video? The sequence is the vendored client's `#shared` path: wait for the text `MODE websockets`,
  send `STOP_VIDEO`, wait 250 ms, send `START_VIDEO`, and never send `SETTINGS,…`,
  `CLIENT_FRAME_ACK`, `_gz,1` or input. If not, find the smallest addition that does (for example
  `SETTINGS,{}`, or the primary's settings object). Record the exact messages and the time to the
  first key frame.
- Q2 **Handshake beside a viewer.** With the Theatre open on the same cell (one Selkies primary),
  start and stop the probe 10 times. The viewer's `data-size` must never change, its `data-fps`
  must not drop, and the probe's `frameId`s must match the viewer's. Check the second by logging the
  viewer relay's frame ids for 10 s with a temporary `console.log` in a local, uncommitted copy of
  `stream-proxy.ts`.
- Q3 **Wire header.** Byte 0 is `4`, the codec nibble is `1` (H.264), the low nibble is `1` exactly
  on frames whose payload holds an IDR, `width`×`height` is 2560×1600 at 2× and 1280×800 at 1×, and
  `region` is always 0 with `h264enc`.
- Q4 **Key frames.** Does every key payload carry SPS and PPS in-band (NAL types 7, 8, 5)? Record
  the codec string from the SPS (expect `avc1.f4….` at 4:4:4 and `avc1.64….` with
  `LOCALDOT_STREAM_FULLCOLOR=0`), and confirm with `ffprobe` on a dumped access unit that it
  decodes.
- Q5 **`REQUEST_KEYFRAME`.**
  - During `load-continuous.sh` motion: the latency to the next IDR (p50 and max over 50 requests).
  - On a still screen: does an IDR arrive at all, and how fast?
- Q6 **Selkies' own cadence.** Without requests, the intervals between key frames over 60 s of
  continuous motion and over 5 minutes of mostly still screen.
- Q7 **Cost.** The container CPU (`docker stats`, as S1 measured it) at 2× under
  `load-continuous.sh`, in three runs: one Theatre viewer; one viewer plus the probe; the probe
  alone. Then decide the feed mode:
  - if "viewer + probe" exceeds "viewer" by more than 10 percentage points of a core (Selkies
    encodes per client), `FEED_MODE = tap-viewer`;
  - otherwise `own-connection`.
- Q8 **Backpressure.** Over 60 s of continuous motion, the probe, which sends no acks, receives at
  least 98 % of the frames the acking viewer receives (compare the frame-id ranges).

**Gate:**
- If Q1 finds no handshake that yields video without disturbing a viewer (Q2), stop and report
  BLOCKED with the transcripts. Every later recorder task depends on it.
- If Q5 shows that `REQUEST_KEYFRAME` has no effect, set `KEYFRAME_EVERY_MS` to `0` (never
  request), and record the seek cost Selkies' own cadence (Q6) gives. Task 13's decode policy
  copes with long GOPs; only the seek latency grows.

- [ ] **Step 1:** Write `probe.mjs`, `endpoint.ts` and `run-desktop.sh` as specified. Then run
  `node spikes/s9-recorder/probe.mjs --help`.
  Expected: usage text and exit 0.
- [ ] **Step 2:** Run Q1, Q3, Q4 and Q6 against `run-desktop.sh` at 2× and at 1×.
- [ ] **Step 3:** Run Q2, Q5, Q7 and Q8 against a daemon cell with the Theatre open in Chrome
  (start the daemon with `node --import tsx src/main.ts`).
- [ ] **Step 4:** Write `FINDINGS.md`. Its header gives the date, the Mac, Docker, the image digest
  and the Chrome version. It answers Q1–Q8, then lists the four values above. Clean up:
  `docker rm -fv localdot-test-s9` (exit 0) and stop the daemon. No `localdot-test-*` container is
  left.
- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add spikes/s9-recorder
git commit -m "chore(spikes): S9 the recorder's view of the Selkies stream"
```

---

### Task 2: Protocol — the recording layout and the replay API schemas

The on-disk format of a recording, and the JSON the daemon serves about sessions and recordings.
Both the daemon and the web app parse these, and later milestones read the layout (M9's `doctor`
and retention settings).

**Review tier:** light (schemas; no boundary).

**Files:**
- Create: `packages/protocol/src/recording.ts`, `packages/protocol/src/recording.test.ts`
- Modify: `packages/protocol/src/index.ts` (add `export * from "./recording.ts";`)

**Interfaces:**
- Consumes: `ULID_PATTERN` (`packages/protocol/src/ids.ts`), zod 4.6.5.
- Produces the constants, schemas and types below. The JSON Schema export for keyd
  (`events.schema.json`) does not change: keyd reads none of these.

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/recording.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { emptyManifest, FragmentEntry, RecordingManifest, SessionCard } from "./recording.ts";

describe("recording schemas", () => {
  it("accepts an empty manifest and a full one, and rejects a reversed span and a bad codec", () => {
    expect(RecordingManifest.parse(emptyManifest("none", "no stream"))).toMatchObject({ state: "none", note: "no stream" });
    const full = { ...emptyManifest("complete"), codec: "avc1.f4001f", width: 2560, height: 1600, firstMicros: 312_000, lastMicros: 9_000_000, bytes: 1234, fragments: 3, activity: [{ from: 312_000, to: 900_000 }], gaps: [{ from: 1_000_000, to: 2_000_000, reason: "user-control" as const }] };
    expect(RecordingManifest.parse(full).codec).toBe("avc1.f4001f");
    expect(() => RecordingManifest.parse({ ...full, activity: [{ from: 5, to: 4 }] })).toThrow();
    expect(() => RecordingManifest.parse({ ...full, codec: "avc1.F4001F; rm -rf" })).toThrow();
    expect(() => FragmentEntry.parse({ seq: 0, moofOffset: 0, endOffset: 1, startMicros: 0, endMicros: 1 })).toThrow();
  });

  it("validates a session card and refuses an id that is not a ULID", () => {
    const card = { id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", title: null, startedAt: "2026-10-02T10:00:00.000Z", durationMs: 1000, verdict: "done", steps: 2, failedSteps: 0, coverFrameId: null, screen: { w: 2560, h: 1600, scale: 2 }, recording: { state: "complete", bytes: 10 } };
    expect(SessionCard.parse(card).verdict).toBe("done");
    expect(() => SessionCard.parse({ ...card, id: "../../etc" })).toThrow();
  });
});
```

Run: `pnpm exec vitest run packages/protocol/src/recording.test.ts`
Expected: FAIL. `./recording.ts` does not exist.

- [ ] **Step 2: Write the schemas**

`packages/protocol/src/recording.ts` (complete, because this is the format):
```ts
import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

// On-disk layout of one session's recording, under <home>/sessions/<id>/ (P7-R2):
//   recording/video.mp4         fragmented MP4, one H.264 track, one GOP per fragment, ticks = session µs
//   recording/fragments.jsonl   one FragmentEntry per committed fragment, appended after its bytes
//   recording/journal/<µs>.bin  the open fragment's frames, one file per GOP (deleted once committed)
//   recording/manifest.json     RecordingManifest, replaced atomically (temp file + rename)
export const RECORDING_DIR = "recording";
export const RECORDING_VIDEO = "video.mp4";
export const RECORDING_FRAGMENTS = "fragments.jsonl";
export const RECORDING_MANIFEST = "manifest.json";
export const RECORDING_JOURNAL = "journal";
export const SESSION_SUMMARY = "summary.json";
export const SESSION_THUMBS = "thumbs";

// Media time is session time: one tick per session microsecond (the envelope's `t` unit).
export const MEDIA_TIMESCALE = 1_000_000;

const Micros = z.number().int().nonnegative();
const Ulid = z.string().regex(ULID_PATTERN);

export const RecordingState = z.enum(["recording", "complete", "recovered", "failed", "expired", "none"]);
export type RecordingState = z.infer<typeof RecordingState>;

export const RecordingGapReason = z.enum(["user-control", "stream-lost", "disk-full", "size-cap", "recorder-error"]);
export type RecordingGapReason = z.infer<typeof RecordingGapReason>;

// A stretch of session time with no video on purpose or by failure; `to` is null while it lasts
// or when the recording ended inside it.
export const RecordingGap = z.object({ from: Micros, to: Micros.nullable(), reason: RecordingGapReason });
export type RecordingGap = z.infer<typeof RecordingGap>;

// Frames flowed: arrivals closer than ACTIVITY_JOIN_MICROS are one span (skip idle reads these).
export const ACTIVITY_JOIN_MICROS = 500_000;
export const ActivitySpan = z
  .object({ from: Micros, to: Micros })
  .refine((s) => s.to >= s.from, { message: "an activity span ends after it starts" });
export type ActivitySpan = z.infer<typeof ActivitySpan>;

export const RecordingManifest = z.object({
  v: z.literal(1),
  state: RecordingState,
  codec: z.string().regex(/^avc1\.[0-9a-f]{6}$/).nullable(),
  width: z.number().int().positive().max(16_384).nullable(),
  height: z.number().int().positive().max(16_384).nullable(),
  firstMicros: Micros.nullable(),
  lastMicros: Micros.nullable(),
  bytes: z.number().int().nonnegative(),
  fragments: z.number().int().nonnegative(),
  activity: z.array(ActivitySpan).max(200_000),
  gaps: z.array(RecordingGap).max(10_000),
  note: z.string().max(200).optional(),
});
export type RecordingManifest = z.infer<typeof RecordingManifest>;

export const FragmentEntry = z.object({
  seq: z.number().int().positive(),
  moofOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  startMicros: Micros,
  endMicros: Micros,
});
export type FragmentEntry = z.infer<typeof FragmentEntry>;

export function emptyManifest(state: RecordingState, note?: string): RecordingManifest {
  return {
    v: 1, state, codec: null, width: null, height: null, firstMicros: null, lastMicros: null,
    bytes: 0, fragments: 0, activity: [], gaps: [], ...(note ? { note } : {}),
  };
}

// The session index (GET /api/session-index) and one session's recording (GET /api/sessions/:id/recording).
export const SessionVerdict = z.enum(["live", "done", "stopped", "error", "interrupted"]);
export type SessionVerdict = z.infer<typeof SessionVerdict>;

export const SessionCard = z.object({
  id: Ulid,
  title: z.string().max(200).nullable(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative().nullable(),
  verdict: SessionVerdict,
  steps: z.number().int().nonnegative(),
  failedSteps: z.number().int().nonnegative(),
  coverFrameId: Ulid.nullable(),
  screen: z.object({ w: z.number().int().positive(), h: z.number().int().positive(), scale: z.number().positive() }).nullable(),
  recording: z.object({ state: RecordingState, bytes: z.number().int().nonnegative() }),
});
export type SessionCard = z.infer<typeof SessionCard>;

export const SessionIndexPage = z.object({ sessions: z.array(SessionCard), next: z.string().nullable() });
export type SessionIndexPage = z.infer<typeof SessionIndexPage>;

export const RecordingInfo = z.object({
  manifest: RecordingManifest,
  live: z.boolean(),
  // The snapshot GET …/recording/video.mp4?upto=<fragments> serves: committed fragments only.
  upto: z.number().int().nonnegative(),
  servedBytes: z.number().int().nonnegative(),
});
export type RecordingInfo = z.infer<typeof RecordingInfo>;
```

Run: `pnpm exec vitest run packages/protocol && pnpm --filter @localdot/protocol typecheck`
Expected: PASS. The two new tests pass, and every existing protocol test still does.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint
git add packages/protocol
git commit -m "feat(protocol): recording layout, manifest and session index schemas"
```

**Acceptance:** `pnpm exec vitest run packages/protocol` passes. `pnpm typecheck` is clean.

---

### Task 3: mediabunny, pinned, with its MPL-2.0 notice

**Review tier:** light (dependency and notices).

**Files:**
- Modify: `apps/daemon/package.json` (`"mediabunny": "1.61.0"`, `"sharp": "0.35.5"` in
  `dependencies`), `apps/web/package.json` (`"mediabunny": "1.61.0"` in `dependencies`; `"build"`
  becomes `"vite build && node scripts/notices.mjs"`), `pnpm-lock.yaml`
- Create: `THIRD-PARTY.md`, `apps/web/scripts/notices.mjs`, `apps/web/scripts/notices.test.mjs`

**Interfaces:**
- Produces:
  - `writeNotices({ webDir, outDir }): { files: string[] }` (exported from `notices.mjs`). It
    writes `<outDir>/licenses/mediabunny-1.61.0.txt`: a header naming the package, its exact
    version, its license and where to get its Source Code Form, followed by mediabunny's own
    `LICENSE` text, unchanged.
  - `notices.mjs` writes into `dist/assets/licenses/`, so the daemon's existing `/assets/*` route
    serves the notice as `/assets/licenses/mediabunny-1.61.0.txt` with no new route.

**MPL-2.0 handling (P7-R13):**
- mediabunny's files are used unmodified. No `pnpm patch`, no vendored copy, no fork. MPL-2.0's
  copyleft is per file, so it covers mediabunny's files and nothing of ours.
- The daemon runs it from `node_modules` (Source Code Form, with its `LICENSE`).
- The web build minifies it into localDot's chunks (Executable Form). MPL-2.0 §3.2(a) asks that the
  recipients of an Executable Form be told how to get the Source Code Form. The notice file does
  this, pointing at the npm tarball `mediabunny@1.61.0` and the upstream tag `v1.61.0` at
  `https://github.com/Vanilagy/mediabunny`, and carries the license text (§3.2(b) permits our own
  MIT terms for the larger work).
- `THIRD-PARTY.md` (repo root) lists mediabunny (MPL-2.0, 1.61.0, used unmodified, notice shipped
  with the UI build), next to the existing entries' pointers: Selkies' client notice in
  `apps/web/vendor/selkies/NOTICE.md`, and the cell's list in `cells/desktop/THIRD-PARTY.md`.

**Tests** (`apps/web/scripts/notices.test.mjs`; the file is not under `src`, so add
`"apps/*/scripts/**/*.test.mjs"` to the root `vitest.config.ts`'s `include`):
- `"writes the mediabunny notice with the license text, version and source location"`:
  - `writeNotices` into a temp dir;
  - the file exists and contains `Mozilla Public License Version 2.0`, `mediabunny 1.61.0` and
    `https://github.com/Vanilagy/mediabunny`.
- `"pins mediabunny exactly and never patches it"`:
  - `apps/web/package.json` and `apps/daemon/package.json` both say exactly `"1.61.0"`;
  - the root `package.json` has no `pnpm.patchedDependencies` entry for it;
  - `pnpm-lock.yaml` resolves `mediabunny@1.61.0` and no other version.

**Implementation notes:**
- `notices.mjs` resolves mediabunny's `LICENSE` with
  `createRequire(join(webDir, "package.json")).resolve("mediabunny/package.json")`. mediabunny's
  `exports` doesn't list `package.json`, so resolve `mediabunny` itself and walk up to the folder
  holding `LICENSE`. Its `package.json` field `"license"` must read `MPL-2.0`, or the script exits
  1, so a relicensed upgrade cannot slip through.
- The header is plain text with no build timestamp, so the build stays reproducible.

- [ ] **Step 1:** Write the failing notices test. Run
  `pnpm exec vitest run apps/web/scripts/notices.test.mjs`.
  Expected: FAIL (no `notices.mjs`).
- [ ] **Step 2:** Add the dependencies (`pnpm install`), `notices.mjs` and `THIRD-PARTY.md`. Run
  the test (PASS), then `pnpm --filter @localdot/web build` and
  `ls apps/web/dist/assets/licenses/`.
  Expected: `mediabunny-1.61.0.txt`.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint
git add THIRD-PARTY.md apps/web/package.json apps/web/scripts apps/daemon/package.json pnpm-lock.yaml vitest.config.ts
git commit -m "chore(deps): pin mediabunny 1.61.0 with its MPL-2.0 notice"
```

**Acceptance:** the notices test passes, the build ships the notice, and `pnpm hygiene` is clean.

---

### Task 4: Test media — a synthetic H.264 stream that proves what was decoded

Every recorder, replay and export test needs real H.264, with no encoder in Node and no binary
fixture in the repo. This generator writes a valid Constrained Baseline stream whose every coded
macroblock is I_PCM, so the samples are exact. Frame k of a GOP paints macroblock k − 1 white and
skips the rest. So a decoder shows the right picture only if it decoded forward from the key frame,
and `frameOfLuma` reads the frame index back from the decoded picture. It was verified while
writing this plan: ffmpeg decodes all 60 frames of a 128×128, 20-frame-GOP stream, and
`frameOfLuma` names every one correctly.

**Review tier:** light (test helper).

**Files:**
- Create: `packages/stage/src/testing/h264-synth.ts`, `packages/stage/src/testing/h264-synth.test.ts`,
  `packages/stage/src/testing/index.ts` (`export * from "./h264-synth.ts";`)
- Modify: `packages/stage/package.json` (`"exports": { ".": "./src/index.ts", "./testing": "./src/testing/index.ts" }`)

**Interfaces:**
- Produces: `SYNTH_WHITE = 235`, `SYNTH_CODEC = "avc1.42C01E"`,
  `SynthOptions { widthMbs; heightMbs; keyEvery }`, `SynthFrame { index; key; data }`,
  `keyLevel(gop)`, `synthFrame(o, index)`, `synthStream(o, count)`, `frameOfLuma(o, mbLuma)`.
  The daemon's recorder tests import it as `@localdot/stage/testing`, and so do the seeder
  (Task 12) and the browser e2e (Task 13).

- [ ] **Step 1: Write the failing test**

`packages/stage/src/testing/h264-synth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { frameOfLuma, keyLevel, SYNTH_WHITE, synthFrame, synthStream } from "./h264-synth.ts";

const o = { widthMbs: 8, heightMbs: 8, keyEvery: 20 };
const nalTypes = (au: Uint8Array) => {
  const t: number[] = [];
  for (let i = 0; i + 3 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) t.push((au[i + 3] ?? 0) & 0x1f);
  return t;
};
// What a decoder must show for frame i: the GOP's level, with the first p macroblocks white.
const expectedLuma = (i: number) => {
  const p = i % o.keyEvery;
  return Array.from({ length: 64 }, (_, mb) => (mb < p ? SYNTH_WHITE : keyLevel(Math.floor(i / o.keyEvery))));
};

describe("synthetic H.264", () => {
  it("starts each GOP with SPS, PPS and an IDR, and codes other frames as one P slice", () => {
    expect(nalTypes(synthFrame(o, 0).data)).toEqual([7, 8, 5]);
    expect(nalTypes(synthFrame(o, 20).data)).toEqual([7, 8, 5]);
    expect(nalTypes(synthFrame(o, 7).data)).toEqual([1]);
    expect(synthStream(o, 41).filter((f) => f.key).map((f) => f.index)).toEqual([0, 20, 40]);
  });

  it("never leaves a start-code prefix inside a NAL payload", () => {
    for (const f of synthStream(o, 40)) {
      const payloads = Buffer.from(f.data).toString("hex").split("00000001").slice(1);
      expect(payloads).toHaveLength(nalTypes(f.data).length);
      // 00 00 0x (x ≤ 3) at a byte boundary inside a payload would read as a start code.
      for (const hex of payloads) expect(/^(?:..)*?00000[0-3]/.test(hex)).toBe(false);
    }
  });

  it("reads the frame index back from the decoded picture", () => {
    for (const i of [0, 1, 19, 20, 21, 39, 59]) expect(frameOfLuma(o, expectedLuma(i))).toBe(i);
  });

  it("refuses a GOP longer than the picture has macroblocks", () => {
    expect(() => synthFrame({ widthMbs: 2, heightMbs: 2, keyEvery: 6 }, 0)).toThrow(RangeError);
  });
});
```

Run: `pnpm exec vitest run packages/stage/src/testing`
Expected: FAIL. The module does not exist.

- [ ] **Step 2: Write the generator**

`packages/stage/src/testing/h264-synth.ts` (complete: the bitstream is the point):
```ts
// A tiny, valid H.264 Constrained Baseline stream for tests, with no encoder: every coded
// macroblock is I_PCM, so a decoded frame carries exact sample values. A key frame fills the
// picture with its GOP's level; the p-th frame after it paints macroblock p − 1 white and skips
// the rest, so only a decoder that ran forward from the key frame shows the right picture, and
// the picture tells which frame it is (`frameOfLuma`).

export const SYNTH_WHITE = 235;
export const SYNTH_CODEC = "avc1.42C01E";

export interface SynthOptions {
  widthMbs: number;
  heightMbs: number;
  keyEvery: number;
}

export interface SynthFrame {
  index: number;
  key: boolean;
  data: Uint8Array;
}

export function keyLevel(gop: number): number {
  return 16 + ((gop * 29) % 190);
}

class Bits {
  readonly bytes: number[] = [];
  #cur = 0;
  #n = 0;

  u(bits: number, value: number): void {
    for (let i = bits - 1; i >= 0; i--) this.bit((value >>> i) & 1);
  }

  bit(b: number): void {
    this.#cur = (this.#cur << 1) | b;
    this.#n += 1;
    if (this.#n === 8) {
      this.bytes.push(this.#cur);
      this.#cur = 0;
      this.#n = 0;
    }
  }

  ue(value: number): void {
    const v = value + 1;
    const len = 32 - Math.clz32(v);
    this.u(len - 1, 0);
    this.u(len, v);
  }

  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  align(): void {
    while (this.#n !== 0) this.bit(0);
  }

  trailing(): Uint8Array {
    this.bit(1);
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

// Annex B start code, NAL header, and the RBSP with emulation-prevention bytes.
function nal(refIdc: number, type: number, rbsp: Uint8Array): Uint8Array {
  const out = [0, 0, 0, 1, (refIdc << 5) | type];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

// profile 66, constraint_set0+1, level 3.0; sps 0; log2_max_frame_num 4; POC type 2; one reference
// frame; frame_mbs_only; direct_8x8_inference; no cropping, no VUI.
function sps(o: SynthOptions): Uint8Array {
  const b = new Bits();
  b.u(8, 66);
  b.u(8, 0xc0);
  b.u(8, 30);
  b.ue(0);
  b.ue(0);
  b.ue(2);
  b.ue(1);
  b.bit(0);
  b.ue(o.widthMbs - 1);
  b.ue(o.heightMbs - 1);
  b.bit(1);
  b.bit(1);
  b.bit(0);
  b.bit(0);
  return nal(3, 7, b.trailing());
}

// CAVLC, one slice group, one reference index, QP 26, deblocking control present.
function pps(): Uint8Array {
  const b = new Bits();
  b.ue(0);
  b.ue(0);
  b.bit(0);
  b.bit(0);
  b.ue(0);
  b.ue(0);
  b.ue(0);
  b.bit(0);
  b.u(2, 0);
  b.se(0);
  b.se(0);
  b.se(0);
  b.bit(1);
  b.bit(0);
  b.bit(0);
  return nal(3, 8, b.trailing());
}

function pcm(b: Bits, luma: number): void {
  b.align();
  for (let i = 0; i < 256; i++) b.u(8, luma);
  for (let i = 0; i < 128; i++) b.u(8, 128);
}

// IDR I slice: every macroblock I_PCM (mb_type 25) at the GOP's level; deblocking off.
function idr(o: SynthOptions, gop: number): Uint8Array {
  const b = new Bits();
  b.ue(0);
  b.ue(7);
  b.ue(0);
  b.u(4, 0);
  b.ue(gop % 2);
  b.bit(0);
  b.bit(0);
  b.se(0);
  b.ue(1);
  for (let mb = 0; mb < o.widthMbs * o.heightMbs; mb++) {
    b.ue(25);
    pcm(b, keyLevel(gop));
  }
  return nal(3, 5, b.trailing());
}

// P slice: skip to macroblock `mb`, paint it white as I_PCM (mb_type 5 + 25), skip the rest.
function paint(o: SynthOptions, frameNum: number, mb: number): Uint8Array {
  const total = o.widthMbs * o.heightMbs;
  const b = new Bits();
  b.ue(0);
  b.ue(5);
  b.ue(0);
  b.u(4, frameNum % 16);
  b.bit(0);
  b.bit(0);
  b.bit(0);
  b.se(0);
  b.ue(1);
  b.ue(mb);
  b.ue(30);
  pcm(b, SYNTH_WHITE);
  if (mb < total - 1) b.ue(total - 1 - mb);
  return nal(2, 1, b.trailing());
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export function synthFrame(o: SynthOptions, index: number): SynthFrame {
  if (o.keyEvery < 1 || o.keyEvery > o.widthMbs * o.heightMbs + 1) {
    throw new RangeError("keyEvery must leave a macroblock for every frame of a GOP");
  }
  const gop = Math.floor(index / o.keyEvery);
  const p = index % o.keyEvery;
  if (p === 0) return { index, key: true, data: concat([sps(o), pps(), idr(o, gop)]) };
  return { index, key: false, data: paint(o, p, p - 1) };
}

export function synthStream(o: SynthOptions, count: number): SynthFrame[] {
  return Array.from({ length: count }, (_, i) => synthFrame(o, i));
}

// The frame a decoded picture shows, from the mean luma of each macroblock (row-major).
export function frameOfLuma(o: SynthOptions, mbLuma: number[]): number {
  const white = mbLuma.filter((v) => Math.abs(v - SYNTH_WHITE) <= 2).length;
  const base = mbLuma.find((v) => Math.abs(v - SYNTH_WHITE) > 2);
  if (base === undefined) throw new Error("every macroblock is white: the GOP is longer than the picture");
  for (let gop = 0; gop < 4096; gop++) {
    if (Math.abs(keyLevel(gop) - base) <= 2) return gop * o.keyEvery + white;
  }
  throw new Error(`no GOP has level ${base}`);
}
```

Run: `pnpm exec vitest run packages/stage/src/testing`
Expected: PASS (4 tests).

**Implementation notes:**
- `keyLevel` repeats every 190 GOPs. `frameOfLuma` returns the first GOP with that level, so a test
  that reads frame indices back must keep its GOP count under 190, or compare modulo
  `190 × keyEvery`. Task 13 compares modulo.
- `keyEvery` may not exceed the macroblock count plus one. A 20×12-macroblock seeded video
  (320×192) allows GOPs of up to 241 frames.
- The stream decodes in Chrome's WebCodecs (Constrained Baseline). Task 13's e2e is the in-browser
  proof. In Node the tests check structure only.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint
git add packages/stage
git commit -m "test(stage): synthetic H.264 that tells which frame was decoded"
```

**Acceptance:** `pnpm exec vitest run packages/stage` passes. `pnpm --filter @localdot/stage typecheck`
is clean.

---

### Task 5: Stage — the replay model: observes, steps, plans, typed marks and an index for long sessions

Part 3's model folds actions and agent states. Replay also needs four things:
- the observe frames by time (thumbnails, before/after, the no-video backdrop);
- the steps with their start and end (chapters, the rail as of t);
- plan snapshots (the plan as of t);
- typed marks for every agent and safety event that has no overlay. This is the "typed fallback"
  for M4 and M5 producers that don't exist yet.

Part 3 left two linear scans per frame (`model.actions.filter(...)` in `sceneAt`, and `current()`
scanning back by step) and named them as M6's job ("index by step"). On a dense 2-hour log (12 000
actions, 138 000 events), `sceneAt` measured **0.99 ms per call** with Part 3's code while this plan
was written: 6 % of a 60 fps frame live, and 54 s of pure scene time in a 54 000-frame export.
The index brings it to microseconds.

**Review tier:** light (stage model).

**Files:**
- Create: `packages/stage/src/marks.ts`, `packages/stage/src/marks.test.ts`,
  `packages/stage/src/long-session.test.ts`
- Modify: `packages/stage/src/model.ts`, `packages/stage/src/scene.ts`, `packages/stage/src/index.ts`
  (add `export * from "./marks.ts";`)
- Test: Part 3's `model.test.ts`, `scene.test.ts` and `camera.test.ts` must pass unchanged.

**Interfaces:**
- Consumes: Part 3's `SessionModel`, `ActionState`, `foldEvents`, `sceneAt`, `restingPoint`,
  `clipText`, `sessionMsOf`; Task 15's `SessionModel.frames` (Part 3 Task 15).
- Produces (exact):

```ts
// packages/stage/src/model.ts — added to the model; every time is session ms
export interface ObserveAt { t: number; frameId: string; step?: string }
export interface StepState { id: string; kind: string; startT: number; endT?: number; status?: string; planItem?: string }
export interface PlanItemState { id: string; text: string; status: string }
export interface PlanSnapshot { t: number; items: PlanItemState[] }

export interface SessionModel {
  // … Part 3's fields, unchanged, plus:
  observes: ObserveAt[];          // every observe, in log order
  steps: StepState[];             // one per step.start, closed by its step.end
  plans: PlanSnapshot[];          // after every plan.set and plan.update
  marks: TimelineMark[];          // markOf(e) for every event Part 3's switch does not handle
  byStep: Map<string, number>;    // step id → index of its latest action (current() is O(1))
  stepIndex: Map<string, number>; // step id → index in steps
}
export function startedCount(model: SessionModel, t: number): number;   // actions with intentT ≤ t, binary search
export function observeAt(model: SessionModel, t: number): ObserveAt | undefined;
export function stepAt(model: SessionModel, t: number): StepState | undefined;
export function planAt(model: SessionModel, t: number): PlanItemState[];

// packages/stage/src/scene.ts
export const RING_LOOKBACK = 8;
export interface SceneOptions { ringLookback?: number }
export function sceneAt(model: SessionModel, t: number, view: View, opts?: SceneOptions): Scene;  // same Scene as Part 3

// packages/stage/src/marks.ts
export type MarkKind = "approval" | "decision" | "takeover" | "handback" | "pause" | "resume" | "tool" | "tool-failed" | "file" | "memory" | "key" | "verify" | "event";
export type MarkTone = "neutral" | "attention" | "failure" | "user";
export interface TimelineMark { t: number; seq: number; kind: MarkKind; type: string; step?: string; label: string; tone: MarkTone }
export function markOf(e: LocalDotEvent): TimelineMark | null;
```

**`markOf`**, exactly. Labels are clipped with `clipText`. "dot" is `CURSOR_NAME`.

| Event | kind | label | tone |
|---|---|---|---|
| `approval.request` | approval | `Asked to approve: <title, 60>` | attention |
| `approval.resolve` by `timeout` | decision | `Denied after 10 minutes` | failure |
| `approval.resolve` approve / deny / take_control | decision | `Approved` / `Denied` / `You took control` | neutral / failure / user |
| `control.change` holder `user` | takeover | `You took control` | user |
| `control.change` holder `agent` | handback | `Handed back to dot` | neutral |
| `pause.change` | pause / resume | `Paused` / `Resumed` | neutral |
| `tool.start` | tool | `<title, 60>` | neutral |
| `tool.end` with `ok: false` | tool-failed | `Command failed (exit <n>)`, or `Command failed` without a code | failure |
| `tool.end` with `ok: true` | — | no mark | — |
| `file.change` | file | `Created` / `Edited` / `Deleted` + ` <basename, 48>` | neutral |
| `memory.change` | memory | `Updated USER.md` / `Updated MEMORY.md` | neutral |
| `key.use` | key | `Used a key → <host, 48>`; on `deny`: `Blocked a key → <host, 48>` | neutral; failure on deny |
| `step.verify` | verify | `Verified` / `Unexpected result` / `Check failed` | neutral / attention / failure |
| `session.*`, `agent.state`, `heartbeat`, `thought.delta`, `plan.*`, `step.*`, `action.*`, `text.progress`, `screen.settle`, `observe`, `tool.output`, `camera.hint` | — | no mark (each has its own display, or would be noise) | — |
| any other type (a later milestone's) | event | the event's `type` | neutral |

**Tests:**
- `marks.test.ts`:
  - `"labels every agent and safety event as the table says"`: one event per table row, each
    `toEqual` its mark; the `file.change` path `/config/Documents/Q3 report.ods` gives
    `Edited Q3 report.ods`.
  - `"ignores events that have their own display"`: every type in the no-mark row returns `null`.
  - `"keeps an unknown future type as a neutral mark"`: an event cast with
    `type: "browser.switch"` gives `{ kind: "event", label: "browser.switch", tone: "neutral" }`.
- Part 3's `model.test.ts`: add `"keeps observes, steps and plans in order and indexes the current
  action by step"`. Fold
  `step.start s1`, an intent, an observe, `step.end s1 failed`, `plan.set` with two items and
  `plan.update` of the second to `done`. Expect:
  - `observes` `[{ t, frameId, step: "s1" }]`;
  - `steps[0]` `{ id: "s1", status: "failed", endT }`;
  - `planAt(m, t)` before and after the update;
  - `stepAt(m, t)` at, before and after `startT`;
  - `byStep.get("s1") === 0`.

  Part 3's halves-equal-whole test still passes, because `toEqual` compares the new Maps by
  content.
- `long-session.test.ts`, **the Review Focus 4 pin (stage)**, complete. It was verified against
  Part 3's model and scene as written in Part 3's plan, plus this task's changes:

```ts
import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyModel, foldEvents, startedCount } from "./model.ts";
import { sceneAt } from "./scene.ts";

// A dense 2-hour session as M4 will log it: a GUI step every ~500 ms, every fourth one typing with
// per-character progress, thinking pauses, every tenth step cancelled: about 138 000 events.
function twoHourLog(): LocalDotEvent[] {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const out: LocalDotEvent[] = [];
  const ev = (type: string, tMs: number, data: Record<string, unknown>, step?: string) =>
    out.push({ v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: out.length, t: msToMicros(tMs), agent: "main", ...(step ? { step } : {}), type, data } as LocalDotEvent);
  ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "long" });
  let t = 100;
  let from = { x: 200, y: 200 };
  for (let n = 0; t < 7_200_000; n++) {
    const step = `s${n}`;
    const to = { x: 100 + Math.floor(rnd() * 2300), y: 100 + Math.floor(rnd() * 1400) };
    const typing = n % 4 === 0;
    ev("agent.state", t, { state: "acting" });
    ev("step.start", t, { kind: "gui" }, step);
    ev("action.intent", t + 1, { verb: typing ? "type" : "click", label: typing ? 'Type "hello world"' : "Click A", point: to, risk: "none", pointer: { from, to, startsAt: t + 121, durationMs: 300, seed: n, curve: "minjerk-bow-v1" } }, step);
    ev("action.target", t + 150, { target: { point: to, bbox: { x: to.x - 20, y: to.y - 10, w: 40, h: 20 }, source: "ax", role: "button", name: "A" } }, step);
    if (n % 10 === 9) {
      ev("action.cancel", t + 300, { reason: "stale" }, step);
      ev("step.end", t + 301, { status: "failed" }, step);
    } else {
      const press = t + 520;
      const input = typing ? { kind: "type", chars: 11, masked: false } : { kind: "click", button: "left", count: 1, at: to };
      ev("action.dispatch", press + 2, { input, pressT: msToMicros(press), ringAt: msToMicros(press + 23), injector: "xtest" }, step);
      if (typing) for (let c = 1; c <= 11; c++) ev("text.progress", press + c * 35, { count: c, chunk: "hello world"[c - 1], masked: false }, step);
      ev("screen.settle", press + 300, { frameT: msToMicros(press + 30), changed: [], noVisibleChange: false }, step);
      ev("observe", press + 330, { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800 }, step);
      ev("action.result", press + 340, { ok: true }, step);
      ev("step.end", press + 341, { status: "ok" }, step);
    }
    from = to;
    t += 450 + Math.floor(rnd() * 100);
    if (n % 50 === 49) {
      ev("agent.state", t, { state: "thinking" });
      t += 5000;
    }
  }
  ev("session.end", t, { reason: "done" });
  return out;
}

describe("a 2-hour session (Review Focus 4, the stage)", () => {
  const log = twoHourLog();

  it("folds in under 2 s and indexes every action", () => {
    const started = performance.now();
    const model = foldEvents(emptyModel(), log);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(log.length).toBeGreaterThan(100_000);
    expect(model.actions.length).toBeGreaterThan(11_000);
    for (const t of [0, 99, 100, 101, 3_600_000, 7_300_000]) {
      expect(startedCount(model, t)).toBe(model.actions.filter((a) => a.intentT <= t).length);
    }
  });

  it("a 2-hour session scene costs under 0.2 ms and equals the unbounded scene", () => {
    const model = foldEvents(emptyModel(), log);
    const end = model.ended?.t ?? 0;
    const view = { reducedMotion: false };
    let seed = 11;
    const times = Array.from({ length: 10_000 }, () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return (seed / 2_147_483_647) * end;
    });
    const started = performance.now();
    for (const t of times) sceneAt(model, t, view);
    expect((performance.now() - started) / times.length).toBeLessThan(0.2);
    for (const t of times.slice(0, 2000)) {
      expect(sceneAt(model, t, view)).toEqual(sceneAt(model, t, view, { ringLookback: Number.POSITIVE_INFINITY }));
    }
  });
});
```

**Implementation notes:**
- `startedCount` relies on `intentT` being sorted. It is: actions are pushed in log order, and
  `EventLog.append` stamps `t = max(lastT, now)`, so `t` never decreases within a session.
  `stepAt` and `observeAt` rely on the same property.
- `sceneAt` takes `n = startedCount(model, t)` and `current = model.actions[n − 1]`, in place of
  the `filter`.
  - `cursorAt` scans back from `n − 1` for the first action with a position: the current action's
    plan position, else `restingPoint`. That is the forward loop's "last defined wins", read
    backwards.
  - `ringsAt` looks at most `ringLookback` actions back. Actions go through the gateway one after
    another. A ring lasts at most `RING_FADE_MS + 2 × DOUBLE_CLICK_GAP_MS = 480 ms` after
    `ringAt`, while the next intent comes after the previous result, which itself waits at least
    `SETTLE_QUIET_MS` after the press. So eight actions back is far beyond any visible ring. The pin
    compares against `Infinity` on 2 000 random times.
  - `cancelAt` takes the action before the current one, `model.actions[n − 2]`, in place of
    `started.at(-2)`. Guard the case where it is `undefined`: Part 3's code would throw for a
    first action cancelled without a plan.
- `foldEvents`' `current(model, step)` reads `byStep` and falls back to the last action. `byStep`
  is set on each `action.intent` that has a step.
- Marks come from the `default:` branch of `foldEvents`' switch, so a type Part 3 already handles
  never becomes a mark. Add explicit `case`s for `observe`, `step.start`, `step.end`, `plan.set`
  and `plan.update`. Part 3 Task 15's `observe` case keeps setting `frames`.
- The model stays plain data plus Maps, with no class instances, so it posts to the worker
  unchanged (structured clone copies Maps).

- [ ] **Step 1:** Write `marks.test.ts`, the new `model.test.ts` case and `long-session.test.ts`.
  Run `pnpm exec vitest run packages/stage`.
  Expected: FAIL. `markOf`, `startedCount` and the new fields do not exist.
- [ ] **Step 2:** Implement as above. Run `pnpm exec vitest run packages/stage`.
  Expected: PASS, including every Part 3 stage test, unchanged.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/stage
git commit -m "feat(stage): replay model with steps, observes, plans, typed marks and a scene index"
```

**Acceptance:** `pnpm exec vitest run packages/stage` passes, and the pin's measured per-scene
cost is printed in the task report. On the planning machine it was 0.99 ms before this task, and
under 0.01 ms after.

---

### Task 6: Stage — replay time: busy spans, the playback map, the replay clock, chapters and ticks

Pure functions shared by the render worker, the replay UI and the export worker. With them, the
three agree on what "skip idle" and "8×" mean.

**Review tier:** light (pure math).

**Files:**
- Create: `packages/stage/src/replay/{playback-map.ts,clock.ts,busy.ts,timeline.ts,index.ts}` and
  `packages/stage/src/replay/{playback-map.test.ts,busy.test.ts,timeline.test.ts}`
- Modify: `packages/stage/src/index.ts` (`export * from "./replay/index.ts";`)

**Interfaces** (exact):

```ts
// packages/stage/src/replay/busy.ts
export const ACTIVITY_TAIL_MS = 100;  // video keeps a span busy this long after its last frame
export const MARK_SHOW_MS = 1200;     // a mark's chip
export const STEP_EDGE_MS = 600;      // a step's start and end
export const START_SHOW_MS = 1000;    // the session's first second
export function busySpans(model: SessionModel, activity: ActivitySpan[], endMs: number): Span[];

// packages/stage/src/replay/timeline.ts
export type ChapterStatus = "doing" | "ok" | "failed" | "blocked" | "cancelled";
export interface Chapter { id: string; label: string; startT: number; endT: number; status: ChapterStatus }
export type TickKind = "click" | "type" | "key" | "scroll" | "drag" | "wait" | "cancel" | MarkKind;
export interface Tick { t: number; kind: TickKind; label: string; tone: MarkTone; step?: string }
export const STEP_KIND_LABEL: Record<string, string>;  // gui "Working on screen", shell "Shell", file "Files", browser "Reading page", ask "Asking you", think "Thinking"
export function chapters(model: SessionModel, endMs: number): Chapter[];
export function ticks(model: SessionModel): Tick[];
export function stepBounds(model: SessionModel, stepId: string): { startT: number; endT: number } | undefined;
```

`playback-map.ts` and `clock.ts`, complete (closed-form math; verified):

```ts
// packages/stage/src/replay/playback-map.ts
// Replay time: session ms ↔ playback ms. Busy stretches play at real time; a quiet stretch of at
// least IDLE_MIN_MS is compressed to IDLE_KEEP_MS when idle is skipped (research §4.9: real
// timestamps with gap compression). Speed is applied separately, by the replay clock.

export const IDLE_MIN_MS = 1500;
export const IDLE_KEEP_MS = 400;

export interface Span {
  from: number;
  to: number;
}

export interface PlaybackSegment {
  s0: number;
  s1: number;
  p0: number;
  p1: number;
  idle: boolean;
}

export interface PlaybackMap {
  startMs: number;
  endMs: number;
  skipIdle: boolean;
  segments: PlaybackSegment[];
}

// Sorted, clipped to [lo, hi], overlapping or touching spans merged; empty spans dropped.
export function mergeSpans(spans: Span[], lo: number, hi: number): Span[] {
  const clipped = spans
    .map((s) => ({ from: Math.max(lo, s.from), to: Math.min(hi, s.to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const s of clipped) {
    const last = out.at(-1);
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

export function buildPlaybackMap(startMs: number, endMs: number, busy: Span[], skipIdle: boolean): PlaybackMap {
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs)) || endMs < startMs) {
    throw new RangeError("a playback map needs finite start ≤ end");
  }
  const segments: PlaybackSegment[] = [];
  let p = 0;
  const push = (s0: number, s1: number, idle: boolean) => {
    if (s1 <= s0) return;
    const len = idle && skipIdle ? IDLE_KEEP_MS : s1 - s0;
    segments.push({ s0, s1, p0: p, p1: p + len, idle: idle && skipIdle });
    p += len;
  };
  let at = startMs;
  for (const b of mergeSpans(busy, startMs, endMs)) {
    push(at, b.from, b.from - at >= IDLE_MIN_MS);
    push(b.from, b.to, false);
    at = b.to;
  }
  push(at, endMs, endMs - at >= IDLE_MIN_MS);
  return { startMs, endMs, skipIdle, segments };
}

export function playDuration(map: PlaybackMap): number {
  return map.segments.at(-1)?.p1 ?? 0;
}

// Last segment whose start is ≤ v under `key`; segments are contiguous in both clocks.
function find(map: PlaybackMap, v: number, k0: "p0" | "s0"): PlaybackSegment | undefined {
  const segs = map.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let best: PlaybackSegment | undefined = segs[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid] as PlaybackSegment;
    if (s[k0] <= v) {
      best = s;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function sessionAt(map: PlaybackMap, playMs: number): number {
  const seg = find(map, playMs, "p0");
  if (!seg) return map.startMs;
  const u = Math.min(1, Math.max(0, (playMs - seg.p0) / (seg.p1 - seg.p0)));
  return seg.s0 + u * (seg.s1 - seg.s0);
}

export function playAt(map: PlaybackMap, sessionMs: number): number {
  const seg = find(map, sessionMs, "s0");
  if (!seg) return 0;
  const u = Math.min(1, Math.max(0, (sessionMs - seg.s0) / (seg.s1 - seg.s0)));
  return seg.p0 + u * (seg.p1 - seg.p0);
}

export function idleAt(map: PlaybackMap, sessionMs: number): boolean {
  const seg = find(map, sessionMs, "s0");
  return seg !== undefined && seg.idle && sessionMs < seg.s1;
}
```

```ts
// packages/stage/src/replay/clock.ts
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

// The replay clock is closed-form: playback ms = anchor + elapsed wall ms × speed while playing.
export interface ReplayClock {
  playing: boolean;
  speed: ReplaySpeed;
  anchorWallMs: number;
  anchorPlayMs: number;
}

export function playMsAt(c: ReplayClock, wallMs: number): number {
  return c.playing ? c.anchorPlayMs + (wallMs - c.anchorWallMs) * c.speed : c.anchorPlayMs;
}

// Re-anchors at the current position, so a speed change or a pause never jumps.
export function retime(c: ReplayClock, wallMs: number, patch: Partial<Pick<ReplayClock, "playing" | "speed" | "anchorPlayMs">>): ReplayClock {
  const at = patch.anchorPlayMs ?? playMsAt(c, wallMs);
  return { playing: patch.playing ?? c.playing, speed: patch.speed ?? c.speed, anchorWallMs: wallMs, anchorPlayMs: at };
}
```

**Tests:**
- `playback-map.test.ts` (verified):
  - `"plays at real time when idle is not skipped"`: busy `[1000, 2000]` in `[0, 10 000]` without
    skipping. The duration is 10 000, and `sessionAt(playAt(t)) = t` at 0, 999, 1500, 9999 and
    10 000.
  - `"compresses a quiet stretch of 1.5 s or more to 400 ms and keeps shorter ones"`: busy
    `[0,1000]`, `[2000,3000]`, `[13000,14000]` in `[0, 20 000]`. The duration is
    `3000 + 400 + 1000 + 400`, `playAt(13 000) = 3400`, `sessionAt(3200) = 8000`,
    `idleAt(8000)` is true, and `idleAt(1500)` and `idleAt(13 000)` are false.
  - `"is monotonic and round-trips inside busy stretches"`: 200 irregular busy spans. `sessionAt`
    never decreases over playback time in 37 ms steps, and round-trips 1 ms into each busy span.
  - `"refuses a reversed range"`: `RangeError`.
  - `"advances by wall time × speed and never jumps on a speed change or pause"`: the clock's
    `retime` cases.
- `busy.test.ts` (verified):
  - `"keeps an action busy from its intent to its target hold after the result, and thinking
    idle"`. Input: a click intent at 10 000, its result at 11 000, `thinking` at 11 500, a
    `control.change` to the user at 40 000, the end at 60 000, and activity
    `[10.6 s, 10.9 s]` in µs. Expected busy spans: `[0,1000]`,
    `[10 000, 11 000 + TARGET_HOLD_MS + TARGET_FADE_MS]` and `[40 000, 41 200]`. The map is
    idle at 20 000 and not at 10 500.
  - `"keeps a typing burst busy through its last progress line"`: a type action whose result
    comes 3 s after its intent is one busy span.
  - `"treats an action with no result as busy until the session ends"`: no result and no cancel.
    The span runs to `ended.t + TARGET_HOLD_MS + TARGET_FADE_MS`, clipped to the end.
- `timeline.test.ts`:
  - `"makes one chapter per step, labelled by its last action"`: two steps. Labels `Click A` and
    `Type "B2"`. Statuses `ok` and `doing`; the open step ends at `endMs`.
  - `"labels a step without actions by its kind"`: a `shell` step gives `Shell`.
  - `"ticks each dispatch by its input kind, each cancel as a failure, and each mark"`: a click, a
    type, a key, a cancel (`tone: "failure"`) and an `approval.request` mark. Ticks are sorted by
    `t`, and an action without a dispatch ticks at its `intentT`.
  - `"bounds a step by its start and end, or the next step's start"`: `stepBounds`.

**Implementation notes:**
- `busySpans` (verified rules): `START_SHOW_MS` from the session start. Each activity span becomes
  `[from µs → ms, to µs → ms + ACTIVITY_TAIL_MS]` (through `microsToMs`). Each action covers
  `[intentT, (cancel.t ?? resultT ?? ended.t ?? intentT + SETTLE_CAP_MS) + TARGET_HOLD_MS + TARGET_FADE_MS]`.
  Each mark covers `[t, t + MARK_SHOW_MS]`, and each step start and end `[t, t + STEP_EDGE_MS]`.
  The result is `mergeSpans(…, startT, endMs)`. Thinking without video is idle **on purpose**, and
  the HUD says "idle skipped" there (Task 14).
- `chapters`: one per `model.steps` entry. The label is the label of the step's latest action
  (`byStep`), else the plan item's text (`planAt` at `startT`), else `STEP_KIND_LABEL[kind]`.
  `endT` is the step's `endT`, else the next step's `startT`, else `endMs`. Steps never overlap in
  M2's runner; if a later runner overlaps them, the chapter ends at the next step's start.
- `ticks`: each action gives one tick at `dispatch.t ?? intentT`, kind `dispatch.input.kind` (or
  the intent's `verb`), and a `cancel` tick (tone `failure`) at `cancel.t`. Each mark becomes a tick
  with its own kind, label and tone. Sort by `t`, then `seq`. A 2-hour session gives about 14 000
  ticks. The scrubber buckets them by pixel (Task 14), never renders them one by one.
- No function here reads a clock. The replay clock gets its wall time passed in.

- [ ] **Step 1:** Write the three test files. Run `pnpm exec vitest run packages/stage/src/replay`.
  Expected: FAIL (modules missing).
- [ ] **Step 2:** Add `playback-map.ts` and `clock.ts` as above, and implement `busy.ts` and
  `timeline.ts`. Run the same command.
  Expected: PASS.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/stage
git commit -m "feat(stage): replay time with skip idle, a closed-form replay clock, chapters and ticks"
```

**Acceptance:** `pnpm exec vitest run packages/stage` passes.

---

### Task 7: Daemon — the recording file: writer, GOP journal and fragment index

`RecordingWriter` turns stamped H.264 access units into `recording/video.mp4` through mediabunny.
Before a frame reaches the muxer, it is appended to a per-GOP journal. Each committed fragment is
indexed in `fragments.jsonl`. These four facts, verified while writing this plan with mediabunny
1.61.0 in Node 24, shape it:
- **Timestamps are exact session µs.** `addVideoTrack(source, { frameRate: 1_000_000 })` makes the
  track timescale 1 000 000 and snaps to whole µs. Verified: 40 packets at `t ≈ 7 199 s` read back
  µs-exact, and `getPacket(t_{i+1} − 1 µs)` returns frame i in 156 of 156 probes. Without
  `frameRate`, the timescale is 57 600 and seeks near a boundary drift by up to 17 µs.
- **One GOP per fragment.** mediabunny's `trun` writer marks only a fragment's first sample as a
  sync sample when the fragment's flags take exactly two values. So a second key frame inside one
  fragment loses its key flag, and `getKeyPacket` returns the fragment's first key instead. Hence
  `minimumFragmentDuration: 0`: every key frame starts a fragment, and every fragment has exactly
  one key frame, at its start. Verified: with 1 s fragments and 12-frame GOPs, `getKeyPacket(1.5)`
  returned the key at 1.0 s instead of the one at 1.4 s; with `0` it returned 1.4 s.
- **Fragmented mode writes append-only.** Every `StreamTarget` chunk's `position` equals the bytes
  written so far, until `finalize()` (verified). So the file is a prefix-consistent append log, and
  a crash leaves a valid prefix plus at most one partial fragment.
- **The muxer holds the open fragment in memory** until the next key frame arrives. Hence the
  journal.

**Review tier:** light (storage plumbing; the privacy gate that sits in front of it is Task 11).

**Files:**
- Create: `apps/daemon/src/recorder/boxes.ts`, `apps/daemon/src/recorder/journal.ts`,
  `apps/daemon/src/recorder/writer.ts`
- Test: `apps/daemon/src/recorder/boxes.test.ts`, `apps/daemon/src/recorder/writer.test.ts`
- Modify: `apps/daemon/package.json` (`"@localdot/stage": "workspace:*"` is already a dependency
  since Part 3, which gives the tests `@localdot/stage/testing`)

**Interfaces** (exact):

```ts
// apps/daemon/src/recorder/writer.ts
import type { FragmentEntry } from "@localdot/protocol";

export const FRAGMENT_MIN_SECONDS = 0; // one GOP per fragment: see the trun note above

export interface RecordedFrame {
  tMicros: number;   // session µs of the frame's arrival at the daemon (EventLog.toSessionT)
  key: boolean;      // an IDR with its SPS and PPS in-band (isRandomAccess, Task 9)
  data: Uint8Array;  // one Annex B access unit, exactly as Selkies sent it
}

// The node:fs calls the writer makes; tests inject ENOSPC through it (Task 8).
export type RecordingFs = Pick<typeof import("node:fs"), "openSync" | "writeSync" | "closeSync" | "appendFileSync" | "mkdirSync" | "rmSync">;

export interface RecordingWriterOptions {
  dir: string;        // <home>/sessions/<id>/recording
  codec: string;      // avc1.PPCCLL from the first key frame's SPS (avcCodecString, Task 9)
  width: number;      // Selkies' header width and height of the first key frame
  height: number;
  fs?: RecordingFs;
  onCommit?(entry: FragmentEntry): void;
}

export class RecordingWriter {
  constructor(opts: RecordingWriterOptions);
  start(): Promise<void>;
  // Resolves true once the frame is in the journal (and its predecessor in the muxer); false when
  // it is a delta frame before the first key frame (dropped). Rejects with the fs error, and every
  // later call rejects with the same error.
  push(frame: RecordedFrame): Promise<boolean>;
  // The screen went still: hand the pending frame to the muxer with duration now − t.
  flushIdle(nowMicros: number): Promise<void>;
  // Hands the pending frame over with duration end − t, finalizes (the muxer appends its own mfra),
  // commits the last fragment and removes the journal.
  finish(endMicros: number): Promise<void>;
  close(): void;      // after an error or on abandon: closes the file, keeps every byte for recovery
  readonly entries: readonly FragmentEntry[];
  readonly committedBytes: number;
  readonly lastMicros: number | null;
  readonly failed: boolean;
}
```

`boxes.ts` and `journal.ts`, complete (byte formats; verified):

```ts
// ISO BMFF pieces the recorder writes or walks itself: the top-level box walk used by recovery,
// and the fragment random-access box (mfra) that makes a cut-off or still-growing recording
// seekable without reading every moof. Times are MEDIA_TIMESCALE ticks: session µs.

// mediabunny numbers the recording's only track 1.
export const TRACK_ID = 1;

export interface TopBox {
  type: string;
  start: number;
  size: number;
}

// Complete top-level boxes from `from`; stops at the first box that is cut off or malformed.
export function topLevelBoxes(buf: Uint8Array, from = 0): TopBox[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: TopBox[] = [];
  let at = from;
  while (at + 8 <= buf.length) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > buf.length) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    }
    if (size < header || at + size > buf.length) break;
    const type = String.fromCharCode(buf[at + 4] ?? 0, buf[at + 5] ?? 0, buf[at + 6] ?? 0, buf[at + 7] ?? 0);
    boxes.push({ type, start: at, size });
    at += size;
  }
  return boxes;
}

export interface RandomAccessEntry {
  startMicros: number;
  moofOffset: number;
}

// mfra { tfra v1 (64-bit time and offset, 32-bit traf/trun/sample numbers), mfro }, as mediabunny
// writes it itself, so its demuxer finds every fragment from the file's last 16 bytes.
export function mfraBox(entries: RandomAccessEntry[]): Uint8Array {
  const tfraSize = 8 + 4 + 12 + entries.length * 28;
  const mfroSize = 16;
  const size = 8 + tfraSize + mfroSize;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  v.setUint32(0, size);
  tag(4, "mfra");
  v.setUint32(8, tfraSize);
  tag(12, "tfra");
  v.setUint32(16, 1 << 24);
  v.setUint32(20, TRACK_ID);
  v.setUint32(24, 0b111111);
  v.setUint32(28, entries.length);
  let at = 32;
  for (const e of entries) {
    v.setBigUint64(at, BigInt(e.startMicros));
    v.setBigUint64(at + 8, BigInt(e.moofOffset));
    v.setUint32(at + 16, 1);
    v.setUint32(at + 20, 1);
    v.setUint32(at + 24, 1);
    at += 28;
  }
  v.setUint32(at, mfroSize);
  tag(at + 4, "mfro");
  v.setUint32(at + 8, 0);
  v.setUint32(at + 12, size);
  return out;
}
```

```ts
// The open fragment's frames, written to disk as they arrive, because the muxer holds a fragment in
// memory until the next key frame closes it. One file per GOP; a record is
// u32 BE payload length | u8 flags (bit 0: key) | u64 BE session µs | payload (Annex B).

export const JOURNAL_HEADER = 13;

export interface JournalRecord {
  tMicros: number;
  key: boolean;
  data: Uint8Array;
}

export function encodeJournalRecord(r: JournalRecord): Uint8Array {
  const out = new Uint8Array(JOURNAL_HEADER + r.data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, r.data.length);
  v.setUint8(4, r.key ? 1 : 0);
  v.setBigUint64(5, BigInt(r.tMicros));
  out.set(r.data, JOURNAL_HEADER);
  return out;
}

// Whole records only: a record cut off by a crash, and anything after it, is dropped.
export function decodeJournal(buf: Uint8Array): JournalRecord[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: JournalRecord[] = [];
  let at = 0;
  while (at + JOURNAL_HEADER <= buf.length) {
    const len = v.getUint32(at);
    const flags = v.getUint8(at + 4);
    if (flags > 1 || at + JOURNAL_HEADER + len > buf.length) break;
    out.push({ key: flags === 1, tMicros: Number(v.getBigUint64(at + 5)), data: buf.slice(at + JOURNAL_HEADER, at + JOURNAL_HEADER + len) });
    at += JOURNAL_HEADER + len;
  }
  return out;
}

// Files sort by name in time order.
export function journalName(gopStartMicros: number): string {
  return `${String(gopStartMicros).padStart(16, "0")}.bin`;
}
```

**Tests:**
- `boxes.test.ts` (verified):

```ts
import { describe, expect, it } from "vitest";
import { mfraBox, topLevelBoxes } from "./boxes.ts";
import { decodeJournal, encodeJournalRecord, journalName } from "./journal.ts";

describe("boxes", () => {
  it("walks complete top-level boxes and stops at a cut-off one", () => {
    const box = (type: string, body: number) => { const b = new Uint8Array(8 + body); new DataView(b.buffer).setUint32(0, 8 + body); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i); return b; };
    const whole = new Uint8Array([...box("ftyp", 4), ...box("moov", 20), ...box("moof", 10), ...box("mdat", 30)]);
    expect(topLevelBoxes(whole).map((b) => b.type)).toEqual(["ftyp", "moov", "moof", "mdat"]);
    expect(topLevelBoxes(whole.subarray(0, whole.length - 1)).map((b) => b.type)).toEqual(["ftyp", "moov", "moof"]);
  });
  it("writes an mfra whose mfro names its own size", () => {
    const m = mfraBox([{ startMicros: 7_200_000_000, moofOffset: 5_000_000_000 }, { startMicros: 1, moofOffset: 2 }]);
    const v = new DataView(m.buffer);
    expect(m.length).toBe(8 + (8 + 4 + 12 + 2 * 28) + 16);
    expect(v.getUint32(m.length - 4)).toBe(m.length);
    expect(v.getBigUint64(32)).toBe(7_200_000_000n);
    expect(v.getBigUint64(40)).toBe(5_000_000_000n);
  });
});

describe("journal", () => {
  it("round-trips records and drops a torn tail", () => {
    const a = { tMicros: 1_000_000, key: true, data: Uint8Array.of(0, 0, 0, 1, 0x65, 9) };
    const b = { tMicros: 1_016_667, key: false, data: Uint8Array.of(0, 0, 0, 1, 0x41, 7, 7) };
    const bytes = new Uint8Array([...encodeJournalRecord(a), ...encodeJournalRecord(b)]);
    expect(decodeJournal(bytes)).toEqual([a, b]);
    expect(decodeJournal(bytes.subarray(0, bytes.length - 2))).toEqual([a]);
    expect(journalName(1_000_000)).toBe("0000000001000000.bin");
  });
});
```
- `writer.test.ts`:
  - `"writes one fragment per GOP, each starting with its key frame"`: 60 synthetic frames with
    `keyEvery: 12`, then `finish`. mediabunny's `EncodedPacketSink` reads frames 0, 12, 24, 36 and
    48 as `type: "key"` and every other frame as `delta`. `entries` has 5 fragments, and
    `entries[i].startMicros` is the time of frame `12 × i`.
  - `"keeps exact session microseconds two hours in"`: 40 frames from `t = 7 199 123 457 µs`. Every
    packet's `microsecondTimestamp` equals the pushed `tMicros`.
  - `"drops delta frames before the first key frame"`: `push` of a delta frame resolves `false`
    and writes nothing; the next key frame resolves `true`.
  - `"never lets time run backwards"`: frames pushed at `t`, `t` and `t − 5` are stored at
    `t`, `t + 1` and `t + 2`.
  - `"indexes a fragment only after its bytes are on disk, and deletes its journal then"`: after
    the second key frame's successor is pushed, `fragments.jsonl` has one line,
    `stat(video.mp4).size ≥ entries[0].endOffset`, and `journal/` holds only files named at or
    after `entries[0].endMicros`.
  - `"gives the last frame the duration up to finish or the idle flush"`: frames at 1.000 s and
    1.010 s, `flushIdle(3_000_000)`, then `finish(5_000_000)`. The second packet's duration is
    1 990 000 µs.
  - `"removes the journal and leaves a file with mediabunny's own mfra after finish"`:
    `journal/` is gone, and the file's last 16 bytes are an `mfro` box.

**Implementation notes:**
- Output:
  `new Output({ target: new StreamTarget(sink), format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: FRAGMENT_MIN_SECONDS, onMoof, onMdat }) })`,
  then `output.addVideoTrack(source, { frameRate: MEDIA_TIMESCALE })` with
  `source = new EncodedVideoPacketSource("avc")`.
- The first `source.add` carries
  `{ decoderConfig: { codec, codedWidth: width, codedHeight: height } }` with **no
  `description`**. mediabunny then treats the packets as Annex B: it builds the `avcC` from the
  first packet's SPS and PPS and converts every packet to length-prefixed form, keeping in-band
  parameter sets. The first packet must be a key frame (mediabunny throws
  `First packet must be a key packet`).
- The sink is a `WritableStream` whose `write({ data, position })` asserts
  `position === written` (append-only; anything else is a bug, so throw), calls
  `fs.writeSync(fd, data, 0, data.length, position)`, and advances `written`.
- **Pending frame.** A frame's duration is only known when the next one arrives. `push(f)`:
  1. normalises `t = max(f.tMicros, lastT + 1)`;
  2. if `f.key`, starts a new journal file `journal/<journalName(t)>`;
  3. appends `encodeJournalRecord` to the current GOP's journal (`fs.appendFileSync`);
  4. if a frame is pending, adds it to the muxer with duration `t − pending.t`;
  5. makes `f` the pending frame.
- **Commit tracking.**
  - `onMoof(_, position, ts)` records `{ moofOffset: position, startMicros: round(ts × 1e6) }`.
  - `onMdat(data, position)` queues an entry ending at `position + data.length`, whose `endMicros`
    is the time of the packet being added at that moment. That packet is the key frame that closed
    the fragment, set in a field just before each `source.add`. In `finish` it is `endMicros`.
  - After each `source.add` returns, every queued entry with `endOffset ≤ written` is committed, in
    order:
    1. append its JSON line to `fragments.jsonl` (`fs.appendFileSync`; after the bytes, never
       before);
    2. push it to `entries` and call `onCommit`;
    3. delete every journal file whose GOP start is `< entry.endMicros`.
- **Errors.** Any throw inside `push` (journal append, `source.add`, the sink) sets `failed`,
  closes the file descriptor and rethrows. Later calls reject with the stored error. Nothing is
  deleted. Recovery (Task 8) makes the files consistent.
- **Memory:** one pending frame plus the muxer's open fragment (≤ one GOP: about 2 s of frames at
  2×, 0.5–9 MB). The journal is on disk.
- Measured cost: muxing 9 000 small frames took 400 ms in Node 24, which is about 44 µs per frame.
  At 60 fps that is 0.3 % of a core.

- [ ] **Step 1:** Write `boxes.test.ts` and `writer.test.ts`. Run
  `pnpm exec vitest run apps/daemon/src/recorder`.
  Expected: FAIL (modules missing).
- [ ] **Step 2:** Add `boxes.ts` and `journal.ts` as above, and implement `writer.ts`. Run the same
  command.
  Expected: PASS.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(recorder): fragmented MP4 writer with a GOP journal and a fragment index"
```

**Acceptance:** `pnpm exec vitest run apps/daemon/src/recorder` passes.

---

### Task 8: Daemon — recovery and the served view (crash, disk full, seek accuracy)

Recovery makes any recording directory consistent again: after a crash, after a writer error such
as ENOSPC, or at daemon start for a session whose manifest still says `recording`. The view serves
a recording to the browser. A finished one is served as is. A live or cut-off one is served as its
committed fragments plus an `mfra` built from `fragments.jsonl`.

Without the `mfra`, mediabunny finds a fragment by reading the whole file: verified with a
synthetic 2-hour recording of 1 799 fragments, where one seek read all 5.9 MB. With it, the same
seek takes 4 reads and 0.2 ms (`proof-perf`, see "Verification").

**Review tier:** light.

**Files:**
- Create: `apps/daemon/src/recorder/recover.ts`, `apps/daemon/src/recorder/view.ts`,
  `apps/daemon/src/recorder/testing/crash-child.ts`,
  `apps/daemon/src/recorder/testing/crash-stream.ts`, `apps/daemon/src/recorder/testing/full-fs.ts`
- Test: `apps/daemon/src/recorder/recover.test.ts`, `apps/daemon/src/recorder/seek.test.ts`,
  `apps/daemon/src/recorder/crash.test.ts`, `apps/daemon/src/recorder/diskfull-writer.test.ts`

**Interfaces** (exact):

```ts
// apps/daemon/src/recorder/recover.ts
export interface StreamFormat { codec: string; width: number; height: number }
export interface RecoveryResult {
  state: "recovered" | "failed";   // failed: no fragment and no journaled key frame survived
  fragments: number;
  tailFrames: number;              // frames brought back from the journal
  bytes: number;
  firstMicros: number | null;
  lastMicros: number | null;
}
export const NOMINAL_FRAME_MICROS = 16_667;  // the duration recovery gives the last journaled frame
// The valid prefix of fragments.jsonl: lines that parse as FragmentEntry, seq 1, 2, 3…, each
// starting at or after the previous end, each inside the file.
export function readFragments(dir: string): FragmentEntry[];
// format defaults to manifest.json's codec, width and height (written at the first key frame, Task 10).
export function recoverRecording(dir: string, format?: StreamFormat): Promise<RecoveryResult>;

// apps/daemon/src/recorder/view.ts
export interface RecordingView { size: number; read(start: number, end: number): Uint8Array; close(): void }
export interface ViewOptions {
  complete: boolean;                    // the muxer finalized it, or recovery appended its mfra: serve the file as is
  entries?: readonly FragmentEntry[];   // the live writer's entries; default readFragments(dir)
  upto?: number;                        // serve the first `upto` fragments only (a stable snapshot)
}
export function openRecordingView(dir: string, opts: ViewOptions): RecordingView;
```

**Recovery, step by step** (verified):
1. `entries = readFragments(dir)`, and `format` (the argument, else the manifest's).
2. Gather the journal records: every `journal/*.bin` in name order, through `decodeJournal`
   (torn tails dropped). Keep those with `tMicros ≥ entries.at(-1).endMicros` (all of them when
   there are no entries), then drop everything before the first key record. Without a format,
   keep none.
3. With entries, truncate `video.mp4` to `entries.at(-1).endOffset`. With none, delete it.
4. If any tail records remain, mux them with a fresh mediabunny `Output` into a `BufferTarget`
   (`fastStart: "fragmented"`, `minimumFragmentDuration: Infinity`, `frameRate: MEDIA_TIMESCALE`;
   each duration is the gap to the next record, `NOMINAL_FRAME_MICROS` for the last). Walk its
   top-level boxes with `topLevelBoxes`.
   - With entries: append its `moof` and `mdat` only. `trun`'s data offset is relative to the
     `moof`, and `tfdt` carries absolute time, so the pair can move to any offset.
   - Without entries: write its `ftyp moov moof mdat` as the new file.
   - Append the new entry (`seq = entries.length + 1`) to `fragments.jsonl`.
5. If the file has any fragment, append `mfraBox(all entries)`. Remove `journal/`.
6. Return the result. Task 10 writes the manifest (`recovered` or `failed`) from it.

**Tests:**
- `recover.test.ts`:
  - `"leaves a finished recording alone apart from its journal"`: no journal, a finished file.
    `recoverRecording` doesn't truncate it (the size is unchanged, because `fragments.jsonl`
    covers every fragment).

    The caller doesn't run recovery on `complete` manifests (Task 10); this guards the idempotent
    case.
  - `"rebuilds a recording from the journal alone"`: the writer is killed before its first commit
    (2 frames pushed). Recovery writes a new file with both frames.
  - `"ignores a stale journal left between a commit and its journal delete"`: a journal file
    whose records all lie before `entries.at(-1).endMicros`. No tail is added, and the frame count
    is unchanged.
  - `"stops reading fragments.jsonl at a torn or out-of-order line"`: a third line cut in half,
    and a line whose `moofOffset` lies before the previous `endOffset`, both end the valid prefix.
  - `"fails without a format and without fragments"`: `state: "failed"`, and `video.mp4` is
    absent.
- `seek.test.ts`, crash pin, disk-full pin: complete code below.

**Implementation notes for the view:**
- `complete`: `size = stat.size`, and reads come from the file.
- Otherwise: `prefix = entries[upto − 1].endOffset` and `tail = mfraBox(entries[0..upto))`, with
  `size = prefix + tail.length`. Reads spanning the boundary stitch file bytes and tail bytes.
- `upto` makes a snapshot stable. The bytes of fragment `upto + 1` would otherwise later overwrite
  the region where the snapshot's `mfra` sat, and a reader holding the old size would read moof
  bytes as its mfra.
- One `fd` per view, closed by `close()`. The route (Task 12) opens a view per request and closes
  it when the response stream ends or aborts.

**The Review Focus pins** (complete; verified against a prototype of this task while writing the
plan, including a real SIGKILL of a child process at five points):

`apps/daemon/src/recorder/testing/crash-stream.ts`:
```ts
import { SYNTH_CODEC } from "@localdot/stage/testing";

export const CRASH_SYNTH = { widthMbs: 8, heightMbs: 8, keyEvery: 30 };
export const CRASH_FORMAT = { codec: SYNTH_CODEC, width: 128, height: 128 };
// 60 fps bursts of 45 frames with 700 ms of still screen between them, like Selkies' damage-driven
// stream, starting a second into the session.
export const crashArrival = (i: number): number => 1_000_000 + i * 16_667 + Math.floor(i / 45) * 700_000;
```

`apps/daemon/src/recorder/testing/crash-child.ts`:
```ts
// Records a synthetic stream into argv[2] and prints "<index> <µs>" after every push that resolved,
// so a test can SIGKILL it at an arbitrary frame (Review Focus 2).
import { synthFrame } from "@localdot/stage/testing";
import { RecordingWriter } from "../writer.ts";
import { CRASH_FORMAT, CRASH_SYNTH, crashArrival } from "./crash-stream.ts";

const writer = new RecordingWriter({ dir: process.argv[2] as string, ...CRASH_FORMAT });
await writer.start();
for (let i = 0; ; i++) {
  const f = synthFrame(CRASH_SYNTH, i);
  const t = crashArrival(i);
  await writer.push({ tMicros: t, key: f.key, data: f.data });
  process.stdout.write(`${i} ${t}\n`);
  if (i % 45 === 44) await writer.flushIdle(t + 500_000);
}
```

`apps/daemon/src/recorder/crash.test.ts`:
```ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { recoverRecording } from "./recover.ts";
import { CRASH_FORMAT, CRASH_SYNTH } from "./testing/crash-stream.ts";

const CHILD = fileURLToPath(new URL("./testing/crash-child.ts", import.meta.url));

// Annex B start codes → NAL payloads (hex), and the same from MP4's 4-byte lengths.
function nalsAnnexB(b: Uint8Array): string[] {
  const out: string[] = [];
  let s = -1;
  for (let i = 0; i + 3 <= b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (s >= 0) out.push(Buffer.from(b.subarray(s, b[i - 1] === 0 ? i - 1 : i)).toString("hex"));
      s = i + 3;
      i += 2;
    }
  }
  if (s >= 0) out.push(Buffer.from(b.subarray(s)).toString("hex"));
  return out;
}
function nalsLengthPrefixed(b: Uint8Array): string[] {
  const out: string[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 0; at + 4 <= b.length; ) {
    const n = v.getUint32(at);
    out.push(Buffer.from(b.subarray(at + 4, at + 4 + n)).toString("hex"));
    at += 4 + n;
  }
  return out;
}

async function recordAndKill(dir: string, killAfter: number): Promise<{ i: number; t: number }[]> {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD, dir], { stdio: ["ignore", "pipe", "inherit"] });
  const pushed: { i: number; t: number }[] = [];
  await new Promise<void>((resolve) => {
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const [i, t] = line.split(" ").map(Number);
        pushed.push({ i: i as number, t: t as number });
      }
      if (pushed.length >= killAfter && child.exitCode === null) child.kill("SIGKILL");
    });
    child.on("exit", () => resolve());
  });
  return pushed;
}

describe("a crash mid-recording (Review Focus 2)", () => {
  for (const killAfter of [3, 31, 97, 200, 333]) {
    it(`keeps every frame whose push resolved when killed after ${killAfter} frames`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "local dot's crash-"));
      const pushed = await recordAndKill(dir, killAfter);
      expect(pushed.length).toBeGreaterThanOrEqual(killAfter);
      const result = await recoverRecording(dir, CRASH_FORMAT);
      expect(result.state).toBe("recovered");
      const input = new Input({ source: new FilePathSource(join(dir, "video.mp4")), formats: ALL_FORMATS });
      const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
      const got: { t: number; nals: string[] }[] = [];
      for await (const p of sink.packets()) got.push({ t: p.microsecondTimestamp, nals: nalsLengthPrefixed(p.data) });
      expect(got.length).toBeGreaterThanOrEqual(pushed.length);
      for (const { i, t } of pushed) {
        expect(got[i]?.t).toBe(t);
        expect(got[i]?.nals).toEqual(nalsAnnexB(synthFrame(CRASH_SYNTH, i).data));
      }
      // Seekable without a walk: the recovered file ends with an mfra.
      const last = pushed.at(-1) as { t: number };
      expect((await sink.getPacket(last.t / 1e6))?.microsecondTimestamp).toBe(last.t);
      input.dispose();
    }, 60_000);
  }
});
```

`apps/daemon/src/recorder/seek.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, Input, StreamSource } from "mediabunny";
import { describe, expect, it } from "vitest";
import { openRecordingView, type RecordingView } from "./view.ts";
import { RecordingWriter } from "./writer.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 12 };

// VFR arrival times: bursts at ~60 fps with jitter, separated by still stretches (Selkies sends
// nothing for a still screen), starting well after session time 0.
function arrivals(n: number): number[] {
  const t: number[] = [];
  let at = 2_345_678;
  for (let i = 0; i < n; i++) {
    t.push(at);
    at += i % 30 === 29 ? 2_500_000 + i * 11 : 16_000 + ((i * 7919) % 1500);
  }
  return t;
}

function sinkOf(view: RecordingView) {
  const input = new Input({ formats: ALL_FORMATS, source: new StreamSource({ getSize: () => view.size, read: (s, e) => view.read(s, e) }) });
  return { input, sink: input.getPrimaryVideoTrack().then((track) => new EncodedPacketSink(track as never)) };
}

async function expectExactSeeks(sink: EncodedPacketSink, times: number[], upTo: number) {
  for (let i = 0; i < upTo; i++) {
    const a = times[i] as number;
    const next = times[i + 1] ?? a + 16_667;
    for (const q of [a, a + 1, Math.floor((a + next) / 2), next - 1]) {
      expect((await sink.getPacket(q / 1e6))?.microsecondTimestamp).toBe(a);
      expect((await sink.getKeyPacket(q / 1e6))?.microsecondTimestamp).toBe(times[Math.floor(i / o.keyEvery) * o.keyEvery]);
    }
  }
  expect(await sink.getPacket(((times[0] as number) - 1) / 1e6)).toBeNull();
}

describe("seek accuracy (Review Focus 1)", () => {
  it("returns, for any session time, the frame on screen then and the key frame to decode from — live and finished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local dot's seek-"));
    const times = arrivals(150);
    const w = new RecordingWriter({ dir, codec: SYNTH_CODEC, width: 64, height: 64 });
    await w.start();
    for (let i = 0; i < times.length; i++) {
      const f = synthFrame(o, i);
      await w.push({ tMicros: times[i] as number, key: f.key, data: f.data });
    }
    // Mid-recording: the committed fragments only, served with a fresh mfra.
    const committed = w.entries.at(-1)?.endMicros ?? 0;
    const upTo = times.filter((t) => t < committed).length - 1;
    expect(upTo).toBeGreaterThan(90);
    const liveView = openRecordingView(dir, { complete: false, entries: w.entries });
    const live = sinkOf(liveView);
    await expectExactSeeks(await live.sink, times, upTo);
    live.input.dispose();
    liveView.close();
    await w.finish((times.at(-1) as number) + 16_667);
    const doneView = openRecordingView(dir, { complete: true });
    const done = sinkOf(doneView);
    await expectExactSeeks(await done.sink, times, times.length);
    done.input.dispose();
    doneView.close();
  });
});
```

`apps/daemon/src/recorder/testing/full-fs.ts`:
```ts
import * as fs from "node:fs";
import type { RecordingFs } from "../writer.ts";

// A filesystem that runs out of space after `budget` bytes, as write(2) does with ENOSPC.
export function fullAfter(budget: number): RecordingFs & { used(): number } {
  let used = 0;
  const spend = (n: number) => {
    if (used + n > budget) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    used += n;
  };
  return {
    ...fs,
    used: () => used,
    writeSync: ((fd: number, data: Uint8Array, offset?: number, length?: number, position?: number) => {
      spend(length ?? data.length);
      return fs.writeSync(fd, data, offset, length, position);
    }) as typeof fs.writeSync,
    appendFileSync: ((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
      spend(typeof data === "string" ? Buffer.byteLength(data) : data.length);
      fs.appendFileSync(file, data);
    }) as typeof fs.appendFileSync,
  };
}
```

`apps/daemon/src/recorder/diskfull-writer.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { recoverRecording } from "./recover.ts";
import { fullAfter } from "./testing/full-fs.ts";
import { RecordingWriter } from "./writer.ts";

describe("disk full (Review Focus 3), the writer", () => {
  it("fails the push with ENOSPC, stays failed, and recovery leaves every journaled frame playable", async () => {
    const o = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
    const format = { codec: SYNTH_CODEC, width: 64, height: 64 };
    const dir = mkdtempSync(join(tmpdir(), "local dot's full-"));
    const w = new RecordingWriter({ dir, ...format, fs: fullAfter(150_000) });
    await w.start();
    let pushed = 0;
    let error: unknown;
    try {
      for (let i = 0; i < 1000; i++) {
        const f = synthFrame(o, i);
        await w.push({ tMicros: 500_000 + i * 16_667, key: f.key, data: f.data });
        pushed = i + 1;
      }
    } catch (err) {
      error = err;
    }
    expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(pushed).toBeGreaterThan(20);
    expect(w.failed).toBe(true);
    await expect(w.push({ tMicros: 99_000_000, key: true, data: synthFrame(o, 0).data })).rejects.toThrow(/ENOSPC/);
    // Space comes back (the user frees some): recovery runs with the real filesystem.
    await recoverRecording(dir, format);
    const input = new Input({ source: new FilePathSource(join(dir, "video.mp4")), formats: ALL_FORMATS });
    const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
    let n = 0;
    for await (const _ of sink.packets()) n++;
    input.dispose();
    // Every pushed frame reached the journal or a fragment; the one that hit ENOSPC may too.
    expect(n).toBeGreaterThanOrEqual(pushed);
    expect(n).toBeLessThanOrEqual(pushed + 1);
  });
});
```

- [ ] **Step 1:** Write the tests and the testing helpers above. Run
  `pnpm exec vitest run apps/daemon/src/recorder`.
  Expected: FAIL (`recover.ts`, `view.ts` missing).
- [ ] **Step 2:** Implement `recover.ts` and `view.ts`. Run the same command.
  Expected: PASS. The crash pin runs five child processes, in about 2 s in total.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/recorder
git commit -m "feat(recorder): crash recovery from the GOP journal and a seekable served view"
```

**Acceptance:** `pnpm exec vitest run apps/daemon/src/recorder` passes: seek accuracy at every
boundary, the five crash points, and ENOSPC.

---

### Task 9: Daemon — the Selkies feed

The recorder's own client on the cell's stream. It is passive: it never sends settings, input,
acks or compression requests, so it cannot change what the user's viewer sees (S9 Q2). It parses
Selkies' video messages, stamps each access unit with the daemon's monotonic clock on arrival, and
asks for key frames when the session recorder wants one.

**Review tier:** light. It reuses the per-cell stream credential exactly as the proxy does, and
the credential appears only in the `Authorization` header (pinned below).

**Files:**
- Create: `apps/daemon/src/recorder/wire.ts`, `apps/daemon/src/recorder/annexb.ts`,
  `apps/daemon/src/recorder/feed.ts`, `apps/daemon/src/recorder/testing/fake-selkies.ts`,
  `apps/daemon/src/recorder/testing/fake-feed.ts`
- Test: `apps/daemon/src/recorder/wire.test.ts`, `apps/daemon/src/recorder/feed.test.ts`

**Interfaces** (exact):

```ts
// apps/daemon/src/recorder/feed.ts
import type { Clock } from "../clock.ts";
import type { StreamEndpoint } from "../cells/types.ts";

export interface FeedFrame {
  arrivalMicros: number;  // daemon monotonic clock (Clock.nowMicros) when the message arrived
  key: boolean;           // the wire's key flag AND isRandomAccess(data)
  width: number;          // Selkies' header
  height: number;
  data: Uint8Array;       // the Annex B access unit
}
export type FeedState = "connecting" | "live" | "lost" | "stopped";
export interface FeedHandlers { onFrame(frame: FeedFrame): void; onState(state: FeedState, detail?: string): void }
export interface FrameFeed { start(): void; requestKeyframe(): void; stop(): void }

export type HandshakeStep = { await: string } | { send: string } | { waitMs: number };
// S9 Q1 confirms or amends this; it is the vendored client's "#shared" sequence.
export const RECORDER_HANDSHAKE: readonly HandshakeStep[] = [
  { await: "MODE websockets" }, { send: "STOP_VIDEO" }, { waitMs: 250 }, { send: "START_VIDEO" },
];
export const KEY_REQUEST_MIN_GAP_MS = 250;
export const FEED_BACKOFF_MS = [500, 1000, 2000, 4000] as const;  // then 4000 forever

export interface SelkiesFeedOptions {
  endpoint(): StreamEndpoint | undefined;  // re-read before every dial: ports change on restart (Part 2 RF 2)
  clock: Clock;
  handlers: FeedHandlers;
  handshake?: readonly HandshakeStep[];    // default RECORDER_HANDSHAKE
  dialTimeoutMs?: number;                  // default 10_000 (the proxy's UPSTREAM_TIMEOUT_MS)
  pingEveryMs?: number;                    // default STREAM_PING_MS (500)
  stallAfterMs?: number;                   // default STREAM_STALL_MS (1500)
}
export class SelkiesFeed implements FrameFeed {
  constructor(opts: SelkiesFeedOptions);
  start(): void;
  requestKeyframe(): void;  // sends "REQUEST_KEYFRAME" while open, at most once per KEY_REQUEST_MIN_GAP_MS
  stop(): void;             // closes, never reconnects, reports "stopped"
}
```

`wire.ts` and `annexb.ts`, complete (the byte formats; verified against the synthetic stream):

```ts
// Selkies 2.0's WebSocket video message, as its client (apps/web/vendor/selkies, selkies-core)
// parses it: byte 0 is the message type (4 = encoded video); byte 1 holds the codec in its high
// nibble (1 = H.264) and 1 in its low nibble for a key frame; then u16 BE frame id, u16 BE region
// index, u16 BE width, u16 BE height, u16 BE reserved, and the Annex B access unit.

export const VIDEO_MESSAGE = 4;
export const VIDEO_HEADER = 12;
export const CODEC_H264 = 1;

export type SelkiesMessage =
  | { kind: "video"; key: boolean; codec: number; frameId: number; region: number; width: number; height: number; data: Uint8Array }
  | { kind: "ignored"; type: number };

export function parseSelkiesMessage(buf: Uint8Array): SelkiesMessage {
  const type = buf[0] ?? -1;
  if (type !== VIDEO_MESSAGE || buf.length <= VIDEO_HEADER) return { kind: "ignored", type };
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = v.getUint8(1);
  return {
    kind: "video",
    key: (flags & 0x0f) === 1,
    codec: flags >> 4,
    frameId: v.getUint16(2),
    region: v.getUint16(4),
    width: v.getUint16(6),
    height: v.getUint16(8),
    data: buf.subarray(VIDEO_HEADER),
  };
}
```

```ts
// NAL unit types of an Annex B access unit (start codes 00 00 01 or 00 00 00 01).
export function nalTypes(au: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      out.push((au[i + 3] ?? 0) & 0x1f);
      i += 2;
    }
  }
  return out;
}

export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

// A recording may start only on a frame a decoder can start from: an IDR with its parameter sets.
export function isRandomAccess(au: Uint8Array): boolean {
  const t = nalTypes(au);
  return t.includes(NAL_IDR) && t.includes(NAL_SPS) && t.includes(NAL_PPS);
}

// RFC 6381 avc1.PPCCLL from the first SPS: profile_idc, constraint flags, level_idc.
export function avcCodecString(au: Uint8Array): string | null {
  for (let i = 0; i + 6 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && ((au[i + 3] ?? 0) & 0x1f) === NAL_SPS) {
      const hex = (b: number | undefined) => (b ?? 0).toString(16).padStart(2, "0");
      return `avc1.${hex(au[i + 4])}${hex(au[i + 5])}${hex(au[i + 6])}`;
    }
  }
  return null;
}
```

**Tests:**
- `wire.test.ts` (verified):
  - `"parses a key H.264 frame and its header"`: flags `0x11`, frame id 513, 2560×1600. The
    payload is the same bytes.
  - `"reads a delta frame, ignores other message types and empty video"`: flags `0x10` is a delta;
    type 3 (JPEG), an empty video payload and an empty buffer are all `ignored`.
  - `"finds parameter sets and the IDR, and the codec string"`: `nalTypes(key) = [7, 8, 5]`,
    `isRandomAccess` is true only for the key frame, and `avcCodecString(key) = "avc1.42c01e"`.
- `testing/fake-selkies.ts` exports
  `startFakeSelkies(opts: { authorization: string; keyEvery?: number; fps?: number }): Promise<FakeSelkies>`,
  with `FakeSelkies { baseUrl: string; requests: { url: string; headers: IncomingHttpHeaders }[]; texts: string[]; waitForText(text: string): Promise<void>; closeAll(): void; silence(): void; sendRaw(bytes: Uint8Array): void; close(): Promise<void> }`.
- `testing/fake-feed.ts` exports `FakeFeed implements FrameFeed`, with
  `attach(handlers): FrameFeed`, `frame(synth: SynthFrame, arrivalMicros, width, height)`,
  `started`, `stopped` and `keyRequests: number[]`. The session recorder's tests (Tasks 10 and 11)
  drive it. Its code is in Task 10.
- `feed.test.ts`, against `testing/fake-selkies.ts`. That is a `ws` server on `127.0.0.1:0` (a
  non-Docker test, so it may run on the test's thread). It requires the `Authorization` header it
  was given, sends `MODE websockets` on connect, starts sending synthetic frames with the 12-byte
  header after `START_VIDEO`, logs every text message received, and can close, go silent (stop
  answering pings) or send a non-H.264 message on command.
  - `"speaks the passive handshake and nothing else"`: the server's text log is exactly
    `["STOP_VIDEO", "START_VIDEO"]`, with ≥ 250 ms between them, after `MODE websockets`. No
    `SETTINGS`, `CLIENT_FRAME_ACK`, `_gz` or input message, ever, over 2 s of frames.
  - `"stamps frames with the daemon clock and flags only real key frames"`: with a fake `Clock`,
    `arrivalMicros` equals the clock at delivery. A message whose wire flag says key but whose
    payload has no SPS gives `key: false`.
  - `"asks for a key frame at most every 250 ms"`: 10 `requestKeyframe()` calls within 100 ms
    send exactly one `REQUEST_KEYFRAME`.
  - `"drops frames of another codec or region and reports it once"`: a VP8 message (flags `0x21`)
    and a region-1 message give no `onFrame` and one `onState("live", "ignored a non-H.264 or
    striped frame")`.
  - `"redials with backoff after the cell closes the socket, re-reading the endpoint"`: the first
    server closes. `endpoint()` then names a second server, and the feed reaches it after 500 ms.
    The states go `connecting → live → lost → connecting → live`.
  - `"treats 1.5 s without a message or pong as lost and redials"`: the server goes silent, and
    the state is `lost` within 1.5–2.0 s.
  - **`"sends the stream credential only in the Authorization header"`** (complete; the credential
    is the cell's):

```ts
it("sends the stream credential only in the Authorization header", async () => {
  const secret = "Basic bG9jYWxkb3Q6czktdGVzdC1ub3QtYS1zZWNyZXQ=";
  const server = await startFakeSelkies({ authorization: secret });
  const logs: string[] = [];
  const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" "))));
  const states: string[] = [];
  const feed = new SelkiesFeed({ endpoint: () => ({ baseUrl: server.baseUrl, authorization: secret }), clock: monotonicClock(), handlers: { onFrame: () => {}, onState: (s, d) => void states.push(`${s} ${d ?? ""}`) } });
  feed.start();
  await server.waitForText("START_VIDEO");
  server.closeAll();
  await vi.waitFor(() => expect(states.some((s) => s.startsWith("lost"))).toBe(true));
  feed.stop();
  expect(server.requests.every((r) => r.headers.authorization === secret)).toBe(true);
  expect(server.requests.every((r) => !r.url.includes("czktdGVzdC") && !r.url.includes("s9-test"))).toBe(true);
  expect([...logs, ...states].some((l) => l.includes("czktdGVzdC") || l.includes("s9-test"))).toBe(false);
  for (const s of spies) s.mockRestore();
  await server.close();
});
```
  - `"stop() closes and never redials"`: after `stop()`, the server sees no connection within 5 s,
    and the last state is `stopped`.

**Implementation notes:**
- Dial `endpoint.baseUrl.replace(/^http/, "ws") + "/api/websockets"` with
  `new WebSocket(url, { headers: { authorization }, perMessageDeflate: false })`, exactly as
  `relay()` in `stream-proxy.ts` does. The same dial timeout applies: terminate a socket that
  isn't open after 10 s.
- The handshake runs on the socket's text messages: `await` waits for an exact text, `send` sends
  one, `waitMs` sleeps. Text messages outside the handshake are ignored.
- Binary messages go through `parseSelkiesMessage`. Keep `kind: "video"`, `codec === CODEC_H264`
  and `region === 0`. The rest are counted and reported once per connection as above.
- Liveness reuses Part 2's `StallWatchdog` (`apps/daemon/src/cells/watchdog.ts`) with
  `STREAM_PING_MS`/`STREAM_STALL_MS`, touched on every message and pong.
- Reconnect after `lost`: backoff `FEED_BACKOFF_MS`, then 4 s forever while `endpoint()` returns
  one. A dial that finds no endpoint (the cell is restarting) waits for the next backoff step.
- Never log the endpoint's authorization or the base URL's port pairing with it. Errors are logged
  as `recorder feed for session <id>: <code>` by the session recorder, never with the URL.
- **`FEED_MODE = tap-viewer` (only if S9 Q7 says so).** Then `ViewerTapFeed implements FrameFeed`
  subscribes to the upstream messages of the first live relay of the cell. This needs a
  `CellStreams.tap(cellId, listener): () => void` hook in `stream-proxy.ts`, called from
  `relay()`'s `upstream.on("message")`. It dials its own `SelkiesFeed` only while the cell has no
  relay. Switching sources requests a key frame, and the session recorder drops frames until it
  arrives (its "drop until key" path, Task 10). Nothing else changes.

- [ ] **Step 1:** Write `wire.test.ts`, `feed.test.ts` and the fakes. Run
  `pnpm exec vitest run apps/daemon/src/recorder/wire.test.ts apps/daemon/src/recorder/feed.test.ts`.
  Expected: FAIL.
- [ ] **Step 2:** Add `wire.ts` and `annexb.ts` as above, and implement `feed.ts` with the
  handshake, key requests, liveness and backoff. Use the S9 values. Run the same command.
  Expected: PASS.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/recorder
git commit -m "feat(recorder): passive Selkies client that stamps every access unit on arrival"
```

**Acceptance:** both suites pass. The handshake and constants match `spikes/s9-recorder/FINDINGS.md`.

---

### Task 10: Daemon — the session recorder and the Recorder service

`SessionRecorder` runs one session's recording: feed → gate → writer, plus the policies around it
(key frame cadence, idle flush, activity spans, disk floor, size cap, stream loss, format change,
backlog, and the manifest). `Recorder` owns them for every live session. It hooks into
`LiveSessions`, so recording starts before a session's first step and finalizes after its last.
It recovers anything left mid-recording when the daemon starts, and finalizes on shutdown.

**Review tier:** light. The privacy gate it calls is Task 11 (`full`).

**Files:**
- Create: `apps/daemon/src/recorder/session-recorder.ts`, `apps/daemon/src/recorder/recorder.ts`,
  `apps/daemon/src/recorder/disk.ts`, `apps/daemon/src/recorder/manifest.ts`
- Modify: `apps/daemon/src/gateway/live.ts` (hooks), `apps/daemon/src/main.ts` (wiring, startup
  recovery, shutdown)
- Test: `apps/daemon/src/recorder/session-recorder.test.ts`,
  `apps/daemon/src/recorder/diskfull-session.test.ts`, `apps/daemon/src/recorder/recorder.test.ts`,
  `apps/daemon/src/gateway/live.test.ts` (new cases)

**Interfaces** (exact):

```ts
// apps/daemon/src/recorder/session-recorder.ts
export const KEYFRAME_EVERY_MICROS = 2_000_000;   // ask for an IDR after 2 s of frames without one (S9 Q5/Q6 may set 0: never)
export const IDLE_FLUSH_MICROS = 500_000;         // no frame for 500 ms: flush the pending frame, ask for one IDR
export const MIN_FREE_START_BYTES = 2 * 1024 ** 3;
export const MIN_FREE_RUN_BYTES = 1024 ** 3;
export const SESSION_CAP_BYTES = 8 * 1024 ** 3;
export const MAX_QUEUED_BYTES = 64 * 1024 ** 2;    // frames waiting for the writer
export const TICK_MS = 100;                        // the service calls tick() this often
export const DISK_CHECK_MICROS = 10_000_000;
export const MANIFEST_WRITE_MICROS = 1_000_000;    // at most one manifest write a second while recording

// Task 11 provides ControlGate; until then the default admits everything.
export interface FrameGate {
  observe(e: LocalDotEvent): "took" | "returned" | null;
  admit(tMicros: number, key: boolean): boolean;
  readonly gaps: RecordingGap[];
}

export interface SessionRecorderDeps {
  sessionId: string;
  dir: string;                                                    // <home>/sessions/<id>/recording
  feed(handlers: FeedHandlers): FrameFeed;                        // a SelkiesFeed for the session's cell
  toSessionT(daemonMicros: number): number;                       // EventLog.toSessionT, bound to the session
  freeBytes(dir: string): number;                                 // disk.ts
  fs?: RecordingFs;
  backlog?: readonly LocalDotEvent[];                             // the session's events so far
  subscribe?(listener: (e: LocalDotEvent) => void): () => void;   // the session's later events
  gate?: FrameGate;
  queueLimitBytes?: number;
}

export class SessionRecorder {
  constructor(deps: SessionRecorderDeps);
  start(): Promise<void>;          // free-space floor, manifest "recording", feed.start()
  ready(): Promise<boolean>;       // true at the first key frame journaled; false if start declined or failed
  drain(): Promise<void>;          // every frame handed in so far has been handled
  tick(nowDaemonMicros: number): Promise<void>;  // idle flush, key cadence, disk floor, manifest write
  stop(endDaemonMicros: number): Promise<RecordingManifest>;  // finish, final manifest; never throws
  readonly manifest: RecordingManifest;           // own gaps and the gate's, merged and sorted by `from`
  readonly entries: readonly FragmentEntry[];
}

// apps/daemon/src/recorder/recorder.ts
export const RECORDER_START_TIMEOUT_MS = 3000;
export const SHUTDOWN_FINALIZE_MS = 5000;
export interface RecorderDeps {
  home: string;
  eventLog: EventLog;
  cells: Pick<CellApi, "get" | "endpoints">;
  clock: Clock;
  enabled?: boolean;                                              // LOCALDOT_RECORDING !== "0"
  freeBytes?(dir: string): number;
  feedFor?(cellId: string, handlers: FeedHandlers): FrameFeed;    // default: a SelkiesFeed on cells.endpoints(cellId).stream
  startTimeoutMs?: number;
}
export interface LiveRecording { manifest: RecordingManifest; live: boolean; entries: readonly FragmentEntry[] }
export class Recorder {
  constructor(deps: RecorderDeps);
  recoverAll(): Promise<{ recovered: number; failed: number }>;   // before the daemon serves
  start(cellId: string, sessionId: string): Promise<void>;        // LiveSessions.beforeRun; never throws
  stop(sessionId: string): Promise<void>;                         // LiveSessions.afterRun; never throws
  stopAll(timeoutMs?: number): Promise<void>;                     // SIGTERM
  info(sessionId: string): LiveRecording | undefined;             // live: memory; else manifest.json and fragments.jsonl
  isLive(sessionId: string): boolean;
}

// apps/daemon/src/recorder/disk.ts
export function freeBytes(dir: string): number;   // statfsSync(dir): bavail × bsize; 0 when it throws

// apps/daemon/src/recorder/manifest.ts
export function writeManifest(dir: string, m: RecordingManifest): void;   // temp file + rename, mode 0600
export function readManifest(dir: string): RecordingManifest | null;      // null when absent or invalid

// apps/daemon/src/gateway/live.ts (Part 3's LiveSessions, extended)
export interface LiveHooks {
  beforeRun?(cellId: string, sessionId: string): Promise<void>;
  afterRun?(cellId: string, sessionId: string): Promise<void>;
}
// LiveSessions gains:
//   addHooks(hooks: LiveHooks): () => void;
// start(cellId, sessionId, run) awaits every beforeRun, then run(signal), then every afterRun,
// each hook's rejection logged and swallowed; get(cellId) names the session from the start call on.
```

**Frame path** (`#frame`, run strictly in order on a promise chain):
1. `t = toSessionT(frame.arrivalMicros)`; `key = frame.key`.
2. `gate.admit(t, key)`, else drop.
3. Before the writer exists:
   - drop delta frames, asking for a key frame at most every 500 ms;
   - on the first key frame, take `codec = avcCodecString(data)`, `width` and `height`;
   - write the manifest (`recording`, codec, size, `firstMicros: t`);
   - only then create and start the `RecordingWriter`.

   The manifest goes first so that recovery always knows the format.
4. A later key frame whose codec or size differs ends the recording: `#end("recorder-error")`,
   with note `the stream changed format`.
5. `writer.push`. A rejection whose `code` is `ENOSPC` calls `#fail("disk-full")`; any other calls
   `#fail("recorder-error")`.
6. Activity: extend the last span if `t − last.to ≤ ACTIVITY_JOIN_MICROS`, else open
   `{ from: t, to: t }`.
7. Cadence: if `t − lastKeyT ≥ KEYFRAME_EVERY_MICROS` and no request was made in the last
   `KEYFRAME_EVERY_MICROS / 2`, call `feed.requestKeyframe()`.

**Policies:**
- **Backlog.** Track the bytes of frames queued but not yet handled. Above `queueLimitBytes`:
  - drop incoming frames;
  - open a gap `recorder-error` at the first dropped frame;
  - request a key frame;
  - resume at the next admitted key frame, which closes the gap.
- **Stream loss.**
  - `onState("lost")` opens a `stream-lost` gap at the last frame's `t`.
  - After `live` returns, drop until the next key frame (and request one), then close the gap at
    that frame.
  - A recording never resumes on a delta frame after a gap, of any kind.
- **Idle** (`tick`). With the writer started and `now − lastT ≥ IDLE_FLUSH_MICROS`, once per idle
  period, call `writer.flushIdle(now)` and `feed.requestKeyframe()`. If Selkies honours that on a
  still screen (S9 Q5), the fragment holding the last change commits at once, and a reader of the
  live session sees it.
- **Disk** (`tick`, every `DISK_CHECK_MICROS`). If `freeBytes < MIN_FREE_RUN_BYTES`, call
  `#end("disk-full", now)`. That is a clean finish: the state is `complete`, with a gap from `now`
  to `null`.
- **Size cap.** On a commit whose `endOffset ≥ SESSION_CAP_BYTES`, call
  `#end("size-cap", entry.endMicros)`.
- **`#end(reason, at)`:** stop the feed and the subscription, `writer.finish(at)`,
  state `complete` (or `failed` when no writer existed), push the gap, write the manifest.
- **`#fail(reason, at)`:** stop the feed and the subscription, `writer.close()`, then
  `recoverRecording(dir, format)`. The state comes from its result. The gap `{ from: result.lastMicros ?? at, to: null, reason }`
  is pushed, and the manifest written. Recovery's own failure (still ENOSPC) leaves the state
  `recovered` with whatever `fragments.jsonl` covers: the view serves that prefix with a fresh
  `mfra`.
- **`stop(end)`:** drain the queue. If the recording is still running: `writer.finish(end)`, state
  `complete`. Without a writer, state `failed`, note `no key frame arrived`. Write the manifest and
  return it. Never throws.
- **Errors never reach the session.** No `SessionRecorder` method rejects into `LiveSessions`, and
  the session's run cannot see the recorder.

**Recorder service:**
- `start(cellId, sessionId)` does the following, never throwing:
  - if recording is off (`LOCALDOT_RECORDING=0`), writes manifest `none` with note
    `recording is off` and returns;
  - otherwise creates the `SessionRecorder` with:
    - `dir` = `<home>/sessions/<id>/recording`;
    - `feed` = `feedFor(cellId, h)`, by default `new SelkiesFeed({ endpoint: () => cells.endpoints(cellId)?.stream, clock, handlers: h })`;
    - `toSessionT` = `(us) => eventLog.toSessionT(sessionId, us)`;
    - `backlog` = `eventLog.read(sessionId)`;
    - `subscribe` = `eventLog.subscribe` filtered to the session;
  - starts a `TICK_MS` interval that calls `tick(clock.nowMicros())`;
  - awaits `ready()` for at most `startTimeoutMs`. Missing that deadline is not an error: video
    may still arrive.
- `stop(sessionId)` clears the interval and calls `stop(clock.nowMicros())`.
- `recoverAll()`: for every `<home>/sessions/<ULID>/recording/manifest.json` in state `recording`,
  run `recoverRecording(dir)`, then write the manifest as `recovered` (or `failed`, note
  `the daemon stopped while recording`), keeping its activity and gaps. Add a gap
  `{ from: result.lastMicros, to: null, reason: "recorder-error" }`. A recording dir without a
  manifest (the daemon died before the first key frame) is removed.
- `main.ts`:
  - after building `EventLog`, the orchestrator and `LiveSessions`:
    `const recorder = new Recorder({ home, eventLog, cells: orchestrator, clock, enabled: process.env.LOCALDOT_RECORDING !== "0" })`,
    then `await recorder.recoverAll()` **before** `serve()`;
  - `live.addHooks({ beforeRun: (c, s) => recorder.start(c, s), afterRun: (_c, s) => recorder.stop(s) })`;
  - the existing SIGTERM and SIGINT path awaits `recorder.stopAll(SHUTDOWN_FINALIZE_MS)` before
    closing the event log and releasing the lock;
  - `createApp` receives `recorder` (Task 12's routes).
- `LiveSessions.start` (Part 3's `live.ts`): the run becomes
  `void (async () => { for (const h of hooks) await h.beforeRun?.(…).catch(log); try { await run(signal) } catch (err) { log } finally { for (const h of hooks) await h.afterRun?.(…).catch(log); delete if still ours } })()`.
  `get(cellId)` holds the session from the synchronous part of `start`, so the puppet route's
  202 + `/live` behaviour is unchanged.

**Tests:**
- `session-recorder.test.ts` (with `FakeFeed`, the synthetic stream, and `toSessionT: (us) => us`):
  - `"writes the manifest with the format before the first frame is muxed"`: after the first key
    frame, `manifest.json` names the codec `avc1.42c01e`, 64×64 and `firstMicros`, and the
    `fragments.jsonl` file doesn't exist yet.
  - `"drops delta frames until the first key frame and asks for one"`: three deltas, then a key.
    One key request, and the recording starts at the key's `t`.
  - `"asks for a key frame after 2 s of frames without one"`: 150 deltas after a key at 60 fps.
    Exactly one request near 2 s, and another near 3 s (the `/ 2` limiter).
  - `"flushes the pending frame and asks for a key frame once per idle period"`: frames stop, and
    `tick` at +400 ms does nothing, while at +500 ms it flushes once and requests once. Further
    ticks add nothing until frames resume.
  - `"joins frames into activity spans 500 ms apart"`: bursts 300 ms and 800 ms apart give 2 spans.
  - `"opens a stream-lost gap and resumes only at a key frame"`: `onState("lost")` at the 40th
    frame, `live` at the 50th, deltas, then a key at the 60th. The gap is `{ from: t(39), to: t(60) }`,
    and no packet lies in between.
  - `"ends with recorder-error when the stream changes format"`: a second key frame at 128×128.
  - `"drops frames over the backlog limit and resumes at a key frame"`: `queueLimitBytes: 50_000`.
    200 frames are handed in synchronously before `drain`. There is a `recorder-error` gap with a
    `to`, and the recording is valid (every packet decodable in order: a key at each fragment
    start).
  - `"stops at the size cap"`: with the cap overridden to 100 kB through a test-only option
    (`sizeCapBytes`), the state is `complete` with a `size-cap` gap.
  - `"never throws into the caller"`: a feed whose `start()` throws gives a manifest `failed` with
    note `the stream could not be opened`, and `stop()` resolves.
- `diskfull-session.test.ts`: **the Review Focus 3 pin (session)**, complete code below.
- `recorder.test.ts` (a real `EventLog` in a temp home, a real `LiveSessions`, `feedFor` returning
  a `FakeFeed` that a test timer drives):
  - `"records a live session from its first step to its end"`: the manifest is `complete`, the
    video holds every fed frame, and `info().live` is false after the run.
  - `"waits for the first key frame at most startTimeoutMs, then runs the session anyway"`: a feed
    that never sends. The run starts after `startTimeoutMs` (200 in the test), and the final
    manifest is `failed`.
  - `"runs the session when recording is off"`: `enabled: false` gives a manifest `none`, and the
    run is unaffected.
  - `"recovers a recording left in recording state at startup"`: a writer abandoned mid-session
    and a manifest in `recording`. `recoverAll()` gives `recovered` with a `recorder-error` gap and
    a playable file.
  - `"removes a recording dir that never got its first key frame"`.
  - `"finalizes live recordings on stopAll within the timeout"`.
- `live.test.ts`:
  - `"awaits beforeRun before the run and afterRun after it, even when the run throws"`;
  - `"keeps get(cellId) for the session from start on, through the hooks"`;
  - `"swallows a rejecting hook"`.

**The Review Focus 3 pin (session), complete** (verified against a prototype):

`apps/daemon/src/recorder/testing/fake-feed.ts`:
```ts
import type { SynthFrame } from "@localdot/stage/testing";
import type { FeedHandlers, FrameFeed } from "../feed.ts";

// A FrameFeed the test drives: frames go in with an arrival stamp, key requests and stops are counted.
export class FakeFeed implements FrameFeed {
  handlers: FeedHandlers | null = null;
  started = false;
  stopped = false;
  keyRequests: number[] = [];
  #lastArrival = 0;

  attach(h: FeedHandlers): FrameFeed {
    this.handlers = h;
    return this;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  requestKeyframe(): void {
    this.keyRequests.push(this.#lastArrival);
  }
  frame(f: SynthFrame, arrivalMicros: number, width: number, height: number): void {
    this.#lastArrival = arrivalMicros;
    if (!this.stopped) this.handlers?.onFrame({ arrivalMicros, key: f.key, width, height, data: f.data });
  }
}
```

`apps/daemon/src/recorder/diskfull-session.test.ts`:
```ts
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { MIN_FREE_RUN_BYTES, MIN_FREE_START_BYTES, SessionRecorder } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";
import { fullAfter } from "./testing/full-fs.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
const GiB = 1024 ** 3;
const at = (i: number) => 1_000_000 + i * 16_667;

async function packetsIn(file: string): Promise<number[]> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
  const t: number[] = [];
  for await (const p of sink.packets()) t.push(p.microsecondTimestamp);
  input.dispose();
  return t;
}

describe("disk full (Review Focus 3), the session", () => {
  it("stops the recording at ENOSPC, never the session, and keeps a playable prefix marked disk-full", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's full-session-")), "recording");
    const feed = new FakeFeed();
    const rec = new SessionRecorder({ sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", dir, feed: (h) => feed.attach(h), toSessionT: (us) => us, freeBytes: () => 50 * GiB, fs: fullAfter(400_000) });
    await rec.start();
    // Frames keep coming after the disk fills: none of them may throw into the feed.
    for (let i = 0; i < 2000; i++) feed.frame(synthFrame(o, i), at(i), 64, 64);
    await rec.drain();
    const m = rec.manifest;
    expect(m.state).toBe("recovered");
    expect(feed.stopped).toBe(true);
    const gap = m.gaps.find((g) => g.reason === "disk-full");
    expect(gap).toMatchObject({ to: null });
    const recorded = await packetsIn(join(dir, "video.mp4"));
    expect(recorded.length).toBeGreaterThan(50);
    expect(recorded.at(-1)).toBeLessThanOrEqual(gap?.from as number);
    expect(recorded).toEqual(Array.from({ length: recorded.length }, (_, i) => at(i)));
    // Ending the session afterwards reports the same manifest and does not throw.
    expect((await rec.stop(at(2001))).state).toBe("recovered");
  });

  it("does not start below the free-space floor and says why", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's floor-")), "recording");
    const feed = new FakeFeed();
    const rec = new SessionRecorder({ sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", dir, feed: (h) => feed.attach(h), toSessionT: (us) => us, freeBytes: () => MIN_FREE_START_BYTES - 1 });
    await rec.start();
    expect(feed.started).toBe(false);
    expect(rec.manifest).toMatchObject({ state: "none", note: "not enough free disk space" });
    expect(existsSync(join(dir, "video.mp4"))).toBe(false);
  });

  it("finishes the recording cleanly when free space falls below the running floor", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's low-")), "recording");
    const feed = new FakeFeed();
    let free = 50 * GiB;
    const rec = new SessionRecorder({ sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", dir, feed: (h) => feed.attach(h), toSessionT: (us) => us, freeBytes: () => free });
    await rec.start();
    for (let i = 0; i < 100; i++) feed.frame(synthFrame(o, i), at(i), 64, 64);
    await rec.drain();
    free = MIN_FREE_RUN_BYTES - 1;
    await rec.tick(at(100));
    expect(feed.stopped).toBe(true);
    expect(rec.manifest.state).toBe("complete");
    expect(rec.manifest.gaps).toEqual([{ from: at(100), to: null, reason: "disk-full" }]);
    expect(await packetsIn(join(dir, "video.mp4"))).toHaveLength(100);
  });
});
```

- [ ] **Step 1:** Write the tests above and the `live.test.ts` cases. Run
  `pnpm exec vitest run apps/daemon/src/recorder apps/daemon/src/gateway/live.test.ts`.
  Expected: FAIL (the modules and `addHooks` are missing).
- [ ] **Step 2:** Implement `disk.ts`, `manifest.ts`, `session-recorder.ts` (with an admit-all
  default gate), `recorder.ts`, the `LiveSessions` hooks and the `main.ts` wiring. Run the same
  command, then `pnpm exec vitest run apps/daemon/src`.
  Expected: PASS. Every Part 2 and Part 3 daemon suite stays green.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(recorder): record every live session in the daemon, whoever watches"
```

**Acceptance:** the suites pass. Start the daemon with `node --import tsx src/main.ts`, run a
puppet session on a ready cell **with no browser open**, then
`ls ~/.localdot/sessions/<id>/recording`.
Expected: `video.mp4 fragments.jsonl manifest.json` and no `journal/`. `manifest.json` says
`complete`, with the codec S9 found. `ffprobe -v error -show_entries stream=codec_name,width,height recording/video.mp4`
exits 0 and names `h264` and the cell's size.

---

### Task 11: Recording pauses while the user has control (privacy)

Takeover exists for exactly the moments a recording must not keep: logins, 2FA codes, CAPTCHAs and
payment fields (spec, "Safety and control"). The model receives no screenshot during takeover, and
the recording keeps no frame either. The control changes come from M5 (`control.change`, whose
schema already exists). This task makes the recorder honour them from M6 on. A frame is judged by
its own session time, so a frame that waited in the recorder's queue behind a `control.change`
cannot slip through. After control returns, recording resumes only at a key frame. The journal
never sees a user-era frame, so a crash during a takeover leaves none on disk.

**Review tier:** **full**. It is part of takeover (`jobs/PROCESS.md`): a missed frame here records a
password field or a card number.

**Files:**
- Create: `apps/daemon/src/recorder/control-gate.ts`
- Modify: `apps/daemon/src/recorder/session-recorder.ts` (`gate` defaults to `new ControlGate()`;
  `observe` returning `"returned"` calls `feed.requestKeyframe()`), `apps/daemon/src/recorder/recorder.ts`
  (passes the backlog and the subscription, already in Task 10)
- Test: `apps/daemon/src/recorder/control-gate.test.ts`

**Interfaces:** `ControlGate implements FrameGate` (Task 10's interface), exactly as below.

**Production code, complete** (security boundary):

`apps/daemon/src/recorder/control-gate.ts`:
```ts
import type { LocalDotEvent, RecordingGap } from "@localdot/protocol";

interface UserSpan {
  from: number;
  to: number | null;
  // The first frame recorded after `to`: a key frame, since deltas would need the dropped references.
  resumedAt: number | null;
}

// Privacy (P7-R10): while the user has control (M5's takeover: logins, 2FA, CAPTCHAs, payment) the
// recorder keeps no frame, not even in its journal. A frame is judged by its own session time
// against the control changes in the log, so a frame that waited in the recorder's queue behind a
// control.change is still judged correctly. Frames reach `admit` in arrival order; control changes
// may be observed before frames older than them.
export class ControlGate {
  readonly #spans: UserSpan[] = [];

  // Every event of the session, in log order: the backlog at start, then live appends.
  // Returns "returned" when control came back, so the caller asks for a key frame.
  observe(e: LocalDotEvent): "took" | "returned" | null {
    if (e.type !== "control.change") return null;
    const open = this.#spans.at(-1);
    if (e.data.holder === "user") {
      if (open && open.to === null) return null;
      this.#spans.push({ from: e.t, to: null, resumedAt: null });
      return "took";
    }
    if (!open || open.to !== null) return null;
    open.to = e.t;
    return "returned";
  }

  admit(tMicros: number, key: boolean): boolean {
    let before: UserSpan | undefined;
    for (const s of this.#spans) {
      if (tMicros >= s.from && (s.to === null || tMicros < s.to)) return false;
      if (s.to !== null && s.to <= tMicros) before = s;
    }
    if (before && before.resumedAt === null) {
      if (!key) return false;
      before.resumedAt = tMicros;
    }
    return true;
  }

  get userHasControl(): boolean {
    return this.#spans.at(-1)?.to === null;
  }

  // No video from a takeover until the first frame recorded after it; takeovers whose video never
  // came back in between are one gap.
  get gaps(): RecordingGap[] {
    const out: RecordingGap[] = [];
    for (const s of this.#spans) {
      const last = out.at(-1);
      if (last && (last.to === null || s.from <= last.to)) last.to = s.resumedAt;
      else out.push({ from: s.from, to: s.resumedAt, reason: "user-control" });
    }
    return out;
  }
}
```

**The pins, complete** (verified against the prototype of Task 10 with this gate):

`apps/daemon/src/recorder/control-gate.test.ts`:
```ts
import * as fs from "node:fs";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalDotEvent } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { ControlGate } from "./control-gate.ts";
import { decodeJournal } from "./journal.ts";
import { recoverRecording } from "./recover.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";
import type { RecordingFs } from "./writer.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 15 };
const at = (i: number) => 500_000 + i * 16_667;
const TAKE = 1_000_000;
const GIVE = 2_000_000;
let seq = 0;
const control = (t: number, holder: "user" | "agent"): LocalDotEvent =>
  ({ v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: seq++, t, agent: "main", type: "control.change", data: { holder, reason: holder === "user" ? "user_takeover" : "resume" } }) as LocalDotEvent;

// Every byte the recorder appends to its journal, decoded: what a crash would leave behind.
function journalSpy(): RecordingFs & { journaled: number[] } {
  const journaled: number[] = [];
  return {
    ...fs,
    journaled,
    appendFileSync: ((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
      if (String(file).includes(`${join("recording", "journal")}`) && typeof data !== "string") for (const r of decodeJournal(data)) journaled.push(r.tMicros);
      fs.appendFileSync(file, data);
    }) as typeof fs.appendFileSync,
  };
}

async function recordedTimes(file: string): Promise<number[]> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
  const t: number[] = [];
  for await (const p of sink.packets()) t.push(p.microsecondTimestamp);
  input.dispose();
  return t;
}

describe("the takeover privacy gate (Review Focus 6, full tier)", () => {
  it("records nothing while the user has control, not even in the journal, and resumes at a key frame", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's gate-")), "recording");
    const feed = new FakeFeed();
    const spy = journalSpy();
    const listeners: ((e: LocalDotEvent) => void)[] = [];
    const rec = new SessionRecorder({ sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", dir, feed: (h) => feed.attach(h), toSessionT: (us) => us, freeBytes: () => 1024 ** 4, fs: spy, subscribe: (l) => { listeners.push(l); return () => {}; } });
    await rec.start();
    const frames = Array.from({ length: 150 }, (_, i) => i);
    let took = false;
    let requestsWhenGiven = -1;
    for (const i of frames) {
      // The control changes reach the log between frames, as M5's routes append them.
      if (!took && at(i) >= TAKE) {
        took = true;
        for (const l of listeners) l(control(TAKE, "user"));
      }
      if (requestsWhenGiven < 0 && at(i) >= GIVE) {
        requestsWhenGiven = feed.keyRequests.length;
        for (const l of listeners) l(control(GIVE, "agent"));
      }
      feed.frame(synthFrame(o, i), at(i), 64, 64);
    }
    await rec.drain();
    const firstKeyBack = frames.map(at).find((t, i) => t >= GIVE && i % o.keyEvery === 0) as number;
    const userEra = (t: number) => t >= TAKE && t < firstKeyBack;
    expect(spy.journaled.filter(userEra)).toEqual([]);
    expect(feed.keyRequests.length).toBeGreaterThan(requestsWhenGiven);
    await rec.stop(at(150));
    const recorded = await recordedTimes(join(dir, "video.mp4"));
    expect(recorded.filter(userEra)).toEqual([]);
    expect(recorded).toEqual(frames.map(at).filter((t) => !userEra(t)));
    expect(rec.manifest.gaps).toEqual([{ from: TAKE, to: firstKeyBack, reason: "user-control" }]);
  });

  it("leaves no user frame on disk when the daemon dies during a takeover", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's gate-crash-")), "recording");
    const feed = new FakeFeed();
    const rec = new SessionRecorder({ sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", dir, feed: (h) => feed.attach(h), toSessionT: (us) => us, freeBytes: () => 1024 ** 4, backlog: [control(TAKE, "user")] });
    await rec.start();
    for (let i = 0; i < 90; i++) feed.frame(synthFrame(o, i), at(i), 64, 64);
    await rec.drain();
    // No stop(): the process is gone. Recovery works from what is on disk.
    await recoverRecording(dir);
    const files = readdirSync(dir);
    expect(files).not.toContain("journal");
    expect((await recordedTimes(join(dir, "video.mp4"))).every((t) => t < TAKE)).toBe(true);
  });

  it("judges frames by their own time, whatever order they and the control change are processed in", () => {
    const gate = new ControlGate();
    expect(gate.admit(999_999, false)).toBe(true);
    gate.observe(control(TAKE, "user"));
    expect(gate.admit(999_999, false)).toBe(true);
    expect(gate.admit(TAKE, true)).toBe(false);
    gate.observe(control(GIVE, "agent"));
    expect(gate.admit(GIVE - 1, true)).toBe(false);
    expect(gate.admit(GIVE + 10, false)).toBe(false);
    expect(gate.admit(GIVE + 20, true)).toBe(true);
    expect(gate.admit(GIVE + 30, false)).toBe(true);
    expect(gate.gaps).toEqual([{ from: TAKE, to: GIVE + 20, reason: "user-control" }]);
  });

  it("keeps one gap when control is taken again before the video came back", () => {
    const gate = new ControlGate();
    gate.observe(control(TAKE, "user"));
    gate.observe(control(GIVE, "agent"));
    expect(gate.admit(GIVE + 50, false)).toBe(false);
    gate.observe(control(GIVE + 100, "user"));
    gate.observe(control(GIVE + 500, "agent"));
    expect(gate.admit(GIVE + 300, true)).toBe(false);
    expect(gate.admit(GIVE + 600, true)).toBe(true);
    expect(gate.gaps).toEqual([{ from: TAKE, to: GIVE + 600, reason: "user-control" }]);
  });

  it("keeps two gaps when a key frame came back between two takeovers", () => {
    const gate = new ControlGate();
    for (const e of [control(TAKE, "user"), control(GIVE, "agent"), control(GIVE + 100, "user"), control(GIVE + 500, "agent")]) gate.observe(e);
    expect(gate.admit(GIVE + 50, true)).toBe(true);
    expect(gate.admit(GIVE + 600, true)).toBe(true);
    expect(gate.gaps).toEqual([
      { from: TAKE, to: GIVE + 50, reason: "user-control" },
      { from: GIVE + 100, to: GIVE + 600, reason: "user-control" },
    ]);
  });
});
```

**Review checklist** (`full` tier: review, fix round, scoped re-review, mutation testing, bypass
hunt). Each mutation below must fail at least one pin:
- `admit` checks `t > s.from` instead of `t >= s.from`;
- `admit` accepts a delta right after a span;
- `observe` ignores a second takeover;
- `gaps` drops the merge;
- the session recorder calls `writer.push` before `gate.admit`;
- the session recorder admits frames by processing order instead of by `t`;
- the backlog isn't folded at start.

Bypass hunt:
- a frame stamped exactly at the `control.change`'s `t`;
- a takeover appended while the queue holds older frames;
- a takeover and a feed reconnect together;
- `stopAll` during a takeover;
- recovery after a crash during a takeover (pinned).

- [ ] **Step 1:** Write `control-gate.test.ts`. Run
  `pnpm exec vitest run apps/daemon/src/recorder/control-gate.test.ts`.
  Expected: FAIL. `./control-gate.ts` does not exist.
- [ ] **Step 2:** Add `control-gate.ts` as above, and make it the session recorder's default gate.
  Run `pnpm exec vitest run apps/daemon/src/recorder`.
  Expected: PASS.
- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/recorder
git commit -m "feat(recorder): keep no frame while the user has control"
```

**Acceptance:** the pins pass, the mutation list is killed (record which test kills each in the
task report), and the bypass hunt finds nothing open.

---

### Task 12: Daemon — long logs, the session index, thumbnails, retention, the replay routes and the seeder

Everything the replay reads from the daemon:
- the event log, streamed as NDJSON in bounded memory;
- the session index, one `SessionCard` per session with a cover thumbnail;
- 320×200 thumbnails of `observe` frames;
- the recording by byte range (a stable snapshot for a live session);
- retention, so recordings cannot fill the disk.

It also fixes the one 2-hour cost in Part 1's `EventLog`, measured while writing this plan. Every
daemon start re-reads and re-indexes every session's whole log: 1.0 s per 2-hour log (150 000
events, 55 MB), at **every** start, even when nothing changed. With tail recovery the reopen takes
1 ms. Last, a seeder writes a synthetic session with a synthetic recording, which the browser
suites replay without Docker.

**Review tier:** light. The routes sit behind the existing token middleware, and their auth and
path pins are written out below.

**Files:**
- Create: `apps/daemon/src/sessions/{ndjson.ts,summary.ts,index-store.ts,thumbs.ts,retention.ts,routes.ts}`,
  `apps/daemon/src/recorder/testing/seed-session.ts`, `apps/daemon/src/seed-main.ts`
- Modify: `apps/daemon/src/event-log.ts` (tail recovery, `logFile`, `forget`),
  `apps/daemon/src/app.ts` (`replay` option), `apps/daemon/src/main.ts` (index, thumbnails,
  retention, routes), `apps/daemon/package.json` (`"seed-session": "tsx src/seed-main.ts"`)
- Test: `apps/daemon/src/sessions/{long-log.test.ts,summary.test.ts,index-store.test.ts,thumbs.test.ts,retention.test.ts,routes.test.ts,routes-security.test.ts}`,
  `apps/daemon/src/recorder/testing/seed-session.test.ts`; Part 1's `event-log.test.ts` must pass
  unchanged.

**Interfaces** (exact):

```ts
// apps/daemon/src/event-log.ts — added to EventLog
logFile(sessionId: string): string;   // <home>/sessions/<id>/events.jsonl; throws UnknownSessionError
forget(sessionId: string): void;      // removes the session's folder, its index rows and its cached state

// apps/daemon/src/sessions/ndjson.ts
export const NDJSON_TYPE = "application/x-ndjson";
// Complete lines inside the file's size at the call, each re-validated with parseEvent and
// re-serialised (unknown fields dropped), from fromSeq on; read through a 64 KiB stream buffer.
export function streamEventLines(file: string, fromSeq?: number): AsyncGenerator<string>;

// apps/daemon/src/sessions/summary.ts
export interface SessionSummaryFile extends SessionCard { logBytes: number }
export function summarizeSession(home: string, sessionId: string, opts: { live: boolean }): Promise<SessionSummaryFile>;
export function writeSummary(home: string, summary: SessionSummaryFile): void;          // <session>/summary.json, atomic
export function readSummary(home: string, sessionId: string): SessionSummaryFile | null;

// apps/daemon/src/sessions/index-store.ts
export const INDEX_PAGE_MAX = 100;
export class SessionIndex {
  constructor(home: string, opts: { isLive(sessionId: string): boolean });   // its own connection to <home>/index.sqlite
  page(opts: { before?: string; limit?: number }): Promise<SessionIndexPage>;  // newest first; cursor "<startedAt>~<id>"
  card(sessionId: string): Promise<SessionCard>;                              // throws UnknownSessionError
  invalidate(sessionId: string): void;
  close(): void;
}

// apps/daemon/src/sessions/thumbs.ts
export const THUMB_W = 320;
export const THUMB_H = 200;
export const THUMB_CONCURRENCY = 2;
export class Thumbnails {
  constructor(home: string, frames: FrameStore);
  path(sessionId: string, frameId: string): Promise<string | undefined>;  // undefined: no such frame
}

// apps/daemon/src/sessions/retention.ts
export interface RetentionPolicy { maxBytes: number; maxAgeDays: number }
export function retentionFromEnv(env?: NodeJS.ProcessEnv): RetentionPolicy;   // LOCALDOT_RECORDINGS_MAX_GB (default 20), LOCALDOT_RECORDINGS_MAX_DAYS (default 30)
export function sweepRecordings(o: { home: string; policy: RetentionPolicy; now: Date; isLive(id: string): boolean }): { expired: string[]; freedBytes: number };

// apps/daemon/src/sessions/routes.ts
export interface ReplayRoutesDeps {
  home: string;
  eventLog: EventLog;
  recorder: Pick<Recorder, "info" | "isLive">;
  index: SessionIndex;
  thumbs: Thumbnails;
}
export function replayRoutes(app: Hono, deps: ReplayRoutesDeps): void;
// app.ts: AppOptions gains `replay?: ReplayRoutesDeps`; createApp calls replayRoutes(app, replay)
// inside the /api/* token middleware, after Part 3's gatewayRoutes.

// apps/daemon/src/recorder/testing/seed-session.ts
export interface SeedOptions {
  home: string;
  minutes: number;                         // session length
  title?: string;                          // default "Seeded session"
  marker?: string;                         // a unique string put in the title and a typed (unmasked) chunk: the privacy test looks for it
  takeover?: { fromMs: number; toMs: number };  // a control.change pair; no frame is written inside
  video?: boolean;                         // default true; false: manifest "none"
  synth?: SynthOptions;                    // default { widthMbs: 20, heightMbs: 12, keyEvery: 24 } (320×192)
}
export interface SeedResult {
  sessionId: string;
  synth: SynthOptions;
  frames: { tMicros: number; index: number }[];         // every recorded frame: its arrival and its synth index
  steps: { id: string; startMs: number; endMs: number; dispatchMs: number; point: { x: number; y: number } }[];
}
export function seedSession(o: SeedOptions): Promise<SeedResult>;   // also writes <home>/seed-<sessionId>.json
```

**Routes** (all under `/api/*`, token required; every `:id` and `:frameId` must match
`ULID_PATTERN`, else 400 before any filesystem access):

| Route | Answer |
|---|---|
| `GET /api/session-index?before=<cursor>&limit=<1–100>` | `SessionIndexPage`. `limit` defaults to 50; out of range or not an integer gives 400; a malformed cursor gives 400 |
| `GET /api/sessions/:id/card` | `SessionCard`; 404 for an unknown session |
| `GET /api/sessions/:id/events` with `Accept: application/x-ndjson` | 200 `application/x-ndjson`, streamed from `streamEventLines(eventLog.logFile(id), fromSeq)`, with `cache-control: no-store`. Without that `Accept` header, Part 1's JSON array, unchanged |
| `GET /api/sessions/:id/recording` | `RecordingInfo`. A session with no `recording/` folder answers `manifest: emptyManifest("none")`, `upto: 0`, `servedBytes: 0` |
| `GET` and `HEAD /api/sessions/:id/recording/video.mp4?upto=<n>` | the view's bytes (`openRecordingView`; `complete` for the states `complete` and `recovered`). `upto` is required while live and ignored otherwise; above the committed count, or not an integer, it gives 400. Responses carry `content-type: video/mp4`, `accept-ranges: bytes` and `cache-control: no-store`. No `Range` gives 200 with `content-length`. One `bytes=a-b`, `bytes=a-` or `bytes=-n` range inside the size gives 206 with `content-range: bytes a-b/size`. Anything else gives 416 with `content-range: bytes */size`. No video (`none`, `failed`, `expired`) gives 404 |
| `GET /api/sessions/:id/thumbs/:frameId` | 200 `image/webp` (`cache-control: private, max-age=31536000, immutable`), or 404 |
| `DELETE /api/sessions/:id` | 204. 409 while the session is live (`recorder.isLive` or `LiveSessions.cellOf`); 404 if unknown. It calls `eventLog.forget(id)` and `index.invalidate(id)` |

**Tests:**
- `long-log.test.ts`: **the Review Focus 4 pins (daemon)**, complete. Verified against Part 1's
  `EventLog` with the tail recovery described below: the reopen pin fails with the old `EventLog`
  (1 008 ms) and passes with the new one (1 ms).

```ts
import { appendFileSync, createWriteStream, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { streamEventLines } from "./ndjson.ts";

setFlagsFromString("--expose_gc");
const gc = runInNewContext("gc") as () => void;
const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";

// A 2-hour session's log as M4 will write it: 150 000 events, about 55 MB.
async function longSession(): Promise<{ home: string; file: string; bytes: number }> {
  const home = mkdtempSync(join(tmpdir(), "local dot's long-log-"));
  const dir = join(home, "sessions", ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id: ID, title: "long", startedAt: "2026-10-02T10:00:00.000Z" }));
  const file = join(dir, "events.jsonl");
  const out = createWriteStream(file);
  let bytes = 0;
  for (let i = 0; i < 150_000; i++) {
    const line = `${JSON.stringify({ v: 1, id: ID, seq: i, t: i * 48_000, agent: "main", step: `s${Math.floor(i / 12)}`, type: "text.progress", data: { count: i % 60, chunk: "x".repeat(200), masked: false } })}\n`;
    bytes += line.length;
    if (!out.write(line)) await new Promise<void>((r) => out.once("drain", () => r()));
  }
  await new Promise<void>((r) => out.end(() => r()));
  return { home, file, bytes };
}

describe("a 2-hour log (Review Focus 4, the daemon)", () => {
  it("reopens a home with a 2-hour log in under 200 ms, and recovers a torn tail without a full read", async () => {
    const { home, file } = await longSession();
    new EventLog(home).close(); // the first open builds the index once
    const started = performance.now();
    const log = new EventLog(home);
    expect(performance.now() - started).toBeLessThan(200);
    expect(log.append(ID, { type: "agent.state", agent: "main", data: { state: "idle" } }).seq).toBe(150_000);
    log.close();
    appendFileSync(file, '{"v":1,"id":"01J9ZQ3V8Y7X6W5T4S3R2Q1P0N","seq":150001,"t":');
    const again = performance.now();
    const reopened = new EventLog(home);
    expect(performance.now() - again).toBeLessThan(200);
    expect(reopened.append(ID, { type: "agent.state", agent: "main", data: { state: "acting" } }).seq).toBe(150_001);
    reopened.close();
  }, 120_000);

  it("streams a 2-hour log in bounded memory", async () => {
    const { file, bytes } = await longSession();
    expect(bytes).toBeGreaterThan(40e6);
    gc();
    const base = process.memoryUsage().heapUsed;
    let peak = 0;
    let n = 0;
    for await (const _line of streamEventLines(file)) {
      if (++n % 10_000 === 0) {
        gc();
        peak = Math.max(peak, process.memoryUsage().heapUsed - base);
      }
    }
    expect(n).toBe(150_000);
    expect(peak).toBeLessThan(16e6);
  }, 120_000);
});
```
- `routes-security.test.ts`: **auth, paths and ranges**, complete:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { monotonicClock } from "../clock.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { Recorder } from "../recorder/recorder.ts";
import { seedSession } from "../recorder/testing/seed-session.ts";
import { SessionIndex } from "./index-store.ts";
import { Thumbnails } from "./thumbs.ts";

const TOKEN = "p7-test-token-0123456789abcdefghijklmnopqrstu";
const PORT = 4790;
const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;
const bearer = { authorization: `Bearer ${TOKEN}` };
let home: string;
let id: string;
let frameId: string;
let app: ReturnType<typeof createApp>;
let index: SessionIndex;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "local dot's replay-routes-"));
  const seeded = await seedSession({ home, minutes: 1 });
  id = seeded.sessionId;
  const eventLog = new EventLog(home);
  const recorder = new Recorder({ home, eventLog, cells: { get: () => undefined, endpoints: () => undefined }, clock: monotonicClock() });
  index = new SessionIndex(home, { isLive: () => false });
  const frames = new FrameStore(home);
  const observe = eventLog.read(id).find((e) => e.type === "observe");
  frameId = observe?.type === "observe" ? observe.data.frameId : "";
  app = createApp({ token: TOKEN, port: PORT, eventLog, replay: { home, eventLog, recorder, index, thumbs: new Thumbnails(home, frames) } });
});
afterAll(() => index.close());

describe("replay routes: auth, ids and byte ranges", () => {
  const routes = () =>
    [
      ["GET", "/api/session-index"],
      ["GET", `/api/sessions/${id}/card`],
      ["GET", `/api/sessions/${id}/events`],
      ["GET", `/api/sessions/${id}/recording`],
      ["GET", `/api/sessions/${id}/recording/video.mp4`],
      ["HEAD", `/api/sessions/${id}/recording/video.mp4`],
      ["GET", `/api/sessions/${id}/thumbs/${frameId}`],
      ["DELETE", `/api/sessions/${id}`],
    ] as const;

  it("refuses every replay route without the install token or with a wrong one", async () => {
    for (const [method, path] of routes()) {
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }]) {
        const res = await app.request(url(path), { method, headers: { accept: "application/x-ndjson", ...headers } });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it("refuses an id or frame id that is not a ULID before touching the filesystem", async () => {
    const bad = ["..%2F..%2Fetc%2Fpasswd", `${id}%2F..`, id.toLowerCase(), `${id}x`, "%2e%2e"];
    for (const b of bad) {
      for (const path of [`/api/sessions/${b}/card`, `/api/sessions/${b}/events`, `/api/sessions/${b}/recording`, `/api/sessions/${b}/recording/video.mp4`, `/api/sessions/${id}/thumbs/${b}`]) {
        const res = await app.request(url(path), { headers: bearer });
        expect(res.status, path).toBe(400);
      }
      expect((await app.request(url(`/api/sessions/${b}`), { method: "DELETE", headers: bearer })).status).toBe(400);
    }
  });

  it("serves byte ranges inside the recording only", async () => {
    const full = await app.request(url(`/api/sessions/${id}/recording/video.mp4`), { headers: bearer });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const bytes = new Uint8Array(await full.arrayBuffer());
    const size = bytes.length;
    expect(Number(full.headers.get("content-length"))).toBe(size);
    const range = async (r: string) => app.request(url(`/api/sessions/${id}/recording/video.mp4`), { headers: { ...bearer, range: r } });
    const head = await range("bytes=0-15");
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-15/${size}`);
    expect(new Uint8Array(await head.arrayBuffer())).toEqual(bytes.subarray(0, 16));
    const tail = await range("bytes=-16");
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(size - 16));
    const open = await range(`bytes=${size - 10}-`);
    expect(open.headers.get("content-range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    for (const r of [`bytes=${size}-`, "bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=-0", "bytes=x-"]) {
      const res = await range(r);
      expect(res.status, r).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
    }
    for (const q of ["upto=abc", "upto=-1", "upto=1.5"]) {
      expect((await app.request(url(`/api/sessions/${id}/recording/video.mp4?${q}`), { headers: bearer })).status, q).toBe(400);
    }
  });

  it("never names the session's title, home or token in an error body", async () => {
    const res = await app.request(url("/api/sessions/01J9ZQ3V8Y7X6W5T4S3R2Q1P0N/card"), { headers: bearer });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(home);
    expect(body).not.toContain(TOKEN);
  });
});
```
- `summary.test.ts`:
  - `"summarises a finished session: verdict, duration, steps, failures, cover, screen and
    recording"`: a seeded session. Verdict `done`, `steps` = the seed's step count, `failedSteps`
    = its failed steps, `coverFrameId` = the last observe, `screen` from `session.start`, and
    `recording.state` `complete`.
  - `"says interrupted for a log without session.end that is not live, and live for a live one"`.
  - `"takes the title from session.start, else session.json"`.
- `index-store.test.ts`:
  - `"pages newest first with a stable cursor"`: 120 seeded summaries. Pages of 50, 50 and 20, no
    duplicates, and `next` is null on the last.
  - `"recomputes a card when the log grew or the manifest changed, and reuses it otherwise"`: a
    spy on `summarizeSession` counts calls.
  - `"rebuilds from the session folders when index.sqlite is deleted"`: the same pages after the
    rebuild (the spec: the index can be rebuilt from the session folders).
  - `"refuses a malformed cursor"`.
- `thumbs.test.ts`:
  - `"makes a 320×200 WebP from an observe frame once and serves it from the cache after"`
    (`sharp(path).metadata()` is 320×200 webp, and the second call doesn't call sharp: check the
    file mtime is unchanged);
  - `"answers undefined for a missing frame"`;
  - `"runs at most two conversions at once"`.
- `retention.test.ts`:
  - `"expires the oldest finished recordings until the total fits"`: three sessions of 1, 2 and
    3 MB, `maxBytes` 4 MB. The oldest goes: its manifest is `expired` with `bytes: 0`, and its
    activity and gaps are kept.
  - `"expires recordings older than maxAgeDays"`.
  - `"never touches a live session"`.
  - `"keeps the event log, frames, thumbnails and summary of an expired session"`.
- `routes.test.ts`:
  - `"streams NDJSON when asked and keeps the JSON array otherwise"`;
  - `"serves a live recording as a stable snapshot at upto"`: a live writer with 3 fragments, then
    a 4th. `?upto=3` keeps returning the same bytes, and `?upto=4` serves more;
  - `"refuses to delete a live session and deletes a finished one"`;
  - `"answers a recording manifest of none for a session without a recording"`.
- `seed-session.test.ts`:
  - `"writes a session that replays: events, frames, a complete recording and seed.json"`;
  - `"writes no frame inside the takeover span and logs the control changes"`;
  - `"puts the marker in the title and in one typed chunk"`.

**Implementation notes:**
- **`EventLog` tail recovery** (verified against Part 1's tests: all 21 pass):
  - `#stateOf` stops calling `readValid`. It calls `readTail(file)`, which:
    1. reads the last 64 KiB with `readSync` (growing the window ×4 until a newline is found or the
       window reaches the file start);
    2. takes `validBytes` = through the last newline;
    3. parses lines backwards until one parses, which gives `lastSeq` and `lastT`.
  - It truncates to `validBytes` as before.
  - The index is rebuilt only when it isn't current. Inside `#updateIndex`, query
    `SELECT (SELECT COUNT(*) FROM sessions WHERE id = ?) AS has, (SELECT MAX(seq) FROM events WHERE session_id = ?) AS last`.
    Rebuild through `readValid` only when `has !== 1` or `last !== lastSeq`.
  - Two traps:
    - an empty session (`lastSeq = -1`) still needs its `sessions` row, which the `has` check
      gives;
    - the check must run inside `#updateIndex`, so a locked index is logged and marked stale
      exactly as before (Part 1's "index is locked" test).
- **NDJSON:** `createReadStream(file, { start: 0, end: size − 1, highWaterMark: 64 * 1024 })`
  piped through `readline` (`crlfDelay: Infinity`). The last line counts only when byte `size − 1`
  is `\n`. The route wraps the generator in a `ReadableStream` whose `pull` takes the next line.
  That is real backpressure: Hono writes as fast as the socket drains, never faster.
- **Summaries:** `summarizeSession` streams the log with `streamEventLines`, folding only the
  counters (never `foldEvents`):
  - the title from `session.start.data.title`, else `session.json`;
  - `steps` counts `step.start`; `failedSteps` counts `step.end` with a status other than `ok`;
  - `coverFrameId` is the last `observe`;
  - `durationMs` is `session.end.t − session.start.t` in ms, or the last `t` when there is no end.

  `Recorder.stop` (afterRun) writes `summary.json`, then calls `index.invalidate`. `SessionIndex`:
  - stores `session_cards(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, card TEXT NOT NULL, log_bytes INTEGER NOT NULL, manifest_mtime_ms INTEGER NOT NULL)`
    with an index on `(started_at DESC, id DESC)`;
  - treats a row as fresh when `log_bytes` equals the size of `events.jsonl` and
    `manifest_mtime_ms` equals the manifest's `mtimeMs` (0 when absent);
  - computes a stale or missing row through `summary.json` when its `logBytes` matches, else
    through `summarizeSession`;
  - runs paging as `WHERE (started_at, id) < (?, ?) ORDER BY started_at DESC, id DESC LIMIT ?`
    over the folders listed by `EventLog.listSessions()`;
  - never returns a live session's cached card: those are recomputed with `live: true`.
- **Thumbnails:**
  `sharp(frame).resize(THUMB_W, THUMB_H, { fit: "fill" }).webp({ quality: 70 }).toFile(temp)`,
  then rename to `<session>/thumbs/<frameId>.webp` (mode 0600). A promise per key de-duplicates
  concurrent requests, and a two-slot semaphore bounds sharp. Observe frames are 1280×800 (16:10),
  so `fill` keeps the aspect ratio.
- **Retention:**
  - runs in `main.ts` after `recoverAll()`, and after each `Recorder.stop`;
  - the total is the sum of `video.mp4` sizes of non-live sessions, oldest first by `startedAt`;
  - "expire" means removing `video.mp4`, `fragments.jsonl` and `journal/`, then writing the
    manifest with `state: "expired"`, `bytes: 0`, and `fragments`, `activity`, `gaps`, codec and
    size kept;
  - the session stays in the index and replays over its `observe` frames (Task 13's backdrop).
- **Range parsing:** one regex,
  `^bytes=(\d*)-(\d*)$`:
  - both parts empty is invalid;
  - `-n` (suffix) with `n ≥ 1` serves the last `min(n, size)` bytes;
  - `a-` serves from `a` to the end;
  - `a-b` serves from `a` to `min(b, size − 1)`, and needs `a ≤ b`;
  - `a ≥ size` is invalid.

  An invalid range gives 416 with `bytes */size`, never 200. The body is a `ReadableStream` over
  `view.read` in 256 KiB chunks. Close the view when the stream ends or the request aborts
  (`c.req.raw.signal`).
- **The seeder** builds sessions like M2's puppet:
  - the events: `session.start` at 2560×1600 scale 2; per step `step.start`, `action.intent` with
    a `minjerk-bow-v1` plan, `action.target`, `action.dispatch`, `text.progress` for typing
    (every fifth typing step `masked`, with no chunks), `screen.settle`, `observe`,
    `action.result` and `step.end`; every tenth step cancelled; an optional `control.change`
    pair; and `session.end` with `done`;
  - observe frames: 1280×800 WebP made with sharp from a flat colour per step;
  - the recording: a `RecordingWriter` with synthetic frames at 320×192 (the stage scales the
    video into the 2560×1600 session screen and warns once; P3's `videoPlacement`), a burst of
    24 frames at 60 fps starting at each dispatch, `flushIdle` between bursts, and `finish` at the
    end. Inside a takeover no frame is written, and the first frame after it is a key frame.

  The time between steps is chosen so that `minutes` of session holds about `minutes × 12` steps.
  `seed-main.ts` parses `--home <dir> --minutes <n> [--title <t>] [--marker <m>] [--takeover <fromMs>-<toMs>] [--no-video]`,
  prints the `SeedResult` as JSON, and exits 2 on bad arguments.

- [ ] **Step 1:** Write `long-log.test.ts` and run it against Part 1's `EventLog`:
  `pnpm exec vitest run apps/daemon/src/sessions/long-log.test.ts`.
  Expected: FAIL. The reopen takes about 1 s, and `ndjson.ts` is missing.
- [ ] **Step 2:** Implement the `EventLog` tail recovery, `logFile`, `forget` and `ndjson.ts`. Run
  `pnpm exec vitest run apps/daemon/src/sessions/long-log.test.ts apps/daemon/src/event-log.test.ts`.
  Expected: PASS.
- [ ] **Step 3:** Write the remaining tests. Implement `seed-session.ts`, `seed-main.ts`,
  `summary.ts`, `index-store.ts`, `thumbs.ts`, `retention.ts`, `routes.ts`, the `app.ts` option and
  the `main.ts` wiring. Run `pnpm exec vitest run apps/daemon/src`.
  Expected: PASS.
- [ ] **Step 4:** Smoke test:
  ```bash
  cd "/Volumes/Husky's SSD 4T/Projects/localdot/apps/daemon"
  H=$(mktemp -d)/home
  node --import tsx src/seed-main.ts --home "$H" --minutes 10
  LOCALDOT_HOME="$H" node --import tsx src/main.ts &
  T=$(cat "$H/daemon-token")
  curl -s -H "Authorization: Bearer $T" http://127.0.0.1:4750/api/session-index
  curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H "Authorization: Bearer $T" -H 'Range: bytes=0-99' \
    "http://127.0.0.1:4750/api/sessions/<id>/recording/video.mp4"
  kill %1
  ```
  Expected: a page with one card, and `206 100`.
- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(daemon): session index, NDJSON events, thumbnails, retention and replay routes"
```

**Acceptance:** `pnpm exec vitest run apps/daemon/src` passes, including the long-log and route
pins.

---
