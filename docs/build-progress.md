# App completion progress

Branch: `feat/codex-complete`. Source handoff: `origin/planning:jobs/HANDOFF-CODEX.md`. The controller is building locally with Docker; cloud-only environment restrictions do not describe this Mac. No remote branches have been pushed by this continuation.

## Verified

- M1 live desktop, restart/recovery, authentication and narrow layout. Real browser acceptance passes. Both chroma modes maintain 61–62 delivered frames per second on the development Mac; see `measurements/2026-10-stream-2x.md`.
- M2 protocol timing and deterministic pointer math (commit `368c61f`).
- M2 compositing at both scales: zero torn frames; see `measurements/2026-10-compositor.md`.
- M2 XTest input, raw XI2 timestamps, window activation, Unicode typing, DAMAGE settle detection and Chromium launcher: eight real Docker checks pass.
- Input cancellation, activation refusal, body limits and encoded launcher-path refusal were pinned against failing implementations before fixes. The desktop service stops paced typing on response cancellation.
- M2 perception: real terminal and Calc geometry/actions pass; Chromium elements match their pixels within 1 px maximized and restored. Password focus reached by Tab is identified even with the pointer over a non-secret button.
- M2 action gateway, clock mapping, event/frame storage and multi-app puppet are implemented. Regressions pin secret labels, unknown focus, Stop during target lookup, viewer backpressure, bounded Docker calls and startup while Docker is unresponsive.
- Latest full host unit run: 619 checks in 83 files pass; workspace type checks pass. Renderer acceptance and calibration are still in progress.

## In progress

M2: the worker overlays, live timeline, pixel oracle and production-path calibration are built; real-browser acceptance is being completed. The first browser run exposed compiled hex-alpha colours and Pixi CSP compatibility, both fixed before visual acceptance. Calibration measurements must use the finished production rendering path and include at least 500 trials per required group.

## Remaining scope

M3 keyd integration and cell isolation; M4 agent loop, first-class providers, Theatre chat and ChatGPT/Codex harness; M5 safety, approvals and takeover; M6 replay; M7 signed-in browser and download quarantine; M9 shipping/onboarding/update/doctor; M8 premium polish, avatar/voice integration and additional providers. The handoff's interrupted keyd fixes and later plan reviews remain obligations. M9 precedes M8.

Representative screenshots are delivered to Richard’s private Telegram through OpenClaw. M1 was delivered as Telegram message 12057 (2026-10-02). Test artifacts remain local and ignored. Completion is not yet claimed.
