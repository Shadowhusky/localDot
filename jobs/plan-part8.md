# Job: write the Part 8 plan: M7 Signed-in browser

- **Output branch:** made from `origin/planning`, named `claude/plan-part8`. Commit:
  - `docs/superpowers/plans/2026-10-01-localdot-core-part8-signed-in-browser.md`;
  - `reports/plan-part8-report.md`.
  Push it. Follow `jobs/PLAN-WRITING.md` and `jobs/PROCESS.md`.
- **Format:** the **interface-and-test** format. Give complete code for the security boundary (cookie isolation, download quarantine, the browser cell's network and keyd path), and label each task's review tier.

## Scope
The M7 row:
- `browserd`;
- the second screen;
- `switch_screen`;
- takeover logins;
- download quarantine;
- the desktop's Chromium stops keeping cookies.

Read the spec's "Signed-in browser (M7)" in full, plus every line naming M7 or `browserd`.

## Inputs
- **The spec** and its research.
- **Part 2 as built:** cells, the orchestrator and the stream.
- **Part 3's plan:** the gateway, `LiveSessions` and the screens.
- **Part 4a's and Part 4b's plans:** per-cell listeners, the CA and egress roles.
- **Part 5a's plan** (`origin/claude/plan-part5a-providers`): the tool table and `switch_screen`.
- **Part 6's seams:** if `origin/claude/plan-part6` exists, read its takeover and approvals interfaces. Otherwise define the seam and record the assumption.
- **Part 7's plan** (`origin/claude/plan-part7`): a second screen in replay.

## Rules
- **Review Focus, each with a pinning test:**
  - cookies or session storage leaking from the signed-in browser to the desktop cell or the agent's prompts;
  - a malicious download reaching the desktop unquarantined;
  - the agent reading the takeover login's keystrokes or the password field;
  - `switch_screen` racing a takeover;
  - the browser cell reaching hosts its policy refuses.
- Part 8 runs after M5, on `feat/core-part8`.
- Where the spec is silent, decide, and record it as `P8-R…`.
