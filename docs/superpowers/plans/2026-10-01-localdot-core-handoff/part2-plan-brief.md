# Brief: write Part 2 of the localDot core implementation plan — "Live desktop" (milestone M1 remainder)

You are writing an implementation plan, not code. localDot is an open-source, localhost-first personal assistant: an agent works inside isolated Docker "cells" (a Linux desktop it operates, a brain cell, gates), the desktop is streamed into a web UI with truthful action visualization, and every real secret stays in a host-side key daemon (keyd). Part 1 (spikes S1–S7 + the TypeScript foundation) is finished on branch `feat/core-part1` of `/Volumes/Husky's SSD 4T/Projects/localdot`. Part 2 finishes milestone M1: the desktop and gate images, internal networks and cell orchestration, and the live desktop appearing in the UI. Part 3 (written separately, after this) is M2 "visual core": desktopd's observe/hitTest/input/type/settle, the action gateway with the timing contract, P0 overlays driven by a scripted puppet, and pixel-oracle tests.

## Read first
1. The plan-writing method you must follow exactly (header, Global Constraints, Review Focus, task structure, no placeholders, self-review): `/Users/richardliao/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/writing-plans/SKILL.md`. Ignore its "Execution Handoff" section (the controller handles that).
2. The spec (the authority; just amended with the spike results): `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-core-design.md`.
3. Spike decisions and evidence: `localdot/docs/spikes/SUMMARY.md` (D1–D18; the amendments are already in the spec) and the spike folders it cites (`localdot/spikes/s1-stream`, `s2-perception`, `s3-network`, `s6-timing` hold working Dockerfiles, run scripts, the frame tap and probes you should build on).
4. Carry-forward inputs: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-09-30-localdot-core-part1-carry-forward.md`.
5. Part 1's plan, for format and its Global Constraints: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-09-30-localdot-core-part1.md` (skim; do not copy its spike tasks).
6. The code that exists (read it; Part 2 must use these exact interfaces): `localdot/packages/protocol`, `packages/providers`, `packages/stage`, `apps/daemon`, root configs, `scripts/check-hygiene.mjs`, README.
7. UI direction (decided: C: Theatre): `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/design/2026-09-30-localdot-ui-directions/README.md` (its "Decision" section and the C mockup files in that folder), and the apple-design skill `~/.agents/skills/apple-design/SKILL.md`.

## Scope of Part 2
- `cells/desktop`: the desktop image (pinned base by digest, HiDPI XFCE at 2× with 1× switchable, Selkies settings incl. cursors off, pinned DPI and stream auth, Cua Driver pinned with telemetry/update opt-outs baked in as ENV, the app set, one session D-Bus with AT-SPI, a desktopd skeleton that serves an authenticated health endpoint), plus image-level tests.
- `cells/gate`: the forwarder image (socat relays: the keyd relay bound only to the gate's internal-network address; inbound relays reachable only through ports published on 127.0.0.1).
- Cell orchestration in `apps/daemon`: talk to Docker (decide the client per the spec), create one internal network per cell with `--internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`, start gate + desktop with dropped capabilities and named volumes only, generate per-cell tokens (inbound ports require them — 127.0.0.1 is not access control on Docker Desktop), allocate ports, stop and clean up, and `doctor` checks for the Docker prerequisites (isolated gateway mode supported).
- Daemon API for cells and the stream proxy (the UI talks only to the daemon with its install token; the daemon holds the per-cell tokens).
- `apps/web` (React): token bootstrap (`#token=` → origin-scoped storage → `history.replaceState`), WebSocket client offering `localdot.v1` + `localdot.token.<t>`, the C: Theatre shell (void surround, lit stage, HUD on the picture, caption, quiet rails, mascot slot) built with CSS tokens per apple-design.
- The live stream in the stage: Selkies' client hosted in localDot's page (untested — make the first stream task prove it early, with a fallback named in the plan), the MediaStreamTrackProcessor tap → render worker → stage canvas, upload once per new frame, connection-level stall detection.
- End-to-end acceptance: start a cell from the UI, see the live 2× desktop in the stage, screenshot-verified; measure fps and CPU at 2×.
- Fold in the carry-forward items that belong to these areas (e.g. Node 24 CI run, single-writer lock already done, observe images as files is Part 3).

## Constraints for the plan
- Global Constraints must be updated from Part 1: ports 4750 (daemon/UI), 4751 (brain tool API), 4760–4789 (keyd listeners), spikes 4790–4799, all bound to 127.0.0.1; cookie-free auth; never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container (named volumes, `docker cp`, build contexts only); runtime data under `~/.localdot` (`LOCALDOT_HOME`); branch `feat/core-part2` from `feat/core-part1`; conventional commits with no AI attribution; no private theme names in the repo; secrets never in containers; UI tasks follow apple-design and end with a screenshot check; run only the affected test suites per task, the full suite before the final review.
- Tests that need Docker run behind an explicit opt-in env var and are excluded from default `pnpm test`.
- Every number and pinned version comes from the spec, SUMMARY or the repo; where something is unverified (e.g. hosting Selkies' client in our page), the plan says so and puts the proof first.
- Task right-sizing per the skill; complete code in steps; exact file paths; exact commands with expected output.
- Do not edit the spec, SUMMARY or any repo file. Do not run containers or install packages; reading files and `docker image ls`-style read-only checks are fine.
- You do not dispatch subagents.

## Output
Write the plan to `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-10-01-localdot-core-part2.md`. Then reply with ONLY: status, the task list (one line each), the Review Focus lines, and every assumption or open question the controller must rule on (under 40 lines).

## Facts the controller adds
- Code state: `feat/core-part1` at `992e82d` (final review fixes landed: `apps/daemon/src/lock.ts` single-writer lock taken before the EventLog opens; `port.ts` parses `LOCALDOT_PORT`; unknown sessions → 404 / refused upgrade; `events.jsonl` 0600). 143 tests pass. Read files at that commit; a read-only re-review is running in the same checkout, so do not change anything there.
- Host: macOS on Apple silicon (arm64), Docker Desktop with Engine 29.x; images are arm64 first. The linuxserver `webtop:ubuntu-xfce` image is already pulled locally (36 h old) — pin it by digest in the plan via an explicit resolve step (`docker image inspect --format '{{index .RepoDigests 0}}' lscr.io/linuxserver/webtop:ubuntu-xfce`) whose output the implementer writes into the Dockerfile.
- Success criterion 3's ring wording is pending the user's sign-off; it does not affect Part 2 (the ring is Part 3).
- UI direction files: `docs/superpowers/design/2026-09-30-localdot-ui-directions/c-theatre.html` and `c-theatre.png` (plus `stage.png`); the README's "Decision" section is binding.
- Part 3 will be written right after Part 2 from your plan's interfaces, so end Part 2 with a short "Interfaces Part 3 builds on" section (exact module paths, exported names and types: cell handle, desktopd base URL + token access, stream/frame source in the web app, stage canvas mount).
