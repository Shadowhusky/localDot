# Job: review the Part 5c plan (the Codex harness for ChatGPT plans, M4)

One review, then the controller applies its rulings in one fix pass (`jobs/PROCESS.md`).

- **Plan:** `docs/superpowers/plans/2026-10-01-localdot-core-part5c-codex-harness.md` on `origin/claude/plan-part5c` (head `97e4797`). Its report is `reports/plan-part5c-report.md`.
- **Output branch:** `claude/review-plan-part5c`, made from `origin/planning`. Commit `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part5c-review-1.md` and push it.
- **Format:** mixed, by design:
  - the security boundary (srt profile, env scrub, approval filter, MCP endpoint and its auth, binary pin, flags, Stop, launcher) is complete code at tier `full`;
  - the rest is interface-and-test at tier `light`.

## Check
- **Spec coverage:** trust rule 7, the components table row, "Subscription sign-in" → "ChatGPT plan" (every bullet), `harness/codex/`, and the threat-model lines.
- **Consistency with Part 5a as it now stands:** 5c was written against `origin/claude/plan-part5a`, but the current 5a is `origin/claude/plan-part5a-providers` (first-class providers, `store: false`, unpriced-model refusal, P5a-R31–R33). List every place 5c's Task 12 (registry and settings), its tool API usage and its events must change.
- **The sandbox:** for each finding the plan measured (connectors and plugins via chatgpt.com, sub-agents that can't be disabled in 0.154, no re-read of `auth.json`), is the mitigation complete?
  - Rate the residual risks the report names: srt writing `/tmp/claude`, and the sign-in process reaching every loopback port. Propose the smallest fix.
- **The MCP endpoint over a Unix socket via `nc -U`:**
  - auth;
  - which peers can reach it;
  - what happens if `nc` is replaced or missing.
- **The Codex pin (0.154.0 vs 0.160.0's schema changes):** is the upgrade check enforceable?
- **Install size:** `@openai/codex` adds about 117 MB. Assess installing it on demand when the user picks "ChatGPT plan", including integrity checks of that download.
- **Running the code:** run the plan's runnable tests in a scratch copy, and run Codex 0.154.0 offline against a local stand-in, as the plan does. Never sign in or call OpenAI.

## Output
Findings as Critical, Important and Minor, each with a location, the evidence and the smallest fix. End with a verdict: **READY** or **FIXES_NEEDED**.
