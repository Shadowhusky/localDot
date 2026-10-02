# Job: write the M6 "Replay" plan: Part 7

- **Output branch:** made from `origin/planning`, named `claude/plan-part7`. Commit:
  - `docs/superpowers/plans/2026-10-01-localdot-core-part7-replay.md`;
  - `reports/plan-part7-report.md` (task list, decisions, and especially where recording happens and why, what you verified and what you couldn't).
  Push it. Follow `jobs/PLAN-WRITING.md`.

## Scope
- **M6 = Replay:** "Recorder (fMP4 via mediabunny), thumbnails, session index, replay UI, MP4 export".
- **Success criterion 4:** any session replays with scrubbing, a step timeline and "jump to live", and exports. Read the whole criterion in the spec.
- **Plan M6 to execute right after Part 3 (M2) completes, independent of M3–M5.** Replay renders generically from the event log plus the recording. Agent and safety events that don't exist yet render through a typed fallback. Say exactly which protocol events you rely on.
- End with "Interfaces later milestones build on": M5's approval and takeover markers, M7's second screen, M8's what-changed flash.

## Inputs
- **The spec** (planning: `docs/superpowers/specs/…`). Read: "Intent", "Success criteria", "Architecture", "One click, end to end", "Action gateway and live view" (determinism, closed-form springs, the step timeline with thumbnails), "Interface" (Glance/Watch/Replay), "Setup and operations" (where sessions, recordings and thumbnails live), "Error handling", "Testing", "Repository" (mediabunny's MPL-2.0) and "Risks".
- **Research:** `visualization-ux.md`, `dot-openai.md`, `grokbot-xai.md`.
- **Part 3's plan** ("Interfaces Part 4 builds on": the event log format and storage, protocol events, the renderer and its closed-form springs, `LiveSessions`, the frame pipeline, session ids).
- **Part 2's plan,** with its ledger: the stage (`FrameSource`, `pumpFrames`, `WorkerIn`/`WorkerOut`, `StageCanvas`), session metadata, and the Theatre's Replay mode switch.
- **Code:** `origin/feat/core-part2`, which has the live stage as built.

## Decisions to make (`P7-R…`)
- **Where recording happens.** Options: in the browser (WebCodecs `VideoEncoder` over the frames the stage already decodes, then mediabunny's fMP4, then the daemon); in the daemon from the Selkies stream; or in the cell. Must sessions replay when nobody was watching? Read the spec closely.
- **Recording format and storage:** fragments, keyframe interval, an index from event-log time to media time, the disk layout under `~/.localdot/`, retention and size caps, and crash safety (a cut-off fragment must still replay).
- **Thumbnails** per step.
- **The session index.**
- **Deterministic overlays** from the log over the video.
- **Scrubbing:** seek to the nearest keyframe, then decode forward. Also speeds up to 8×, skip idle, before/after, and "jump to live".
- **MP4 export** with overlays burned in: performance, progress and the output location.
- **Privacy:** recordings show surrogates; say what is redacted, if anything, and why.

## Rules
- Pin mediabunny's version and record its MPL-2.0 handling. You may prove its muxing path in Node in a scratch copy. There's no Docker here.
- **Review Focus:** seek accuracy, a crash mid-recording, disk full, a 2-hour session's memory and CPU during scrub and export, overlay determinism across two renders, and the privacy of exported files. Each gets a pinning test.
- The branch is `feat/core-part7`, made from Part 3's tip.
