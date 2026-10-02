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
