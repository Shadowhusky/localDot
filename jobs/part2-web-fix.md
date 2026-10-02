# Job: Part 2 web fix round (findings from the Task 12, 13 and 14 reviews)

- **Base:** `origin/feat/core-part2` at `b02765f`.
- **Code branch:** `git checkout -b claude/part2-web-fix b02765f`. Commit there and push it.
- **Report:** commit `reports/part2-web-fix-report.md` plus your screenshots `reports/part2-web-fix/*.png` as the LAST commit on `claude/part2-web-fix`, touching only `reports/`.

## Context
localDot's web UI, the Theatre (`apps/web`, React 19 + Vite), is served by the daemon (`apps/daemon`, Hono). Task 14 (`c879f59..b02765f`) added:
- the live stage, with the vendored Selkies client in a same-origin iframe;
- CSPs on the Theatre's `index.html` and the client page;
- a Permissions-Policy and a sandbox.
Read it first.

## Requirements
The ledger `sdd/2026-10-01-localdot-core-part2/progress.md` on planning. Apply EVERY item in these entries, in TDD:
- **"Task 12: Important 1":** only fix the false comment "history and bookmarks never keep the token". The residual is accepted and documented.
- **"Task 12: Important 2":** a WebSocket refusal → probe `GET /api/whoami` once → 401 → `onUnauthorized`.
- **"Task 12: Minors → the web fix round"** (1, 2, 4, 5). Minor 3, the CSP, is already done.
- **"Task 13: Minors → the web fix round"** (1–8).
- **"Task 13: out-of-scope evidence":**
  - "closed before it ever opened" covers both 403 and 404;
  - whoami 401 → `onUnauthorized`;
  - whoami 200 → re-list cells and adopt the result.
- **"Task 14: Important":**
  - the Theatre's `/` (`index.html`) gets `frame-ancestors 'none'`, while the client page keeps `'self'`;
  - pin it in `static-ui.test.ts`;
  - write the corrected audit row 10 (`server_settings` performs `window[key]` writes) into your report.
- **"Task 14: Minors → the web fix round"** (1–5).
- **"CARRY → Task 15: /favicon.ico"** (do it here, CSP-compatible) and **"CARRY → final review (UX nit)"** (the "Offline" lamp → stream wording).

## Rules
- TDD with RED evidence for each behaviour change. Tests use the daemon's REAL error bodies.
- Keep the CSPs intact: no inline script or style, and `connect-src 'self'`.
- **UI:**
  - apple-design: quiet, precise, system type;
  - CSS tokens only;
  - no xenon `#3FB5DE` in Part 2;
  - no purple, gradients or emoji;
  - reduced motion and reduced transparency honoured;
  - text contrast ≥ 4.5:1.
- **Screenshots:** Docker isn't here, so take them with Playwright Chromium against a stubbed daemon API (route interception, or a small fake server). Cover the HUD states Listing, Starting, Failed (with a real daemon error body), Live (the stage may stay blank) and Stopped, plus a ~1000 px wide window. Look at each PNG, and describe it in the report.
- Verify with `pnpm format && pnpm lint`, typecheck, `pnpm hygiene`, `pnpm test` and the web build. Real-cell checks are deferred to Task 15, which runs locally, so list them as unverified.
