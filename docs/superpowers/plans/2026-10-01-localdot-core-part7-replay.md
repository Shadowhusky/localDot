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
  queueLimitBytes?: number;   // default MAX_QUEUED_BYTES
  sizeCapBytes?: number;      // default SESSION_CAP_BYTES (tests lower it)
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
    // "%2e%2e" and "%2e." never get here: the URL parser resolves them as dot segments (asserted below).
    const bad = ["..%2F..%2Fetc%2Fpasswd", `${id}%2F..`, id.toLowerCase(), `${id}x`, "%00"];
    for (const b of bad) {
      for (const path of [`/api/sessions/${b}/card`, `/api/sessions/${b}/events`, `/api/sessions/${b}/recording`, `/api/sessions/${b}/recording/video.mp4`, `/api/sessions/${id}/thumbs/${b}`]) {
        const res = await app.request(url(path), { headers: bearer });
        expect(res.status, path).toBe(400);
      }
      expect((await app.request(url(`/api/sessions/${b}`), { method: "DELETE", headers: bearer })).status).toBe(400);
    }
    const dotted = await app.request(url(`/api/sessions/${id}/thumbs/%2e%2e/%2e%2e/%2e%2e/events.jsonl`), { headers: bearer });
    expect(dotted.status).toBe(404);
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

### Task 13: Web — replay in the render worker

The render worker gains a replay mode. Its video comes from the recording through mediabunny and
WebCodecs instead of the tapped live track. Its time comes from the closed-form replay clock
instead of `sessionMsAt(wallNow())`. It presents the last frame at or before the replay time and
draws `sceneAt(model, t, view)` over it, unchanged. So the overlays are the live overlays by
construction, and the video is never ahead of them.

Where a stretch has no video, the worker presents the `observe` screenshot in effect instead:
- no recording at all (`none`, `failed`);
- a recording removed by retention (`expired`);
- before the first frame;
- after a recording stopped early.

That is "the typed fallback" for video: every session replays, at least step by step.

**Review tier:** light.

**Files:**
- Create: `apps/web/src/replay/recording-source.ts`, `apps/web/src/replay/replay-video.ts`,
  `apps/web/src/replay/decode-policy.ts`, `apps/web/src/replay/decode-policy.test.ts`,
  `apps/web/src/replay/backdrop.ts`, `apps/web/src/replay/probe.ts`, `apps/web/e2e/seed.ts`,
  `apps/web/e2e/replay-pins.spec.ts`
- Modify: `apps/web/src/stage/worker-protocol.ts`, `apps/web/src/stage/render-worker.ts`,
  `apps/web/src/stage/StageCanvas.tsx`, `apps/web/src/stage/Stage.tsx`, `apps/web/e2e/daemon.ts`
  (`startDaemon(env, { home })`), `apps/web/package.json` (`@localdot/stage` already; mediabunny
  from Task 3)

**Interfaces** (exact):

```ts
// apps/web/src/stage/worker-protocol.ts — added
import type { RecordingGap } from "@localdot/protocol";
import type { PlaybackMap, ReplaySpeed } from "@localdot/stage";

export interface ReplaySource {
  sessionId: string;
  origin: string;                         // the daemon's http origin
  authorization: string;                  // "Bearer <token>": the worker fetches the recording and frames itself
  video: { upto: number | null } | null;  // null: no video (none, failed, expired)
  gaps: RecordingGap[];                   // session µs
}
export interface ReplayTransport {
  playing: boolean;
  speed: ReplaySpeed;
  map: PlaybackMap;          // built on the page from busySpans (skip idle on or off)
  atPlayMs: number;          // the playback position to anchor at, on the worker's own clock
}
export type ReplayStatus =
  | { state: "loading" }
  | { state: "ready"; firstMs: number | null; lastMs: number | null }
  | { state: "no-video" }
  | { state: "error"; message: string };
export type ReplayProbeCommand =
  | { id: number; op: "enable" }
  | { id: number; op: "mb-luma"; widthMbs: number; heightMbs: number }   // per-macroblock mean luma of the presented video frame, or null
  | { id: number; op: "overlay-hash"; tMs: number }                      // sha-256 hex of the overlays-only render at tMs
  | { id: number; op: "stats" };                                        // ReplayVideoStats & { source: "video" | "backdrop" | "none" }

// WorkerIn gains:
//   | { type: "replay-open"; source: ReplaySource }       stops the live pump, enters replay mode
//   | { type: "replay-transport"; transport: ReplayTransport }
//   | { type: "replay-seek"; tMs: number; mode: "exact" | "preview" }   pauses at session ms tMs
//   | { type: "replay-close" }                            back to live mode (the page re-attaches the live source)
//   | { type: "replay-probe"; command: ReplayProbeCommand }   only honoured after the page sent "enable" under ?replayProbe=1
// WorkerOut gains:
//   | { type: "replay-time"; tMs: number; playing: boolean; idle: boolean }   ≤ 10 Hz while playing; once after each seek lands
//   | { type: "replay-status"; status: ReplayStatus }
//   | { type: "replay-ended" }                            playback reached the map's end
//   | { type: "replay-probe-reply"; id: number; reply: unknown }

// apps/web/src/replay/decode-policy.ts
export const JUMP_AHEAD_MS = 1500;
export type DecodeMode = "play" | "exact" | "preview";
export type DecodeStep = "hold" | "advance" | "seek-exact" | "seek-key";
export interface DecodeState {
  targetMs: number;
  mode: DecodeMode;
  shownMs: number | null;      // timestamp of the frame on screen
  shownKeyMs: number | null;   // the key frame it was decoded from
  targetKeyMs: number | null;  // the last key frame at or before targetMs
  nextMs: number | null;       // the running iterator's next sample, if one runs
}
export function nextDecodeStep(s: DecodeState): DecodeStep;
export type FrameSource = "video" | "backdrop" | "hold";
export function sourceAt(tMs: number, v: { hasVideo: boolean; firstMs: number | null; lastMs: number | null; gaps: RecordingGap[] }): FrameSource;

// apps/web/src/replay/recording-source.ts
export const RECORDING_CACHE_BYTES = 32 * 1024 * 1024;
export function recordingUrl(src: ReplaySource): string;   // <origin>/api/sessions/<id>/recording/video.mp4[?upto=n]
export function openRecording(src: ReplaySource): Input;    // mediabunny Input over UrlSource with the bearer header

// apps/web/src/replay/replay-video.ts
export interface ReplayVideoStats { openFrames: number; decodeQueue: number; seeks: number; decoded: number }
export class ReplayVideo {
  static open(src: ReplaySource): Promise<ReplayVideo>;   // rejects when the track can't be decoded here
  readonly firstMs: number;
  readonly lastMs: number;
  // The frame on screen at tMs, as a VideoFrame the caller owns (it is presented, then closed), or
  // null when a later call superseded this one, or before the first frame. The latest call wins.
  want(tMs: number, mode: DecodeMode): Promise<VideoFrame | null>;
  stats(): ReplayVideoStats;
  close(): void;
}

// apps/web/src/replay/backdrop.ts
export const BACKDROP_CACHE = 6;
export class ObserveBackdrop {
  constructor(src: ReplaySource);
  // The observe frame in effect at tMs (observeAt), fetched with the header, as a VideoFrame the
  // caller owns; null before the first observe.
  frameAt(model: SessionModel, tMs: number): Promise<VideoFrame | null>;
  close(): void;
}

// apps/web/src/stage/StageCanvas.tsx / Stage.tsx — the handle gains
export interface ReplayHandle {
  open(source: ReplaySource): void;
  transport(t: ReplayTransport): void;
  seek(tMs: number, mode: "exact" | "preview"): void;
  close(): void;
  onReplay(listener: (m: Extract<WorkerOut, { type: "replay-time" | "replay-status" | "replay-ended" }>) => void): () => void;
  probe(command: Omit<ReplayProbeCommand, "id">): Promise<unknown>;
}
// StageHandle gains `replay: ReplayHandle`; Stage gains the prop `mode: "live" | "replay"` (default
// "live"). In "replay" it mounts no Selkies iframe, so the cell has one viewer fewer and the
// gateway may run Fast, and it detaches the live source.

// Exposed only under ?replayProbe=1, for the e2e specs:
declare global {
  interface Window {
    __localdot?: {
      replay?: {
        status(): ReplayStatus["state"];
        seek(tMs: number, mode: "exact" | "preview"): Promise<void>;   // resolves on the replay-time that follows
        transport(patch: { playing?: boolean; speed?: ReplaySpeed; skipIdle?: boolean }): void;
        probe(command: Omit<ReplayProbeCommand, "id">): Promise<unknown>;
      };
    };
  }
}
```

**`nextDecodeStep`**, exactly (in order, first match wins):

| mode | condition | step |
|---|---|---|
| preview | `shownKeyMs !== null && shownKeyMs === targetKeyMs` | hold |
| preview | otherwise | seek-key |
| exact | `shownMs !== null && shownKeyMs === targetKeyMs && shownMs <= targetMs && (nextMs === null \|\| nextMs > targetMs)` | hold |
| exact | `nextMs !== null && shownKeyMs === targetKeyMs && nextMs <= targetMs` | advance |
| exact | otherwise | seek-exact |
| play | `nextMs === null \|\| (shownMs !== null && targetMs < shownMs)` | seek-exact |
| play | `targetMs − nextMs > JUMP_AHEAD_MS` | seek-key |
| play | `nextMs <= targetMs` | advance |
| play | otherwise | hold |

**`sourceAt`**:
- no video, or `firstMs === null` → `backdrop`;
- `tMs < firstMs` → `backdrop`;
- `tMs` inside a gap (`from ≤ tMs×1000 < (to ?? ∞)`) whose reason is `user-control` → `hold` (the
  last frame stays, and the page's card covers it);
- inside any other gap, or `tMs > lastMs` while a gap with `to: null` exists → `backdrop`;
- else `video`.

**Tests:**
- `decode-policy.test.ts`: one test per table row (`"preview holds within the same GOP"`, …,
  `"play jumps to the key frame when 1.5 s behind"`). Plus:
  - `"exact seek backwards always re-seeks"`;
  - `"sourceAt: backdrop before the first frame, hold in a takeover gap, backdrop after a disk-full
    stop, video otherwise"`.
- `replay-pins.spec.ts`: **the browser pins**, complete code below. It runs in system Chrome
  without Docker, against seeded sessions.
- `render-worker` (no unit test: it needs WebCodecs and OffscreenCanvas). The e2e pins exercise it.
  Part 2's and Part 3's `Stage.test.tsx` and `App.test.tsx` stay green: `mode` defaults to `"live"`.

**Implementation notes:**
- **Opening.**
  - `new Input({ formats: [MP4], source: new UrlSource(recordingUrl(src), { requestInit: { headers: { authorization: src.authorization } }, maxCacheSize: RECORDING_CACHE_BYTES, parallelism: 2, getRetryDelay: (n, err) => (n < 3 && !is4xx(err) ? 0.5 * 2 ** n : null) }) })`.
  - Then `getPrimaryVideoTrack()`; if `await track.canDecode()` is false, reject with
    `This browser cannot decode the recording (<codec>).`
  - `firstMs` is `getFirstPacket` ÷ 1000. `lastMs` is `getPacket(Infinity)`'s end, in ms.
  - The `upto` snapshot is fixed for the Input's life. To see more of a live session, the page
    reopens (Task 14's follow rule).
- **Decoding.** One `VideoSampleSink` for `seek-exact` (`getSample(t / 1000)`: mediabunny decodes
  from the preceding key frame) and for the running iterator (`samples(t / 1000)`). One
  `EncodedPacketSink` for `targetKeyMs` (`getKeyPacket`). `seek-key` decodes just the key packet
  (`getSample(key.timestamp)`).
  - Every `VideoSample` becomes `toVideoFrame()` and is closed at once.
  - `stats.openFrames` counts frames made minus frames closed (wrap `close`).
  - The iterator holds at most one look-ahead sample (`nextMs`).
  - Never keep a second decoded frame. A superseded frame (a newer `want` arrived) is closed
    before the next step.
- **Latest wins.** A generation number increments on every `want`. Each async step checks it, and
  a stale result is closed, never presented. That keeps a fast drag (100 `preview` calls in a
  burst) at ≤ 3 open frames: the pin checks.
- **The worker's tick in replay mode:**
  - `t` = `sessionAt(map, playMsAt(clock, wallNow()))` while playing, else the seek target;
  - `sourceAt(t)` picks the source:
    - `video`: `want(t, playing ? "play" : lastSeekMode)`, presenting the frame when it resolves
      non-null;
    - `backdrop`: `backdrop.frameAt(model, t)`;
    - `hold`: nothing;
  - `presenter.setScreen(model.screen)`, the camera at zoom 1 (the auto-camera is M8's), and
    `presenter.draw(sceneAt(model, t, view))`;
  - `replay-time` is posted at most every 100 ms, and once when a seek lands (`idle` =
    `idleAt(map, t)`);
  - while playing, at `playMs ≥ playDuration(map)`, the tick pauses and posts `replay-ended`.
- **Determinism:** the scene depends only on `(model, t, view)`. `view.reducedMotion` comes from
  the page, as live. The overlays never read the decoded frame.
- **Presenting a backdrop frame:** `new VideoFrame(await createImageBitmap(blob), { timestamp: tMs * 1000 })`.
  The 1280×800 observe frame is scaled into the session's screen by `videoPlacement`, like a 1×
  cell. Part 3's mismatch warning fires once; the worker suppresses it for backdrop frames.
- **The probe (`probe.ts`):**
  - Off by default. After `enable` it keeps one `clone()` of the last presented *video* frame, and
    closes the previous one (P3-C12's rule: nothing extra is held in production).
  - `mb-luma` runs `frame.copyTo(buffer)`, reads plane 0 (Y for I420, I444 and NV12) with the
    layout `copyTo` returns, and averages each 16×16 macroblock. It answers null when the presented
    source is the backdrop.
  - `overlay-hash` hashes
    `presenter.extract({ x: 0, y: 0, w: viewport.w, h: viewport.h }, "overlays", cam, sceneAt(model, tMs, view))`
    with `crypto.subtle.digest("SHA-256", …)`.
- **The page side.** `StageCanvas` routes `replay-*` messages to `onReplay` listeners.
  `Stage.mode === "replay"` unmounts `DesktopFrame` (no ticket minted) and detaches the live
  source. Switching back remounts it, through Part 2's re-ticket path.

**The browser pins, complete:**

`apps/web/e2e/seed.ts`:
```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeedResult } from "../../daemon/src/recorder/testing/seed-session.ts";

const DAEMON = fileURLToPath(new URL("../../daemon", import.meta.url));

export interface SeededHome {
  home: string;
  seed: SeedResult;
}

// A synthetic session with a synthetic recording, written by the daemon's seeder (Task 12): no
// Docker, no cell. execFileSync throws on a non-zero exit, so a failed seed fails the spec.
export function seedHome(opts: { home?: string; minutes: number; title?: string; marker?: string; takeover?: string; video?: boolean }): SeededHome {
  const home = opts.home ?? join(mkdtempSync(join(tmpdir(), "local dot's replay-e2e-")), "home");
  const args = ["--import", "tsx", "src/seed-main.ts", "--home", home, "--minutes", String(opts.minutes)];
  if (opts.title) args.push("--title", opts.title);
  if (opts.marker) args.push("--marker", opts.marker);
  if (opts.takeover) args.push("--takeover", opts.takeover);
  if (opts.video === false) args.push("--no-video");
  const out = execFileSync(process.execPath, args, { cwd: DAEMON, encoding: "utf8" });
  return { home, seed: JSON.parse(out) as SeedResult };
}
```

`apps/web/e2e/replay-pins.spec.ts`:
```ts
import { expect, type Page, test } from "@playwright/test";
import { frameOfLuma } from "@localdot/stage/testing";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { type SeededHome, seedHome } from "./seed.ts";

type Hook = NonNullable<NonNullable<Window["__localdot"]>["replay"]>;
let daemon: RunningDaemon;
let short: SeededHome;
let long: SeededHome;

test.use({ launchOptions: { args: ["--js-flags=--expose-gc"] } });

test.beforeAll(async () => {
  short = seedHome({ minutes: 2 });
  long = seedHome({ home: short.home, minutes: 120, title: "Two hours" });
  daemon = await startDaemon({}, { home: short.home });
});

test.afterAll(async () => {
  await daemon?.stop();
});

async function openReplay(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${daemon.origin}/?replay=${sessionId}&replayProbe=1#token=${daemon.token}`);
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready", undefined, { timeout: 60_000 });
}

const seek = (page: Page, tMs: number, mode: "exact" | "preview" = "exact") =>
  page.evaluate(([t, m]) => (window.__localdot?.replay as Hook).seek(t as number, m as "exact" | "preview"), [tMs, mode] as const);
const probe = (page: Page, command: Parameters<Hook["probe"]>[0]) => page.evaluate((c) => (window.__localdot?.replay as Hook).probe(c), command);

test("shows the frame on screen at any scrubbed time (Review Focus 1)", async ({ page }) => {
  await openReplay(page, short.seed.sessionId);
  const { frames, synth } = short.seed;
  const step = Math.max(1, Math.floor(frames.length / 60));
  for (let i = 1; i < frames.length; i += step) {
    const a = (frames[i] as { tMicros: number }).tMicros;
    const prev = (frames[i - 1] as { tMicros: number }).tMicros;
    for (const tMs of [a / 1000, (a + 1) / 1000, (prev + a) / 2000, (a - 1) / 1000]) {
      await seek(page, tMs);
      const luma = (await probe(page, { op: "mb-luma", widthMbs: synth.widthMbs, heightMbs: synth.heightMbs })) as number[];
      const expected = frames.filter((f) => f.tMicros <= tMs * 1000).at(-1) as { index: number };
      expect(frameOfLuma(synth, luma), `t = ${tMs} ms`).toBe(expected.index);
    }
  }
});

test("draws the same overlays at the same time in two separate loads (Review Focus 5)", async ({ page }) => {
  const times = short.seed.steps.slice(0, 12).flatMap((s) => [s.startMs + 130, s.dispatchMs - 40, s.dispatchMs + 23, s.dispatchMs + 150, s.endMs + 600]);
  const hashes = async () => {
    await openReplay(page, short.seed.sessionId);
    const out: string[] = [];
    for (const tMs of times) {
      await seek(page, tMs);
      out.push((await probe(page, { op: "overlay-hash", tMs })) as string);
    }
    return out;
  };
  const first = await hashes();
  await page.goto("about:blank");
  const second = await hashes();
  expect(new Set(first).size).toBeGreaterThan(times.length / 2);
  expect(second).toEqual(first);
});

test("scrubs a 2-hour session in bounded memory (Review Focus 4, the browser)", async ({ page }) => {
  await openReplay(page, long.seed.sessionId);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const mainHeap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  };
  const worker = page.workers().find((w) => w.url().includes("render-worker"));
  const workerHeap = async () =>
    (await worker?.evaluate(() => {
      (globalThis as { gc?: () => void }).gc?.();
      return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    })) ?? null;
  const stats = async () => (await probe(page, { op: "stats" })) as { openFrames: number; decodeQueue: number };
  const baseMain = await mainHeap();
  const baseWorker = await workerHeap();
  const end = long.seed.steps.at(-1)?.endMs ?? 7_200_000;
  let seed = 5;
  const random = () => {
    seed = (seed * 48_271) % 2_147_483_647;
    return (seed / 2_147_483_647) * end;
  };
  const latencies: number[] = [];
  for (let i = 0; i < 300; i++) {
    const started = Date.now();
    await seek(page, random());
    latencies.push(Date.now() - started);
    if (i % 25 === 0) {
      const s = await stats();
      expect(s.openFrames).toBeLessThanOrEqual(3);
      expect(s.decodeQueue).toBeLessThanOrEqual(4);
    }
  }
  // A drag: 100 previews in one burst, the latest wins.
  await page.evaluate(async (e) => {
    const hook = window.__localdot?.replay as Hook;
    const all: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) all.push(hook.seek((i / 100) * e, "preview"));
    await all.at(-1);
  }, end);
  expect((await stats()).openFrames).toBeLessThanOrEqual(3);
  await page.evaluate(() => (window.__localdot?.replay as Hook).transport({ playing: true, speed: 8, skipIdle: true }));
  for (let s = 0; s < 20; s++) {
    await page.waitForTimeout(1000);
    expect((await stats()).openFrames).toBeLessThanOrEqual(3);
  }
  latencies.sort((a, b) => a - b);
  expect(latencies[Math.floor(latencies.length * 0.95)]).toBeLessThan(1000);
  expect((await mainHeap()) - baseMain).toBeLessThan(32 * 1024 * 1024);
  const afterWorker = await workerHeap();
  if (baseWorker !== null && afterWorker !== null) expect(afterWorker - baseWorker).toBeLessThan(96 * 1024 * 1024);
  else test.info().annotations.push({ type: "note", description: "the worker exposes no performance.memory: worker heap not measured" });
});
```

`apps/web/e2e/daemon.ts` (Part 2's): `startDaemon(env = {}, opts: { home?: string } = {})` uses
`opts.home` instead of a new temp home when given, so a seeded home is served. Nothing else
changes.

- [ ] **Step 1:** Write `decode-policy.test.ts`. Run
  `pnpm exec vitest run apps/web/src/replay`.
  Expected: FAIL.
- [ ] **Step 2:** Implement `decode-policy.ts`. Run the same command.
  Expected: PASS.
- [ ] **Step 3:** Write `seed.ts` and `replay-pins.spec.ts`, and give `startDaemon` its `home`
  option. Implement `recording-source.ts`, `replay-video.ts`, `backdrop.ts`, `probe.ts`, the worker's
  replay mode, the protocol additions and the `StageCanvas`/`Stage` handle. Run
  `pnpm --filter @localdot/web build && pnpm --filter @localdot/web e2e --grep "Review Focus"`.
  Expected: three tests pass. The 2-hour pin takes about 2 minutes, including the seeding.
- [ ] **Step 4:** Run `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck`.
  Expected: PASS. Part 2's and Part 3's web suites are unchanged.
- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web
git commit -m "feat(web): replay mode in the stage worker, decoding the recording with mediabunny"
```

**Acceptance:** the three browser pins pass in system Chrome with no Docker running.

---

### Task 14: Web — the Replay mode in the Theatre

The Theatre's Replay mode, which Part 2's top bar has shown disabled until now. Its parts:
- a sessions rail;
- the stage in replay;
- the HUD and caption as of t;
- a scrubber with step chapters, typed ticks, idle bands, takeover and failure gaps, and hover
  thumbnails;
- play and pause, speeds from 0.5× to 8×, skip idle (on by default and labelled), step keys,
  before/after compare;
- plan and steps as of t, with future items dimmed;
- "Jump to live" with the follow rule (research §4.9).

**Review tier:** light (UI).

**Files:**
- Create: `apps/web/src/replay/{useReplay.ts,replay-view.ts,replay-view.test.ts,ReplayView.tsx,Scrubber.tsx,ReplayControls.tsx,CompareView.tsx,SessionsRail.tsx,GapCard.tsx}`,
  `apps/web/e2e/replay-ui.spec.ts`
- Modify: `apps/web/src/shell/TopBar.tsx` (live mode switch), `apps/web/src/shell/PlanRail.tsx`
  and `apps/web/src/shell/StepRow.tsx` (`asOfMs`, `onSelect`, `thumb` source),
  `apps/web/src/App.tsx` (mode state, URL), `apps/web/src/app.css`, `apps/web/src/theme.css`
  (tokens below), `apps/web/src/App.test.tsx`

**Interfaces** (exact):

```ts
// apps/web/src/replay/replay-view.ts — pure view models (unit-tested)
export interface ChapterView { id: string; label: string; status: ChapterStatus; x0: number; x1: number; startT: number; endT: number }  // x in [0, 1] of the track
export interface TickBucket { x: number; t: number; kinds: TickKind[]; tone: MarkTone; count: number; label: string }
export interface IdleBand { x0: number; x1: number; skippedMs: number }
export interface GapBand { x0: number; x1: number; reason: RecordingGapReason }
export interface ScrubberModel { durationPlayMs: number; chapters: ChapterView[]; ticks: TickBucket[]; idle: IdleBand[]; gaps: GapBand[] }
export const TICK_BUCKET_PX = 4;
export function scrubberModel(i: { chapters: Chapter[]; ticks: Tick[]; map: PlaybackMap; gaps: RecordingGap[]; widthPx: number }): ScrubberModel;
export function timeLabel(ms: number): string;                                  // "0:07", "12:03", "1:02:03"
export function speedLabel(speed: ReplaySpeed, idleNow: boolean): string | null;
export function gapCard(kind: RecordingGapReason | "none" | "expired" | "failed"): { title: string; body: string };
export type ReplayCommand =
  | { kind: "toggle-play" } | { kind: "pause" } | { kind: "step"; dir: -1 | 1 } | { kind: "jump"; ms: number }
  | { kind: "speed"; dir: -1 | 1 } | { kind: "compare" } | { kind: "exit" };
export function replayKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; targetIsField: boolean }): ReplayCommand | null;
export function compareFrames(model: SessionModel, stepId: string): { before: string | null; after: string | null };
export type FollowAction = "stay" | "refresh" | "go-live";
export const FOLLOW_EDGE_MS = 250;
export const LIVE_EDGE_MS = 2000;
export function followRule(o: { live: boolean; playing: boolean; tMs: number; lastMs: number | null; liveNowMs: number }): FollowAction;
export function suggestedExportName(now: Date): string;                        // Task 15 uses it: "localdot-2026-10-02-1012.mp4"

// apps/web/src/replay/useReplay.ts
export interface ReplayState {
  status: ReplayStatus["state"];
  card: SessionCard | null;
  info: RecordingInfo | null;
  model: SessionModel;            // folded in place; `version` bumps ≤ 10 Hz
  version: number;
  tMs: number;
  playing: boolean;
  speed: ReplaySpeed;
  skipIdle: boolean;
  idleNow: boolean;
  map: PlaybackMap | null;
  compare: { before: string | null; after: string | null } | null;
  run(command: ReplayCommand): void;
  seek(tMs: number, mode: "exact" | "preview"): void;
  setSpeed(speed: ReplaySpeed): void;
  setSkipIdle(on: boolean): void;
  selectStep(stepId: string): void;   // seek to its chapter start, exact
}
export function useReplay(api: ApiClient, sessionId: string | null, stage: RefObject<StageHandle | null>, opts: { onGoLive(): void }): ReplayState;
```

**Exact strings** (`gapCard`, `speedLabel`):

| kind | title | body |
|---|---|---|
| `user-control` | You had control here | Nothing was recorded while you were in control. |
| `stream-lost` | The picture dropped here | localDot lost the computer's stream. Steps are shown from screenshots. |
| `disk-full` | Recording stopped: the disk was full | Steps are shown from screenshots. Free some space and new sessions record again. |
| `size-cap` | Recording stopped at the size limit | Steps are shown from screenshots. |
| `recorder-error` | Recording stopped | Steps are shown from screenshots. |
| `expired` | The video was removed to save space | Steps are shown from screenshots. |
| `none`, `failed` | No video for this session | Steps are shown from screenshots. |

`speedLabel(speed, idleNow)` gives:
- `null` at 1× when not idle;
- `"Idle skipped"` at 1× when idle;
- `"Playing at 4×"`, or `"Playing at 4× · idle skipped"` when idle;
- 0.5× reads `"Playing at ½×"`.

**Keys** (`replayKey`; `null` with ⌘, Ctrl or Alt held, or while a text field has focus):

| Key | Command |
|---|---|
| Space | `toggle-play` |
| K | `pause` |
| ← / → | `step` −1 / +1 (previous or next chapter start) |
| J / L | `jump` −10 000 / +10 000 ms |
| `[` / `]` | `speed` −1 / +1 along `REPLAY_SPEEDS` |
| B | `compare` |
| Escape | `exit` (closes compare first; otherwise back to Watch) |

**`followRule`:**
- `live && playing && lastMs !== null && tMs ≥ lastMs − FOLLOW_EDGE_MS`:
  - `liveNowMs − lastMs ≤ LIVE_EDGE_MS` → `"go-live"` (switch to Watch);
  - otherwise → `"refresh"` (reopen the recording at the new `upto`; playback continues).
- Otherwise `"stay"`. Stepping back always stays: research §4.9's follow rule, "stepping back
  pins; reaching the end resumes live".

**Theme tokens** (add to `theme.css`; no new hue: neutral whites at stated alphas):

```css
  --color-scrub-track: rgba(255, 255, 255, 0.1);
  --color-scrub-played: rgba(255, 255, 255, 0.55);
  --color-scrub-idle: rgba(255, 255, 255, 0.04);
  --color-scrub-gap: rgba(255, 255, 255, 0.02);
  --color-tick: rgba(255, 255, 255, 0.7);
  --color-tick-quiet: rgba(255, 255, 255, 0.35);
  --duration-scrub-settle: 120ms;
```

Tick tones are drawn with shapes, never colours:
- neutral: a 3 px dot;
- attention: a filled diamond;
- failure: a 1.5 px cross;
- user: a hollow ring.

Kinds group under one tone, and the hover card names the kind in words.

**Tests:**
- `replay-view.test.ts`:
  - `"places chapters on the playback track, idle skipped"`: two chapters around a 60 s idle gap.
    With skip idle, `x1` of the first and `x0` of the second are 400 ms of track apart. Without
    it, they are proportional.
  - `"buckets 14 000 ticks into at most widthPx / 4 buckets, keeping the strongest tone"`:
    failure > attention > user > neutral. The label reads `Click A and 12 more`.
  - `"draws idle bands with the time they skip and gap bands by reason"`.
  - `"formats time"`: 7 000 → `0:07`, 723 000 → `12:03`, 3 723 000 → `1:02:03`.
  - `"labels honest speed"` and `"names every gap card"`: every row of the two tables above.
  - `"maps keys and ignores them in fields and with modifiers"`.
  - `"compares a step's screen before and after"`: `before` = the last observe before the step's
    start (the session's first observe when none), `after` = the step's own observe;
    `{ before: null, after: null }` without observes.
  - `"follows to live only at the live edge, refreshes near it, stays when stepping back"`.
  - `"suggests an export name with the date, never the title"`.
- `App.test.tsx` (jsdom, scripted `fetchImpl` answering `/api/session-index`, `/card`,
  `/recording` and the NDJSON events):
  - `"enables Replay when a session exists and opens it from the top bar"`. The URL becomes
    `?replay=<id>`, the sessions rail lists the card, the scrubber has one chapter per step, and
    the stage area shows Part 2's Chromium-needed notice. jsdom has no frame tap, and the controls
    still render.
  - `"Space toggles play and Escape goes back to Watch"`.
  - `"keeps Watch working when no session exists"`: Replay is disabled with the title
    `No sessions yet`.
- `replay-ui.spec.ts` (system Chrome, a seeded 10-minute session with a takeover, no Docker):
  - `"plays, scrubs and steps through a seeded session"`:
    1. Play at 4× for 3 s: `replay-time` advances by at least 8 s of session time, and the HUD
       reads the step's label.
    2. Pointer-down on the scrubber at 70 % seeks at once (the time readout changes before
       pointer-up).
    3. Drag to 30 % and release: an exact seek lands at the release point ± 1 px of track.
    4. `→` twice lands on the start of the chapter after next.
  - `"skips idle by default and says so"`: the speed label shows `idle skipped` inside an idle
    band. Toggling skip idle lengthens the track duration.
  - `"shows a takeover gap card and the backdrop over it"`: seeking into the takeover shows
    `You had control here`.
  - `"compares before and after"`: `B` shows the two frames with a wipe. Dragging the divider
    tracks the pointer 1:1, and Escape closes it.
  - `"reduced motion: the playhead jumps and the compare wipe does not animate"`
    (`page.emulateMedia({ reducedMotion: "reduce" })`).
  - Each case takes a screenshot to `apps/web/e2e/out/replay-*.png`.

**Implementation notes:**
- **Loading** (`useReplay`):
  1. `GET /card`, then `GET /recording`.
  2. `GET /events` with `Accept: application/x-ndjson`, read with `response.body.getReader()` and
     a `TextDecoder`, split on `\n`. Each event is folded into the page's model and batched to the
     worker every 1 000 events, through Part 3's `pushEvents`. The worker and the page fold the
     same events.
  3. `busySpans(model, info.manifest.activity, endMs)`, then `buildPlaybackMap(startT, endMs, busy, skipIdle)`.
     `endMs` is `session.end`'s time, else the live session's last event time, refreshed with the
     follow rule.
  4. `stage.replay.open(source)`, then `transport({ playing: false, speed: 1, map, atPlayMs: 0 })`.
  - React sees the model at most 10 times a second (Part 3's pattern), and `tMs` from
    `replay-time` (≤ 10 Hz).
- **Mode and URL.**
  - `App` holds `mode: "watch" | "replay"` and the replay session id, and keeps `?replay=<id>`
    (plus `&t=<ms>` when paused) in sync with `history.replaceState`, so a reload returns to the
    same place. The `#token=` fragment logic is untouched.
  - Opening Replay picks the URL's session, else the live session, else the newest card.
  - Watch is Part 3's Theatre, unchanged. Switching to Replay sets `Stage mode="replay"`, which
    drops the Selkies iframe (one viewer fewer: the gateway may run Fast).
  - Glance stays disabled (not M6).
- **Scrubber:**
  - pointer-down seeks immediately with `preview`, then `setPointerCapture`; the drag tracks 1:1
    in track pixels;
  - every pointer-move sends a `preview` seek (the worker's latest-wins absorbs the burst);
  - 120 ms without movement, and pointer-up, send an `exact` seek;
  - the hover card shows the thumbnail of `observeAt(model, t)` (the thumbs route as a blob URL,
    through Part 3's `thumbnailUrl` pattern with `/thumbs/`), the time and the chapter label;
  - keyboard focus on the track gives ←/→ by 1 s, and Home/End;
  - `aria-valuetext` reads `3:12 of 18:40, Clicking "Save"`.
- **HUD in replay:** `sessionHud(model, tMs)` (Part 3) gives the label. The pill gains a `Replay`
  tag and `3:12 / 18:40`. The neutral Stop is absent. A live session shows the `Jump to live`
  pill (`role="button"`). The stage rim follows `scene.control` at t, so the rim is xenon exactly
  where live was.
- **Gap card:** while `tMs` lies in a gap, or the recording state is `none`, `failed` or
  `expired`, a card from `gapCard` sits centred on the stage. It uses the solid HUD material under
  reduced transparency.
- **Before/after (`CompareView`):** two `<img>` (the frames route, full 1280×800 observe frames, as
  blob URLs) clipped by a vertical wipe. The divider moves on pointer-down and tracks 1:1. It
  starts at 50 %; under reduced motion there is no settle animation. It opens on the current
  chapter's step.
- **Plan and steps as of t:**
  - `PlanRail` gets `asOfMs`. Rows whose chapter starts after t are dimmed (`data-future`), the
    chapter containing t is current, and clicking a row calls `selectStep`;
  - in replay the plan section shows `planAt(model, tMs)`;
  - the rail's header reads `As of 3:12` instead of Part 3's `Following live`.
- **Sessions rail:**
  - it takes the left rail in Replay (the conversation rail returns in Watch) and lists
    `/api/session-index` pages, loading the next page at the end of the scroll;
  - each card shows its cover thumbnail, title (or `Untitled session`), start (`Today 10:12`,
    `Yesterday 18:03`, else a date), duration, verdict word (`Done`, `Stopped`, `Failed`, `Live`,
    `Interrupted`), and recording word (`Video`, `Screenshots only`, `Video removed`);
  - Delete opens a confirm sheet (`Delete this session? Its video, screenshots and log are
    removed from this Mac.`), then `DELETE /api/sessions/:id`.
- **Follow rule:** while the replayed session is live, `useReplay` polls `GET /recording` every
  2 s for `upto`. `refresh` reopens with the new `upto` at the current time, and `go-live` calls
  `onGoLive` (App switches to Watch).

- [ ] **Step 1:** Write `replay-view.test.ts` and the `App.test.tsx` cases. Run
  `pnpm exec vitest run apps/web/src/replay apps/web/src/App.test.tsx`.
  Expected: FAIL.
- [ ] **Step 2:** Implement `replay-view.ts`, `useReplay.ts`, the components, the shell changes and
  the tokens. Run the same command.
  Expected: PASS.
- [ ] **Step 3:** Write `replay-ui.spec.ts`. Run
  `pnpm --filter @localdot/web build && pnpm --filter @localdot/web e2e --grep "seeded session|idle|takeover gap|before and after|reduced motion"`.
  Expected: PASS.
- [ ] **Step 4:** Screenshot check. Seed a home, start the daemon on it, then run
  `pnpm --filter @localdot/web shot "http://127.0.0.1:4750/?replay=<id>#token=<token>" apps/web/e2e/out/replay.png 1440 900 8000`.
  Look at it against the Theatre direction: near-black surround, a quiet scrubber, xenon only on
  the rim and overlays where the agent had control, no purple, no gradient, no emoji.
- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web
git commit -m "feat(web): the Theatre's Replay mode with chapters, ticks, speeds, skip idle and compare"
```

**Acceptance:** the unit, jsdom and e2e suites pass, and the screenshot matches the direction.

---

### Task 15: Web — MP4 export with the overlays burned in

Export renders a range of a session frame by frame, at a fixed 30 fps, with the same
`PixiPresenter` and `sceneAt` as the stage (research §3.1 §4: "Render it with the same Pixi
compositor used live, so preview and export match"). It burns in an honest speed label and,
optionally, step captions. Encoding is WebCodecs H.264 through mediabunny's `CanvasSource`, and
the file is written straight into a file the user picks. Nothing about an export reaches the
daemon or any network.

**Review tier:** light. Its privacy pin is written out below.

**Files:**
- Create: `apps/web/src/export/{export-plan.ts,export-plan.test.ts,export-protocol.ts,export-worker.ts,burn-in.ts,exporter.ts,sink.ts,ExportSheet.tsx}`,
  `apps/web/e2e/export.spec.ts`
- Modify: `apps/web/src/replay/ReplayControls.tsx` (the Export button), `apps/web/src/app.css`

**Interfaces** (exact):

```ts
// apps/web/src/export/export-plan.ts
export const EXPORT_FPS = 30;
export const EXPORT_SIZES = [{ w: 1280, h: 800 }, { w: 1920, h: 1200 }, { w: 2560, h: 1600 }] as const;
export type ExportSpeed = 1 | 2 | 4 | 8;
export interface ExportRequest {
  sessionId: string;
  fromMs: number;
  toMs: number;
  speed: ExportSpeed;
  skipIdle: boolean;
  size: { w: number; h: number };
  captions: boolean;
}
export interface ExportPlan {
  frames: number;
  durationS: number;
  sessionMsAt(frame: number): number;        // sessionAt(map, frame / EXPORT_FPS × 1000 × speed)
  labelAt(frame: number): string | null;     // speedLabel(speed, idleAt(map, t)), "Idle skipped" included
  captionAt(frame: number): string | null;   // the chapter label at t when captions are on
  gapAt(frame: number): RecordingGapReason | null;
}
export function planExport(req: ExportRequest, model: SessionModel, activity: ActivitySpan[], gaps: RecordingGap[]): ExportPlan;
export const PRIVACY_NOTE = "This video shows everything on the computer's screen in the range you chose. Fields marked secret appear as dots. Stretches where you had control were never recorded.";

// apps/web/src/export/export-protocol.ts
export type ExportIn =
  | { type: "start"; request: ExportRequest; source: ReplaySource; model: SessionModel; activity: ActivitySpan[]; gaps: RecordingGap[]; theme: StageTheme; hashes: boolean }
  | { type: "ack"; chunk: number }   // the page wrote chunk `chunk`
  | { type: "cancel" };
export type ExportOut =
  | { type: "chunk"; chunk: number; position: number; data: ArrayBuffer }   // transferred
  | { type: "progress"; done: number; total: number; openFrames: number; encodeQueue: number }
  | { type: "done"; frames: number; bytes: number; hashes: string[] | null }
  | { type: "error"; message: string }
  | { type: "cancelled" };
export const EXPORT_MAX_INFLIGHT_CHUNKS = 4;

// apps/web/src/export/sink.ts
export interface ExportSink { write(position: number, data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export function pickFileSink(suggestedName: string): Promise<ExportSink | null>;   // showSaveFilePicker; null when the user cancels
export function opfsSink(name: string): Promise<ExportSink>;                       // tests (?exportProbe=1)
export function exportSupport(): { ok: true } | { ok: false; reason: string };     // needs showSaveFilePicker, VideoEncoder, OffscreenCanvas

// apps/web/src/export/exporter.ts
export interface ExportHandle { done: Promise<ExportOut & { type: "done" | "cancelled" | "error" }>; cancel(): void; onProgress(cb: (p: Extract<ExportOut, { type: "progress" }>) => void): void }
export function startExport(o: { request: ExportRequest; source: ReplaySource; model: SessionModel; activity: ActivitySpan[]; gaps: RecordingGap[]; sink: ExportSink; hashes?: boolean }): ExportHandle;
```

**Tests:**
- `export-plan.test.ts`:
  - `"renders 30 frames per output second at the chosen speed"`: a 60 s busy range at 4× gives
    `frames = 450` and `durationS = 15`, and `sessionMsAt(449)` is 59 866.7 ± 0.1.
  - `"compresses idle stretches when skipping idle and labels them"`: a 5-minute session with
    20 s of activity at 1×, skipping idle: `frames ≤ 30 × (20 + idle segments × 0.4) + 1`, and
    `labelAt` reads `Idle skipped` inside the compressed segments and `null` elsewhere.
  - `"is honest at every speed"`: 2× everywhere reads `Playing at 2×`.
  - `"never maps two output frames backwards in session time"`.
  - `"clips the range to the session and refuses an empty one"` (RangeError).
  - `"gives the chapter caption and the gap at a frame"`.
- `export.spec.ts` (system Chrome, seeded sessions, no Docker): **the pins**, complete below.

**Implementation notes:**
- **The sheet** (`ExportSheet`). It is anchored to the Export button and enters and exits along
  the same path. Its options:
  - range: whole session, current chapter, or the scrubber selection when one exists;
  - speed: 1/2/4/8×, default 1×;
  - skip idle: default on;
  - size: default 1920×1200 for a 2× session and 1280×800 for 1×. Sizes the encoder refuses are
    disabled with their reason, checked with mediabunny's `canEncodeVideo("avc", { width, height })`;
  - step captions: default on.

  It shows `PRIVACY_NOTE` verbatim. **Save…** calls
  `pickFileSink(suggestedExportName(new Date()))`: the name carries the date only, never the title.
  Then come a progress bar (`frames done / total`, elapsed, remaining) and **Cancel**. Esc cancels
  before Save; after Save it asks first.
- **The worker:**
  - its own `OffscreenCanvas(size.w, size.h)` and `PixiPresenter.create(canvas, { width, height, dpr: size.w / 1280, theme, warn })`,
    so chips and the cursor keep their stage proportions;
  - the camera is `cameraFor({ stageW: w, stageH: h, desktopW: screen.w, desktopH: screen.h, zoom: 1 })`;
  - the video comes from a `ReplayVideo` used only in `play` mode with increasing targets
    (sequential decode, no seeks after the first);
  - per frame i:
    1. `t = plan.sessionMsAt(i)`;
    2. `sourceAt(t)` → video, backdrop or hold;
    3. present;
    4. `presenter.draw(sceneAt(model, t, { reducedMotion: false }))`;
    5. `burnIn.draw(plan.labelAt(i), plan.captionAt(i), plan.gapAt(i))`;
    6. `presenter.render()`;
    7. `await canvasSource.add(i / EXPORT_FPS, 1 / EXPORT_FPS)`, which awaits the encoder's queue.
- **The output:**
  - `new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) })`.
    With `fastStart: false` the `moov` goes at the end and the `mdat` size is patched at the
    start, so the writes are positioned; the sink supports that
    (`FileSystemWritableFileStream.write({ type: "write", position, data })`).
  - The track is `new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH, keyFrameInterval: 2, latencyMode: "quality" })`.
  - **No metadata tags** are set. mediabunny writes no `udta` or `meta` by default (verified); its
    handler name is the fixed string `MediabunnyVideoHandler`.
  - `writable` posts each chunk to the page (its `ArrayBuffer` transferred) and resolves on the
    page's `ack`, with at most `EXPORT_MAX_INFLIGHT_CHUNKS` in flight. That is the backpressure,
    and the file never sits in memory.
- **Burn-in** (`burn-in.ts`, a Pixi `Container` in the screen layer):
  - the label chip sits bottom-left, 16 px in, in the HUD material;
  - the caption is a lower third centred 64 px from the bottom, 60 characters max via
    `clipText`;
  - the gap card sits centred, with `gapCard`'s strings;
  - every colour comes from the theme. There is no xenon in the burn-in.
- **Determinism:** frame i depends only on `(model, plan, i)`. With `hashes: true` (only under
  `?exportProbe=1`), the worker hashes each frame's RGBA (`presenter.app.renderer.extract.pixels`
  of the full canvas, SHA-256), *before* encoding. The encoder may differ run to run; the
  rendering may not.
- **Cancel:** `output.cancel()`, the worker posts `cancelled`, and the page calls `sink.abort()`.
  For a picked file, Chrome then discards its swap file, so no partial MP4 is left.
- **Performance** (Review Focus 4): one decoded frame and one rendered frame at a time, the
  encoder queue at most 4 (`CanvasSource.add` awaits it), and at most 4 chunks of 4 MiB in flight
  to the page. `progress` carries `openFrames` and `encodeQueue` every 15 frames.

**The pins, complete:**

`apps/web/e2e/export.spec.ts`:
```ts
import { expect, type Page, test } from "@playwright/test";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { type SeededHome, seedHome } from "./seed.ts";

const MARKER = `p7-privacy-marker-${Date.now().toString(36)}`;
let daemon: RunningDaemon;
let privacy: SeededHome;
let long: SeededHome;

test.use({ launchOptions: { args: ["--js-flags=--expose-gc"] } });

test.beforeAll(async () => {
  privacy = seedHome({ minutes: 3, title: `Quarterly ${MARKER}`, marker: MARKER, takeover: "60000-90000" });
  long = seedHome({ home: privacy.home, minutes: 120 });
  daemon = await startDaemon({}, { home: privacy.home });
});

test.afterAll(async () => {
  await daemon?.stop();
});

interface ExportResult { frames: number; bytes: number; hashes: string[] | null; peakOpenFrames: number; peakEncodeQueue: number }

async function openForExport(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${daemon.origin}/?replay=${sessionId}&replayProbe=1&exportProbe=1#token=${daemon.token}`);
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready", undefined, { timeout: 120_000 });
}

// Runs the real exporter into an OPFS file (the save picker cannot be scripted). The e2e hook
// reads the file back itself for the checks below.
const runExport = (page: Page, opts: { speed: 1 | 2 | 4 | 8; skipIdle: boolean; hashes: boolean; fromMs?: number; toMs?: number }): Promise<ExportResult> =>
  page.evaluate((o) => (window as unknown as { __localdot: { exportProbe: { run(o: unknown): Promise<ExportResult> } } }).__localdot.exportProbe.run(o), opts);

async function exportSession(page: Page, sessionId: string, opts: Parameters<typeof runExport>[1]): Promise<ExportResult> {
  await openForExport(page, sessionId);
  return runExport(page, opts);
}

const fileScan = (page: Page, needles: string[]) =>
  page.evaluate(async (n) => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle("localdot-export-probe.mp4")).getFile();
    const text = new TextDecoder("latin1").decode(new Uint8Array(await file.arrayBuffer()));
    return { size: file.size, found: n.filter((x) => text.includes(x)), boxes: ["udta", "meta", "ilst", "©nam", "©too"].filter((b) => text.includes(b)) };
  }, needles);

test("exports carry no identifying data and never leave the page (Review Focus 6)", async ({ page }) => {
  await openForExport(page, privacy.seed.sessionId);
  // From here on, nothing may be sent anywhere: only bodiless reads from the daemon, and no
  // WebSocket frame from the page (the Theatre's own polls are reads, so they pass).
  const sent: string[] = [];
  page.on("request", (r) => {
    const origin = new URL(r.url()).origin;
    if (!["GET", "HEAD"].includes(r.method()) || r.postData() !== null || origin !== daemon.origin || /export/i.test(r.url())) sent.push(`${r.method()} ${r.url()}`);
  });
  page.on("websocket", (ws) => ws.on("framesent", () => sent.push(`ws ${ws.url()}`)));
  const result = await runExport(page, { speed: 2, skipIdle: true, hashes: false });
  expect(result.frames).toBeGreaterThan(0);
  expect(sent).toEqual([]);
  const scan = await fileScan(page, [MARKER, privacy.seed.sessionId, privacy.home, daemon.token, "Quarterly", "events.jsonl"]);
  expect(scan.size).toBe(result.bytes);
  expect(scan.found).toEqual([]);
  expect(scan.boxes).toEqual([]);
  // The takeover span is a card, never a recorded frame: the probe saw no video source inside it.
  const inside = await page.evaluate(() => (window as unknown as { __localdot: { exportProbe: { sourcesBetween(fromMs: number, toMs: number): string[] } } }).__localdot.exportProbe.sourcesBetween(60_000, 90_000));
  expect(inside.length).toBeGreaterThan(0);
  expect(inside.every((s) => s !== "video")).toBe(true);
});

test("renders identical frames in two exports (Review Focus 5)", async ({ page }) => {
  const range = { fromMs: privacy.seed.steps[1]?.startMs ?? 0, toMs: privacy.seed.steps[6]?.endMs ?? 30_000 };
  const a = await exportSession(page, privacy.seed.sessionId, { speed: 1, skipIdle: false, hashes: true, ...range });
  const b = await exportSession(page, privacy.seed.sessionId, { speed: 1, skipIdle: false, hashes: true, ...range });
  expect(a.hashes?.length).toBe(a.frames);
  expect(new Set(a.hashes).size).toBeGreaterThan(a.frames / 4);
  expect(b.hashes).toEqual(a.hashes);
});

test("exports a 2-hour session in bounded memory (Review Focus 4, export)", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const mainHeap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  };
  await openForExport(page, long.seed.sessionId);
  const base = await mainHeap();
  const started = Date.now();
  const result = await runExport(page, { speed: 8, skipIdle: true, hashes: false });
  const seconds = (Date.now() - started) / 1000;
  expect(result.peakOpenFrames).toBeLessThanOrEqual(3);
  expect(result.peakEncodeQueue).toBeLessThanOrEqual(4);
  expect((await mainHeap()) - base).toBeLessThan(48 * 1024 * 1024);
  const scan = await fileScan(page, []);
  expect(scan.size).toBe(result.bytes);
  test.info().annotations.push({ type: "measure", description: `${result.frames} frames in ${seconds.toFixed(0)} s (${(result.frames / seconds).toFixed(1)} fps), ${(result.bytes / 1e6).toFixed(1)} MB` });
});
```

The e2e hook `window.__localdot.exportProbe` exists only under `?exportProbe=1`:
- `run(o)` exports the replayed session with `opfsSink("localdot-export-probe.mp4")`, `hashes`
  as asked, and the range defaulting to the whole session. It returns
  `{ frames, bytes, hashes, peakOpenFrames, peakEncodeQueue }`.
- `sourcesBetween(fromMs, toMs)` returns the `sourceAt` result of every exported frame whose
  session time lies in the range.

- [ ] **Step 1:** Write `export-plan.test.ts`. Run `pnpm exec vitest run apps/web/src/export`.
  Expected: FAIL.
- [ ] **Step 2:** Implement `export-plan.ts`. Run the same command.
  Expected: PASS.
- [ ] **Step 3:** Write `export.spec.ts`. Implement the protocol, the worker, the burn-in, the
  sinks, the exporter, the sheet and the e2e hook. Run
  `pnpm --filter @localdot/web build && pnpm --filter @localdot/web e2e --grep "export"`.
  Expected: three tests pass. The 2-hour export's measure is recorded in the task report.
- [ ] **Step 4:** Screenshot check of the open sheet and of its progress state (`shot`), against
  the Theatre direction.
- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web
git commit -m "feat(web): export a replay to MP4 with the overlays burned in, rendered by the stage"
```

**Acceptance:** the export pins pass. An export opened in QuickTime Player plays, with the burned-in
label at the speeds above 1×.

---

### Task 16: Acceptance — a recorded puppet session replays, scrubs, jumps to live and exports; docs; the full suite

Success criterion 4, end to end on a real cell:
1. A puppet session runs **with no viewer**, at Fast speed. The daemon records it.
2. It appears in the index, replays with scrubbing and chapters, and its frames match what the
   cell showed.
3. A live session offers "Jump to live".
4. The recorded session exports to an MP4 that decodes.

**Review tier:** light.

**Files:**
- Create: `apps/web/e2e/recorded-session.spec.ts`, `docs/replay.md`
- Modify: `README.md` ("Replay" section), `.github/workflows/ci.yml` (the Docker-free replay and
  export specs join the e2e job that already runs without Docker, if one exists; otherwise
  document the command)
- Test: the full suite

**Interfaces:**
- Consumes:
  - Part 3's e2e helpers `createReadyCell(daemon, scale)`, `runPuppet(d, cellId, script)`,
    `waitForSessionEnd(d, sessionId)` and `frameBytes(d, sessionId, frameId)`;
  - `apps/daemon/puppet/demo-multiapp.json`;
  - every interface above.
- Produces: `docs/replay.md`, the user and operator note covering:
  - where recordings live, the layout from Task 2, and the retention variables
    `LOCALDOT_RECORDINGS_MAX_GB` and `LOCALDOT_RECORDINGS_MAX_DAYS`;
  - `LOCALDOT_RECORDING=0`;
  - what is never recorded (takeover) and what an export contains (`PRIVACY_NOTE`);
  - mediabunny's MPL-2.0 notice location.

**`recorded-session.spec.ts`** (`LOCALDOT_DOCKER_TESTS=1`, skipped otherwise, as in Parts 2 and 3).
These are the named tests; the replay probe is the one from Task 13:
- `"records a puppet session that nobody watched"`:
  1. Start the daemon and create a 2× cell with `createReadyCell`. Open no page.
  2. `runPuppet(demo-multiapp)`, then `waitForSessionEnd`.
  3. `GET /recording` gives `manifest.state === "complete"`, `codec` matching `^avc1\.` (S9's),
     `width` 2560 and `height` 1600, at least one activity span per GUI step, and no gap.
  4. The session's `action.dispatch` events were logged at Fast speed: no viewer was attached, so
     the gateway's travel durations equal Part 3's Fast formula. This is Part 3's assertion,
     reused.
- `"replays it with frames that match what the cell showed"`:
  1. Open `/?replay=<id>&replayProbe=1`.
  2. For each GUI step, seek exactly to the step's `observe` event time.
  3. Probe the presented frame as a 320×200 RGBA thumbnail (probe op
     `{ op: "thumb", w: 320, h: 200 }`, added here: the presented video frame drawn into a
     320×200 OffscreenCanvas, as RGBA).
  4. Decode the daemon's thumbnail of the same `observe` frame (`/thumbs/<frameId>`, through sharp
     in Node).
  5. The mean absolute difference over RGB is below 12. The observe screenshot and the stream's
     frame show the same settled screen; the bound allows H.264 4:4:4 against WebP q80 and two
     scalings.
  6. The chapters equal the steps, and the step labels match the puppet script's.
- `"offers Jump to live while a session runs, and goes live from it"`:
  1. Start a second puppet run whose script has a `wait` of 20 s.
  2. Open Replay on it: the `Jump to live` pill is visible.
  3. Click it: the mode is Watch, the Selkies iframe is mounted, and `data-frames` rises within
     10 s.
  4. Stop the session.
- `"exports the recorded session to an MP4 that decodes"`:
  1. `__localdot.exportProbe.run({ speed: 4, skipIdle: true, hashes: false })`.
  2. Read the OPFS file back with mediabunny in the page: one AVC track at 1920×1200, a duration
     within 1 s of `playDuration(map) / 4`, and the first and last packets decodable
     (`VideoSampleSink.getSample` returns non-null at both ends).
- `afterAll`: Part 2's `daemon.stop()` deletes the cell (`?purge=1`), and the spec asserts that no
  `localdot-test-*` container is left (exit status 0 on the `docker ps` probe).

- [ ] **Step 1:** Write `recorded-session.spec.ts`. Add the `thumb` probe op to `probe.ts`. Run
  `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e --grep "recorded|Jump to live|exports the recorded"`.
  Expected: four tests pass.
- [ ] **Step 2:** Write `docs/replay.md` and the README section ("Replay": what is recorded, where
  it lives, how to open Replay, the keys, and how to export).
- [ ] **Step 3:** Run the whole suite:
  ```bash
  pnpm test && pnpm typecheck && pnpm lint && pnpm hygiene
  pnpm --filter @localdot/web build
  pnpm --filter @localdot/web e2e --grep "Review Focus|seeded session|idle|takeover gap|before and after|reduced motion|export"
  LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
  LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e
  ```
  Expected: all green. Part 2's and Part 3's Docker and e2e suites pass with the recorder running,
  and Part 3's two-viewer test still sees no stall: the recorder is one more Selkies client, never
  a relay viewer.
- [ ] **Step 4:** On the M1-class laptop, if one is available, record the cost of a recorded
  session. Run S1's `load-continuous.sh` at 2× for 60 s under each of: no viewer; one viewer; one
  viewer plus the recorder. Record the daemon's and the cell's CPU, and the bytes per second
  written. Write them in `docs/measurements/2026-10-recorder.md`.
- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/web README.md docs .github/workflows/ci.yml
git commit -m "test(e2e): replay acceptance on a recorded puppet session, and the replay docs"
```

**Acceptance:** success criterion 4 holds on a real cell. A session nobody watched replays with
scrubbing, a step timeline and "Jump to live", and exports to an MP4 that plays.

---

## The replay (M6)

For the README, as Part 3's "The visual core (M2)":

- The daemon records every live session, watched or not, as a fragmented MP4 in
  `~/.localdot/sessions/<id>/recording/`. It takes the cell's H.264 stream as it arrives and
  re-encodes nothing. The recording's clock is the event log's clock, so a frame's media time is
  its session time.
- A crash or a full disk loses no frame that reached the recorder: recovery rebuilds the tail from
  a per-GOP journal.
- Nothing is recorded while you have control of the computer.
- Recordings older than 30 days, or beyond 20 GB in total, are removed oldest first
  (`LOCALDOT_RECORDINGS_MAX_DAYS`, `LOCALDOT_RECORDINGS_MAX_GB`). A session without video still
  replays, step by step, over its screenshots. `LOCALDOT_RECORDING=0` turns recording off.
- Replay (the top bar's third mode) has these controls:
  - the scrubber's chapters are the steps, and its ticks the clicks, typing, keys, approvals,
    takeovers and failures;
  - Space plays, K pauses, ←/→ step, J/L jump 10 s, `[`/`]` change the speed (½× to 8×), and B
    compares a step's screen before and after;
  - idle stretches are skipped by default and labelled;
  - "Jump to live" returns to a running session.
- Export renders the range you choose with the overlays burned in, at 30 fps, into a file you
  pick. It never goes through the daemon.

## Interfaces later milestones build on

Exact module paths and exports as they exist at the end of this plan.

**M5 (control and safety): the approval and takeover markers**
- **Takeover.** M5 appends
  `control.change { holder: "user", reason: "user_takeover" | "handoff_request" }` through
  `EventLog.append` **before** the first user input reaches the cell, and
  `control.change { holder: "agent", reason: "resume" }` at hand-back.
  - `apps/daemon/src/recorder/control-gate.ts` `ControlGate` already keeps every frame stamped at
    or after the first event, up to the first key frame after the second, out of the recording
    and the journal. The recorder requests that key frame itself. M5 adds nothing to the recorder.
  - The rule M5 must keep: the `control.change` is appended before the input path opens, never
    after. Task 11's pin covers a frame stamped exactly at the change's `t`.
- **Marks.** `approval.request/resolve`, `control.change` and `pause.change` already fold into
  `SessionModel.marks` (`packages/stage/src/marks.ts`, `markOf`) with exact labels and tones.
  They tick on the scrubber, keep the playback map busy, and burn into exports through captions.
  - M5 can give approvals their own replay card: read
    `model.marks.filter(m => m.kind === "approval" || m.kind === "decision")` and the matching
    events. No schema change is needed.
  - Approval previews' `image` (base64 in the schema) is not used by replay. If M5 moves it to a
    file like `observe`'s, `Thumbnails` serves it unchanged through a frame id.
- **Gaps.** `RecordingGap.reason: "user-control"` drives the replay card `You had control here`
  and the export's burned-in card (`gapCard`, `apps/web/src/replay/replay-view.ts`).
- **Lifecycle.** `LiveSessions.addHooks({ beforeRun, afterRun })` (`apps/daemon/src/gateway/live.ts`).
  M5's Stop and kill switch abort the run, and the recorder's `afterRun` finalizes the recording.
  Stop needs no recorder call of its own.

**M7 (signed-in browser): the second screen**
- A recording is per screen. The layout keeps `recording/` for the desktop, and M7 adds
  `recording-<screen>/` with the same files (`RECORDING_*` names, `RecordingManifest`), written by
  a second `SessionRecorder` whose `feed` is the browser cell's Selkies feed.
- `SessionRecorderDeps.dir` and `RecorderDeps.feedFor(cellId, …)` already take any cell and
  directory.
- `RecordingInfo` is per screen: M7 adds `GET /api/sessions/:id/recording?screen=<name>`, with
  today's route as `screen=desktop`.
- Replay picks the screen in effect at t: `switch_screen` events fold into a `screens` timeline in
  the model (M7's schema). The worker gets one `ReplaySource` per screen and `sourceAt` gains the
  active screen. The decode policy, backdrop, export plan and pins work per screen unchanged.

**M8 (premium feel), seams only (M9 ships first)**
- The "what changed" flash: Part 3's `screen.settle.changed` (≤ 8 rectangles) is in the log.
  M8's flash is a `Scene` part drawn from `sceneAt`, so replay and export show it with no replay
  change. Replay adds no flash of its own.
- Auto-camera: the replay worker and the export worker call `cameraFor(… zoom: 1)`. M8's
  `camera.hint`-driven camera replaces that call in both, "cinematic in replay" per the spec.

**M9 (ship)**
- `doctor` should check the free space of `~/.localdot` against `MIN_FREE_START_BYTES`
  (`apps/daemon/src/recorder/session-recorder.ts`) and report the recordings' total against
  `retentionFromEnv()`.
- Settings may expose `RetentionPolicy` and `LOCALDOT_RECORDING`.
- `npx localdot`'s bundle must ship `dist/assets/licenses/mediabunny-1.61.0.txt` (Task 3).

**Daemon (stable)**
- `apps/daemon/src/recorder/`:
  - `writer.ts`: `RecordingWriter`, `RecordedFrame`, `RecordingFs`, `FRAGMENT_MIN_SECONDS`;
  - `recover.ts`: `recoverRecording`, `readFragments`, `StreamFormat`;
  - `view.ts`: `openRecordingView`;
  - `boxes.ts`: `mfraBox`, `topLevelBoxes`;
  - `journal.ts`: the record codec;
  - `wire.ts` and `annexb.ts`: the Selkies header and `avcCodecString`;
  - `feed.ts`: `SelkiesFeed`, `FrameFeed`, `RECORDER_HANDSHAKE`;
  - `session-recorder.ts`: `SessionRecorder`, `FrameGate` and the constants;
  - `control-gate.ts`: `ControlGate`;
  - `recorder.ts`: `Recorder`.
- `apps/daemon/src/sessions/`: `streamEventLines`, `summarizeSession`, `SessionIndex`,
  `Thumbnails`, `sweepRecordings`/`retentionFromEnv`, `replayRoutes`; `EventLog.logFile`,
  `EventLog.forget`, and tail recovery.
- Routes: `GET /api/session-index`, `GET /api/sessions/:id/card`,
  `GET /api/sessions/:id/events` (NDJSON on `Accept`), `GET /api/sessions/:id/recording`,
  `GET|HEAD /api/sessions/:id/recording/video.mp4?upto=`, `GET /api/sessions/:id/thumbs/:frameId`,
  `DELETE /api/sessions/:id`.
- Test helpers:
  - `@localdot/stage/testing` (`synthStream`, `frameOfLuma`);
  - `apps/daemon/src/recorder/testing/{seed-session.ts,fake-feed.ts,fake-selkies.ts,full-fs.ts}`;
  - `apps/web/e2e/seed.ts`.

**Stage and web (stable)**
- `@localdot/stage`:
  - `startedCount`, `observeAt`, `stepAt`, `planAt`, `markOf`, `TimelineMark`;
  - `sceneAt(…, opts)`;
  - `replay/`: `buildPlaybackMap`, `sessionAt`, `playAt`, `idleAt`, `busySpans`, `chapters`,
    `ticks`, `ReplayClock`, `playMsAt`, `retime`, `REPLAY_SPEEDS`.
- `@localdot/protocol` `recording.ts`: the layout constants, `MEDIA_TIMESCALE`,
  `RecordingManifest`, `FragmentEntry`, `RecordingGap`, `SessionCard`, `SessionIndexPage`,
  `RecordingInfo`.
- `apps/web/src/stage/worker-protocol.ts`: `ReplaySource`, `ReplayTransport`, `ReplayStatus`,
  `ReplayProbeCommand`, and the `replay-*` messages. `StageHandle.replay`, and `Stage`'s `mode`.
- `apps/web/src/replay/`: `ReplayVideo`, `nextDecodeStep`, `sourceAt`, `ObserveBackdrop`,
  `useReplay`, `replay-view.ts`.
- `apps/web/src/export/`: `planExport`, `startExport`, `ExportSink`, `PRIVACY_NOTE`.

**Part 7 obligations carried (not implemented here)**
- If S9 finds per-client encoding (Q7), `ViewerTapFeed` (Task 9's contained change) replaces the
  own connection while a viewer is attached.
- If `REQUEST_KEYFRAME` has no effect on a still screen (S9 Q5), the newest fragment of a live
  recording stays uncommitted through a long still stretch. A replay of a live session then shows
  the last action's frames only once activity resumes. Crash safety is unaffected (the journal).
- The recorder stops on a stream format change (`recorder-error`). A cell recreated at another
  scale mid-session ends that session's video. Supporting it means a second track or file, which
  M7's per-screen layout makes natural.
- Replay of very long live sessions polls `GET /recording` every 2 s. A push over the session
  stream would be leaner (M9).
- The export's 2560×1600 option depends on the Mac's H.264 encoder accepting that size
  (`canEncodeVideo`); it is disabled with its reason otherwise.

## Decisions taken by this plan (P7-R1 to P7-R17)

- **P7-R1 Recording happens in the daemon, as a passive Selkies client per live session.**
  - **Why:**
    - the spec requires replay "with zero, one or many viewers", the daemon stamping "every
      incoming video chunk with its own monotonic clock", and "taps the same stream for
      recording";
    - Glance, the default mode, runs exactly when nobody watches;
    - remuxing costs about 44 µs per frame in Node, with no decode and no encode;
    - the evidence of what the agent did is written by a trusted host process on the event log's
      own clock, never by the cell;
    - see "Where recording happens".
  - **If wrong:**
    - if Selkies encodes per client, the extra client costs the cell CPU (S9 Q7). Then
      `ViewerTapFeed` (Task 9's contained change) taps the relay while a viewer exists;
    - if the passive handshake gets no video alone (S9 Q1), the recorder must send the primary's
      `SETTINGS`, which S9 checks against a live viewer (Q2) before anything is built.
- **P7-R2 Storage: one fragmented MP4 per session, one GOP per fragment, an append-only file,
  `fragments.jsonl` written after each fragment's bytes, a per-GOP journal for the open fragment,
  and recovery that appends the journal's frames and an `mfra`.** Live and cut-off recordings are
  served as their committed fragments plus a fresh `mfra`, at a stable `upto` snapshot.
  - **Why:**
    - mediabunny 1.61.0 holds the open fragment in memory, so the journal is what makes a crash
      lose nothing that reached the recorder (verified with SIGKILL at five points);
    - one GOP per fragment works around mediabunny marking only a fragment's first sample as a
      sync sample (verified);
    - the synthesized `mfra` turns a whole-file walk into four reads (verified: 5.9 MB → 0.8 MB
      read for one seek in a 2-hour file).
  - **If wrong:** a mediabunny upgrade that changes fragment cutting or `trun` flags breaks the
    seek pins (Task 7's per-GOP test, Task 8's seek pin). The version is pinned exactly (Task 3).
- **P7-R3 Media time is session time.** Timescale 1 000 000 through `frameRate: 1_000_000`, and
  packet timestamps are the frame's arrival in session µs, so the index from event-log time to
  media time is the identity.
  - **Why:** no mapping table to keep, crash-proof by construction, and exact to the µs at
    2 hours (verified).
  - **If wrong:** if a future mediabunny rejects `frameRate` that high, the fallback is its default
    timescale 57 600 with a ±17 µs tolerance in the seek pins. Nothing visible changes.
- **P7-R4 Key frames: request an IDR after 2 s of frames without one, and once when the screen
  goes still. Never while still.**
  - **Why:**
    - an exact seek decodes at most about 2 s of frames;
    - a still screen costs nothing (Selkies sends nothing);
    - the idle IDR commits the fragment holding the last change.
  - **If wrong:** if IDRs cost too much bitrate at 2× (S9 Q5 measures), raise
    `KEYFRAME_EVERY_MICROS`. Seeks get slower, and the decode policy's preview path keeps
    scrubbing responsive.
- **P7-R5 Retention and caps.**
  - The values: 20 GB of recordings in total and 30 days, by environment, settable in M9; 8 GB per
    session; recording never starts below 2 GB free and stops cleanly below 1 GB.
  - Expiry removes the video only. The log, screenshots, thumbnails and summary stay, so the
    session still replays over its screenshots.
  - **Why:** a 2× desktop streams 14–35 Mbps while moving (S1). A long busy session can reach
    gigabytes, and nothing else bounds the disk.
  - **If wrong:** users who want everything kept must raise the cap. The index says "Video removed"
    and never hides the session.
- **P7-R6 Thumbnails come from `observe` screenshots,** made 320×200 WebP by sharp and cached in
  `thumbs/`, never decoded from the video.
  - **Why:** the daemon decodes nothing; every step already ends with a settled screenshot (Part 3);
    and the hover preview needs only the step's screen.
  - **If wrong:** a stretch without steps (a takeover, long typing) has no fresh thumbnail.
    The preview then shows the last step's.
- **P7-R7 The session index is a `session_cards` table in `index.sqlite`, rebuildable from each
  session's `summary.json` and folder (the spec's rule). `EventLog` recovers from the file's tail
  and rebuilds its index only when stale.**
  - **Why:** Part 1 re-read and re-indexed every log at every start (1.0 s per 2-hour log,
    measured). Tail recovery takes 1 ms (verified, Part 1's 21 tests unchanged).
  - **If wrong:** a log corrupted in the middle is still skipped line by line by `read()` and the
    NDJSON stream, as before.
- **P7-R8 Overlays in replay and export are `sceneAt(model, t, view)` and nothing else, in the
  same worker and renderer as live. The video shown is the last frame with arrival ≤ t. Export
  renders by frame index at a fixed 30 fps. The camera is zoom 1 (the auto-camera is M8's).**
  - **Why:** "replay equals live" (research §4.1), deterministic across loads and exports (the
    pins).
  - **If wrong:** nothing is lost by construction. A future stateful overlay would break the
    determinism pins first.
- **P7-R9 Scrubbing, speed and skip idle.**
  - The decode policy: during a drag, key-frame previews (latest wins); an exact seek on release
    or after 120 ms still; while playing, sequential decode that jumps to the key frame when
    1.5 s behind.
  - Speeds ½× to 8×.
  - Skip idle compresses quiet stretches of 1.5 s or more to 400 ms. A stretch is quiet when it
    has no video activity, no action, no mark and no step edge. Labelled honestly: "Playing at
    4× · idle skipped".
  - Before/after uses the step's screenshots.
  - The follow rule: stepping back pins; reaching a live session's edge goes live.
  - **Why:**
    - software decoding of 2× 4:4:4 cannot keep up with 8× motion, so frames are shed by GOP,
      never shown out of time;
    - thinking time with a still screen is the bulk of an agent session;
    - research §4.9 asks for each of these.
  - **If wrong:** the constants are named (`JUMP_AHEAD_MS`, `IDLE_MIN_MS`, `IDLE_KEEP_MS`) and
    unit-tested, and tuning them is a one-line change.
- **P7-R10 Privacy.**
  - Nothing is recorded while the user has control: not the file, not the journal. Recording
    resumes at a key frame.
  - Exports carry no session id, title, path, token, event data or metadata box. They are never
    uploaded, and their suggested name carries only the date.
  - Pixels are **not** redacted: cells hold surrogates only (no real secret can be on screen),
    and secret fields show dots at the source.
  - **Why:** takeover is exactly logins, 2FA, CAPTCHAs and payment, and the model sees nothing
    then either. Anything else the screen showed is what the user asked the agent to do, kept on
    their own Mac.
  - **If wrong:** a user who wants an export of their own takeover cannot have one. A page that
    shows sensitive data the agent was asked to read (an email, a statement) is in the recording
    and in any export of that range; the sheet's `PRIVACY_NOTE` says so before Save. Per-region
    blur (research §4.9) is a later option: the `Target.secret` boxes in the log are where it
    would start.
- **P7-R11 Export runs in the browser.**
  - It uses the same renderer at 30 fps CFR, mediabunny's `CanvasSource` (WebCodecs H.264,
    hardware where the Mac has it), and `moov` at the end. It is streamed with acknowledged
    4 MiB chunks into a file the user picks (File System Access).
  - The sizes are 1280×800, 1920×1200 (default for 2×) and 2560×1600.
  - The burn-in is the speed label, step captions and gap cards.
  - **Why:**
    - the overlays exist only in the renderer, and the spec puts them only in the viewer;
    - the daemon has no encoder;
    - streaming to the file keeps a 2-hour export's memory flat;
    - the Theatre already needs Chromium.
  - **If wrong:** a browser without `showSaveFilePicker` cannot export (`exportSupport` says why).
    A daemon-written fallback would need an upload route, which this plan deliberately does not
    add (privacy pin: exports never leave the page).
- **P7-R12 Stretches without video replay over the `observe` screenshot in effect,** shown like a
  1× frame scaled into the session's screen, with a card naming why.
  - **Why:** "any session replays" must hold for a failed recorder, an expired recording, and the
    time before the first frame.
  - **If wrong:** the replay shows a slightly older screen where no screenshot followed a change,
    with overlays still exact.
- **P7-R13 mediabunny 1.61.0 (MPL-2.0) is used unmodified,** from `node_modules` in the daemon and
  bundled in the UI. The UI build ships its license and a notice naming the Source Code Form
  (Task 3), and the pin and the absence of patches are tested.
  - **Why:** MPL-2.0 is file-level copyleft, and §3.2 asks for notice and source availability for
    the Executable Form.
  - **If wrong:** a patched mediabunny would need its modified files published under MPL-2.0; the
    test forbids patches.
- **P7-R14 No new protocol event.** Replay relies on the events listed under "Protocol events this
  plan relies on". M4 and M5 events without producers yet fold into typed marks through `markOf`,
  and future types become neutral marks.
  - **Why:** keyd's schema export and Parts 3–5 are untouched; the recorder's state lives in the
    session folder, not the log.
  - **If wrong:** a later plan that wants recording state in the log adds `recording.*` events.
    The manifest stays the source of truth.
- **P7-R15 Replay lives in the existing render worker, and Replay mode unmounts the Selkies
  iframe.**
  - **Why:**
    - one renderer, so the overlays are the same pixels;
    - the viewer count drops, so the gateway may run Fast while the user reviews;
    - "Jump to live" remounts it through Part 2's re-ticket path.
  - **If wrong:** switching back to Watch costs a stream reconnect (about 1 s).
- **P7-R16 The recorder hooks `LiveSessions`.** `beforeRun` starts it and waits up to 3 s for the
  first key frame, `afterRun` finalizes, startup recovery runs before the daemon serves, and
  SIGTERM finalizes within 5 s.
  - **Why:** a session's first action is recorded, and a crash or restart never leaves a
    half-written recording behind.
  - **If wrong:** a cell whose stream is slow to start delays the first step by up to 3 s. The
    timeout is a named constant.
- **P7-R17 The browser suites replay seeded synthetic sessions, with no Docker.** The video is
  I_PCM H.264, whose decoded picture tells which frame it is.
  - **Why:**
    - seek accuracy, determinism and memory are pinned on every machine, in seconds;
    - the decode check is exact (frame identity), not perceptual;
    - real cells are reserved for the one acceptance spec (Task 16).
  - **If wrong:** the synthetic stream is Constrained Baseline 4:2:0, not 4:4:4 like the cell's.
    Task 16's real-cell spec covers the real codec.

## Verification (done while writing this plan)

Run in a scratch copy with the pinned toolchain: Node 24.21.0, pnpm 10.29.3, TypeScript 7.0.2,
Vitest 5.0.3, zod 4.6.5, mediabunny 1.61.0, tsx 4.23.15. The Linux scratch machine has no Docker
and no Chrome.

| What | How | Result |
|---|---|---|
| mediabunny's muxing path in Node | `EncodedVideoPacketSource("avc")`, Annex B with no description, `StreamTarget` to a file | fragmented writes are append-only until `finalize`; the timestamps are kept (the first packet at 3.25 s stays 3.25 s); ffprobe reads the file |
| Session-µs timestamps | `frameRate: 1_000_000`, 40 packets at about 7 199 s | timescale 1 000 000; 40/40 µs-exact; 156/156 boundary seeks exact |
| Key flags inside fragments | 1 s fragments with 12-frame GOPs | only the first sample is flagged as a key (mediabunny's `trun`); with `minimumFragmentDuration: 0`, every key is flagged |
| Crash recovery | journal tail muxed separately, moof+mdat appended, `mfra` appended | 53/53 packets back; ffmpeg decodes all 53 with the right frame identity |
| Seek cost of `mfra` | a 1 799-fragment "2-hour" file | without: 5.9 MB read; with a synthesized `mfra`: 4 reads, 0.2 ms |
| Synthetic H.264 (Task 4) | ffmpeg decode of 60 frames, `frameOfLuma` on each | 60/60 identified |
| Task 2, 4, 6 code | the plan's code blocks extracted and run | all tests pass; `tsc` clean |
| Task 5 pin + Part 3's stage tests | Part 3's model, scene and camera extracted from its plan, patched as Task 5 says | 23 stage tests pass; the naive scene measured 0.99 ms per call, the indexed one passes the 0.2 ms bound |
| Tasks 7, 8, 10, 11 pins | the test files as printed, against prototypes of the writer, recovery, view, session recorder and gate | 21/21 recorder tests pass, including SIGKILL at five points, ENOSPC, the takeover gate and the free-space floors |
| Task 9 wire and Annex B | `wire.test.ts` | passes |
| Task 12 long-log pins | Part 2's `EventLog` with Task 12's tail recovery; Part 1's `event-log.test.ts` | the reopen pin fails before (1 008 ms) and passes after (1 ms); NDJSON peak retained heap 0.6 MB for a 55 MB log; Part 1's 21 EventLog tests pass |
| mediabunny output metadata | an MP4 with `fastStart: false` | no `udta` or `meta`; the handler name is `MediabunnyVideoHandler` |

**Not verified here (no Docker, no Chrome):**
- every Selkies question (S9 is Task 1);
- the browser pins and the UI (Tasks 13–15);
- the route security test (it needs Part 2's and Part 3's `createApp` as built);
- the summaries, index, thumbnails and retention;
- the feed tests;
- the Docker acceptance (Task 16);
- Biome on the plan's code. `pnpm format` reflows the long lines, as it did for Part 3's.

## Assumptions on code not yet built (for the pre-flight)

Part 7 builds on Part 3, which exists only as its plan. The pre-flight checks each of these
against Part 3 as built:
1. `packages/stage/src/model.ts` and `scene.ts` are as Part 3's Task 13 prints them, plus Task 15's
   `frames` Map and `observe` case. Task 5's diff targets `sceneAt`'s `filter`, `cursorAt`'s
   forward loop, `ringsAt` and `cancelAt`.
2. `EventLog.toSessionT(sessionId, daemonMicros)` and `originOf`, as in Part 3's Task 5. Part 1's
   `#stateOf`, `readValid`, `#rebuildIndex` and `#updateIndex` are as on `feat/core-part2`.
3. `LiveSessions` (Part 3's Task 10 `live.ts`) has `start(cellId, sessionId, run)`, `get`, `cellOf`
   and `stop`. The puppet route calls `start` synchronously and answers 202.
4. `CellApi.endpoints(id).stream` is `{ baseUrl, authorization }`, and `StallWatchdog` has
   `{ pingEveryMs, stallAfterMs, ping, onChange }`, `start`, `touch`, `stop` and `lastAt`
   (Part 2's code).
5. `main.ts` has a SIGTERM/SIGINT shutdown path that closes the event log and releases the lock.
   If it has none, Task 10 adds one around `serve()`.
6. `createApp`'s options are as Part 3 extended them (`gateway`), and Part 1's
   `/api/sessions/:id/events` JSON route is unchanged.
7. `PixiPresenter.create(canvas, opts)`, `present`, `setScreen`, `setCamera`, `draw`, `render` and
   `extract(crop, layer, cam, scene)`; `videoPlacement` and its once-only warning; `Overlays`
   reading `dpr` for screen-constant sizes (Part 3's Tasks 14a and 14b).
8. `StageCanvas` and `Stage` are as Part 3's Task 14b prints them, and `useLiveSession`,
   `sessionHud`, `stepRows`, `StepRow`, `PlanRail` and `thumbnailUrl` as its Task 15 prints them.
   `ApiClient` has `token`, `authorization()` and `fetch`.
9. Part 2's `apps/web/e2e/daemon.ts` `startDaemon(env)` (Task 13 adds `{ home }`). Part 3's e2e
   helpers: `createReadyCell`, `runPuppet`, `waitForSessionEnd` and `frameBytes`.
10. The Theatre's CSP (`default-src 'self'`, `connect-src 'self'`, `img-src 'self' data: blob:`)
    allows module workers from `/assets`, `fetch` to the daemon, and blob URL images. mediabunny
    needs no `eval` and no blob workers (it uses none in 1.61.0).
11. Playwright 1.63's TypeScript loader resolves `@localdot/stage/testing` from the e2e specs
    through the workspace link.
12. Chrome 154 offers WebCodecs H.264 decode of 4:4:4 High (the live stage already depends on
    it), `showSaveFilePicker`, OPFS `createWritable` and positioned writes, and
    `VideoFrame.copyTo` for I420, NV12 and I444. `performance.memory` in a dedicated worker is
    optional: the 2-hour pin annotates when it is absent.
13. mediabunny 1.61.0's `CanvasSource`, `canEncodeVideo`, `Output.cancel()`,
    `UrlSource({ requestInit, maxCacheSize, parallelism, getRetryDelay })` and
    `VideoSampleSink.samples()` behave as documented in its typings (read while writing this plan).
14. Selkies' wire header and handshake are as the vendored client parses and sends them. S9
    (Task 1) confirms or amends both before Task 9.

## Self-review

**Spec → task map:**

| Spec requirement | Task |
|---|---|
| Criterion 4: "any session replays" | 10 (records with no viewer), 12 (index), 13 (backdrop when no video), 16 |
| …"with scrubbing" | 13 (decode policy, seek pins), 14 (scrubber) |
| …"a step timeline" | 5 (steps, marks), 6 (chapters, ticks), 14 (chapters, rail as of t) |
| …"and 'jump to live'" | 14 (pill, follow rule), 16 |
| …"and exports to MP4" | 15, 16 |
| M6: "Recorder (fMP4 via mediabunny)" | 7, 8, 9, 10, 11 |
| M6: "thumbnails" | 12 (observe thumbs), 14 (hover, rail) |
| M6: "session index" | 12, 14 (sessions rail) |
| M6: "replay UI" | 13, 14 |
| M6: "MP4 export" | 15 |
| "The daemon stamps … every incoming video chunk with its own monotonic clock" | 9 (`arrivalMicros`), 10 (`toSessionT`) |
| "Replay: … speeds up to 8×, skip idle, before/after compare, and jump to live" | 6, 13, 14 |
| "Replays are deterministic" | 5, 13 and 15 (determinism pins) |
| "Overlays exist only in the viewer" | 13 and 15 (rendered in the worker, never recorded in the cell) |
| "`~/.localdot/` holds … sessions (events, `observe` screenshots, video, thumbnails)" | 2 (layout), 12 |
| "End to end (Playwright): … replay scrubbing; MP4 export" | 13, 14, 15, 16 |
| "Repository: mediabunny (MPL-2.0)" | 3 |
| Error handling: a cell crashes (the stream drops) | 9 (backoff), 10 (`stream-lost` gap) |
| "Takeover … No screenshots reach the model during takeover" | 11 (none reach the recording either) |

**Placeholder scan:** no "TBD", "TODO" or "similar to Task N". Every test is named with its input
and its expected result, and every pin is printed in full. Tasks 1 and 9 depend on S9's answers,
but the defaults are given exactly (`RECORDER_HANDSHAKE`, the constants), and so are the
contained fallbacks.

**Consistency checks:**
- `RecordingManifest`, `FragmentEntry` and `RecordingGap` (Task 2) are used unchanged by
  Tasks 7–15.
- `MEDIA_TIMESCALE` is the single timescale.
- `FrameFeed` and `FeedHandlers` (Task 9) are used by `FakeFeed`, the session recorder and the
  service.
- `FrameGate` (Task 10) is implemented by `ControlGate` (Task 11).
- `ReplaySource`, `ReplayTransport` and `ReplayProbeCommand` (Task 13) are used by Tasks 14 and 15.
- `gapCard` and `speedLabel` (Task 14) are used by the export burn-in (Task 15).
- `suggestedExportName` (Task 14) is used by Task 15.
- Session time is ms everywhere in the stage, the page and export. It is µs in the recorder, the
  manifest and the media timeline, and every conversion goes through `microsToMs` and
  `msToMicros` (P3-C2).
