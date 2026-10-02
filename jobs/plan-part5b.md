# Job: write the Part 5b plan: the agent UI (M4, second half)

- **Output branch:** made from `origin/planning`, named `claude/plan-part5b`. Commit:
  - `docs/superpowers/plans/2026-10-01-localdot-core-part5b-agent-ui.md`;
  - `reports/plan-part5b-report.md`.
  Push it. Follow `jobs/PLAN-WRITING.md` and `jobs/PROCESS.md`. M4 keeps the complete-code format, and every task gets a review tier: UI is `light`; key entry and anything touching tokens or secrets is `full`.

## Scope
The M4 row's UI half:
- the chat, plan and step timeline;
- the terminal and diff panels;
- the provider and model picker, for every provider:
  - the first-class ones;
  - the OpenAI-compatible ones;
  - local servers;
  - "ChatGPT plan" (Part 5c's sign-in flow);
  - a typed price for unpriced models (P5a-R32);
  - roles main, fast and local;
- key entry through keyd's sealed intake;
- the first real multi-app task succeeding end to end. It runs locally with Docker and a real key, so plan it as a Task-15-style acceptance task.

## Inputs
- **Part 5a's closing interfaces:** `git show origin/claude/plan-part5a-providers:docs/superpowers/plans/2026-10-01-localdot-core-part5a-agent-core.md`, "Interfaces Part 5b builds on".
- **Part 5c:** if `origin/claude/plan-part5c` exists, use its closing interfaces for the ChatGPT entry. Otherwise define the seam and record the assumption.
- **The spec:** "Interface", "Providers and sign-in", "The agent (brain cell)", and the UI rules.
- **Design:** `docs/superpowers/design/2026-09-30-localdot-ui-directions/` (the Theatre, `c-theatre.html`).
- **Part 2 as built:** `origin/feat/core-part2` and `origin/claude/part2-web-fix` (the Theatre shell and HUD), with its ledger.
- **Part 3's plan:** its closing interfaces (the step timeline and protocol events).
- **Part 4b's plan:** `origin/claude/plan-part4b-fix2` (`useKeys` and the key form).

## Rules
- The UI rules in the Global Constraints:
  - apple-design;
  - tokens only;
  - no purple, gradients or emoji;
  - xenon only while the agent has control;
  - reduced motion and reduced transparency;
  - contrast ≥ 4.5:1;
  - CSPs intact.
- **Review Focus, each with a pinning test:**
  - a key typed into chat by mistake (it is never sent to a model, and it is offered to keyd);
  - a long transcript's performance;
  - markdown or HTML from the model rendering (no script, no remote images);
  - a diff of a huge or binary file;
  - the terminal panel and ANSI escapes.
- Part 5b runs after Part 5a, on `feat/core-part5b`.
