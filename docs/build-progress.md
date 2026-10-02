# App completion progress

Core branch: `feat/codex-complete`; credential integration: `codex/keyd-integration`. Source handoff: `origin/planning:jobs/HANDOFF-CODEX.md`. The controller is building locally with Docker; cloud-only environment restrictions do not describe this Mac. No remote branches have been pushed by this continuation.

## Verified

- M1 live desktop, restart/recovery, authentication and narrow layout. Real browser acceptance passes. Both chroma modes maintain 61–62 delivered frames per second on the development Mac; see `measurements/2026-10-stream-2x.md`.
- M2 protocol timing and deterministic pointer math (commit `368c61f`).
- M2 compositing at both scales: zero torn frames; see `measurements/2026-10-compositor.md`.
- M2 XTest input, raw XI2 timestamps, window activation, Unicode typing, DAMAGE settle detection and Chromium launcher: eight real Docker checks pass.
- Input cancellation, activation refusal, body limits and encoded launcher-path refusal were pinned against failing implementations before fixes. The desktop service stops paced typing on response cancellation.
- M2 perception: real terminal and Calc geometry/actions pass; Chromium elements match their pixels within 1 px maximized and restored. Password focus reached by Tab is identified even with the pointer over a non-secret button.
- M2 action gateway, clock mapping, event/frame storage and multi-app puppet are implemented. Regressions pin secret labels, unknown focus, Stop during target lookup, viewer backpressure, bounded Docker calls and startup while Docker is unresponsive.
- The two-viewer desktop check passes: the second viewer continues at 14.6–16.4 fps while the first is suspended, and the first recovers after resuming. Shared viewers do not replace the controller.
- Part 4a's credential service is implemented through Task 17, including final rotation and inspection corrections. All 13 Go packages pass the race detector. See `measurements/2026-10-keyd-final.md` and the preceding keyd measurements.
- The integrated desktop and keyd checkout passes 622 host checks in 83 files, all 13 Go packages, workspace type checks, lint and hygiene. This establishes the integration base, before Part 4b wiring.

## In progress

M2: the worker overlays, live timeline, pixel oracle and production-path calibration are built; real-browser acceptance is being completed. The first browser run exposed compiled hex-alpha colours and Pixi CSP compatibility, both fixed before visual acceptance. Calibration measurements must use the finished production rendering path and include at least 500 trials per required group.

M3: Part 4b Tasks 1–8 are complete, through the boot self-test and readiness gate. The current integration branch passes 760 host tests in 95 files. Six real-service client/route tests, two real Docker API tests, five certificate/proxy image checks and the nineteen existing desktop image checks have passed. The proxy and boot-probe bundles also pass smoke checks under Node 24.21.0 in the actual desktop image. Next are orchestration, Stop/resume and the Theatre key form. Its real-cell canary and recovery acceptance remain open. The host Keychain backend and Stop latency during a stalled Keychain operation also need integration verification. Detailed evidence is in `measurements/2026-10-keyd-integration.md`.

The independent avatar harness is available on the user's private Tailscale network with Spine rendering, local typed speech and mouth tracks verified. Microphone mode remains experimental; the agent conversation is not connected. The remaining avatar Part 3 tasks and final app integration are still required.

## Remaining scope

M3 keyd integration and cell isolation; M4 agent loop, first-class providers, Theatre chat and ChatGPT/Codex harness; M5 safety, approvals and takeover; M6 replay; M7 signed-in browser and download quarantine; M9 shipping/onboarding/update/doctor; M8 premium polish, avatar/voice integration and additional providers. The handoff's interrupted keyd fixes and later plan reviews remain obligations. M9 precedes M8.

Representative screenshots are delivered to Richard’s private Telegram through OpenClaw. M1 was delivered as Telegram message 12057, M2 previews as 12058/12059, the playable avatar preview as 12062 and its private Tailscale URL as 12063 (2026-10-02). Test artifacts remain local and ignored. Completion is not yet claimed.
