# Job: review the Part 5a plan (the M4 agent core, with first-class providers)

One review, then the controller applies its rulings in one fix pass (`jobs/PROCESS.md`).

- **Plan:** `docs/superpowers/plans/2026-10-01-localdot-core-part5a-agent-core.md` on `origin/claude/plan-part5a-providers` (head `54221ad`), plus that branch's amendment to Part 4a's plan (Tasks 13 and 14) and `…handoff/part4a-providers-amendment.md`.
- **Reports:** `reports/plan-part5a-report.md` on `origin/claude/plan-part5a`, and `reports/plan-part5a-providers-report.md` on the providers branch.
- **Output branch:** `claude/review-plan-part5a`, made from `origin/planning`. Commit `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part5a-review-1.md` and push it.

## Check
- **Spec coverage:** every M4 requirement in the spec ("The agent (brain cell)", "Providers and sign-in", "Action gateway and live view", "Key layer" → LLM gateway, "Testing") maps to a task, except what is Part 5b's (UI) or Part 5c's (Codex).
- **Correctness of the code in the plan:** assemble it in a scratch copy as the plan's own verification did, and run typecheck, Biome and Vitest.
- **Consistency** of types and names across tasks, and against Part 3's and Part 4b's closing interfaces and Part 2 as built.
- **Security:**
  - secrets never in prompts or cells;
  - every LLM call through keyd;
  - prompt injection reaching tool calls, and the M5 seam;
  - tools outside the v1 table;
  - runaway loops and budgets;
  - the new `store: false` and the unpriced-model refusal.
- **The 33 decisions:** is each sound, and is the cost-if-wrong honest?
- **Placeholders,** "similar to Task N", and code that cannot work.

## Output
Findings as Critical, Important and Minor, each with a location, the evidence and the smallest fix. End with a verdict: **READY**, or **FIXES_NEEDED** with the list. No re-review follows unless you find a Critical.
