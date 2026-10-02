# Job: write the M4 "Agent" plan, first half: Part 5a, the agent core

- **Output branch:** made from `origin/planning`, named `claude/plan-part5a`. Commit:
  - `docs/superpowers/plans/2026-10-01-localdot-core-part5a-agent-core.md`;
  - `reports/plan-part5a-report.md` (task list, decisions, what you verified and what you couldn't, assumptions on unbuilt code).
  Push it. Follow `jobs/PLAN-WRITING.md`.

## Scope
The spec's Milestones row M4 reads: "Brain image and loop; provider registry and picker for every API-key provider and local server, with the models.dev catalog; Anthropic's native computer tool and the generic `computer` tool; all v1 tools; chat, plan and step timeline; terminal and diff panels; memory files; skills loader; a first real multi-app task succeeds."

M4 is split in two:
- **Part 5a (yours):**
  - the brain cell image and agent loop;
  - the provider registry and models.dev catalog, with a cache under a fixed schema (tests use a fixture);
  - provider calls through keyd's LLM gateway (every LLM call goes through keyd; secrets never in prompts);
  - Anthropic's native computer tool and the generic `computer` tool, wired to Part 3's action gateway;
  - ALL v1 tools in the brain (the spec's tool table);
  - memory files and the skills loader;
  - the daemon-side session runner that starts and stops a brain for a session, and its tool API on port 4751.
- **Part 5b (not yours):** the chat, plan and step timeline UI, the terminal and diff panels, the provider picker UI, and the first real multi-app task end to end.

End with an "Interfaces Part 5b builds on" section: every event, API route and type the UI will consume, exactly.

## Inputs (on planning unless noted)
- **The spec,** `docs/superpowers/specs/2026-09-30-localdot-core-design.md`. Read in full: "The agent (brain cell)", "Providers and sign-in", "Action gateway and live view", "Key layer (keyd)" (the LLM gateway), "Safety and control" (M5 implements it; leave seams), "Testing", "Repository", "Milestones".
- **Research,** in `docs/superpowers/research/2026-09-30-localdot/`.
- **S5 and A1–A34** (computer use is verified for Gemini and Qwen; Anthropic and OpenAI are unverified because their keys are out of credit): `git show origin/main:spikes/s5-models/FINDINGS.md` and `git show origin/main:docs/spikes/SUMMARY.md`.
- **Neighbour plans' closing interface sections:**
  - Part 3 (`…part3.md`, "Interfaces Part 4 builds on": `ActionGateway.run`, `GuiAction`, `LiveSessions`, the puppet, desktopd's API, protocol events);
  - Part 4a (`…part4a-keyd-core.md`: the LLM gateway, budgets, `[surrogate:<ID>]`);
  - Part 4b (`…part4b-keyd-integration.md`);
  - Part 2 (`…part2.md`), with its as-built deviations in `sdd/2026-10-01-localdot-core-part2/progress.md`.
- **Code:** `origin/main` (Part 1) and `origin/feat/core-part2` (Part 2 as built).

## Rules
- Part 5a runs after Parts 3 and 4b, from their integration, on branch `feat/core-part5a`.
- **Providers:** plan the Anthropic and OpenAI computer-use verification as opt-in tests that skip without credit. Gemini and Qwen (local) are the verified paths. The ChatGPT/Codex harness belongs to M8, not here.
- **Review Focus must include, each with a pinning test:**
  - prompt injection from web pages reaching tool calls, and how the spec's risk rules and approvals hook in (leave the M5 seam);
  - model output calling a tool outside the v1 table;
  - runaway loops and budget exhaustion through keyd;
  - secrets never in prompts.
- Where the spec is silent, decide, and record it as `P5a-R…`.
