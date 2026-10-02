# How to write a localDot implementation plan (all plan jobs)

Follow the shape of the existing plans in `docs/superpowers/plans/` (read Part 3's opening and one task).
- **Header:**
  - `# <Name> Implementation Plan`;
  - an agentic-workers note: "Use superpowers:subagent-driven-development … checkbox (`- [ ]`) steps";
  - Goal, Architecture, Tech Stack, Spec path.
- **Global Constraints:** the binding project-wide rules, one line each, with exact values. Copy them from the Part 2/3/4b plans:
  - no AI attribution;
  - never bind-mount `/Volumes/Husky's SSD 4T` paths into containers;
  - ports 4750+;
  - cookie-free auth;
  - Docker tests use `localdot-test-*` names and `rm -fv`, with no `--` after `pnpm test:docker`; probes assert their exit status; no server on a test's own thread;
  - secrets never in a cell; every LLM call goes through keyd;
  - the hygiene rules;
  - the pinned toolchain;
  - the UI rules (apple-design, the Theatre direction, tokens, no purple, gradients or emoji, xenon only while the agent has control).
- **Review Focus:** the five inputs or failure modes most likely to bite a user that no task's tests exercise. Each gets a pinning test added to the task that owns it.
- **File structure:** each file with one responsibility, then right-sized tasks. Each task has:
  - **Files** (create, modify, test);
  - **Interfaces** (consumes and produces, with exact signatures);
  - bite-sized steps: write the failing test, run it (with the expected failure), implement, run it (expected pass), commit (with the exact `git` commands and a conventional message).
  - Every code step contains the complete code. No placeholders, no "TBD", no "similar to Task N", no "add error handling" without the code.
- **"Decisions taken by this plan"** (`P<n>-R1…`): each with why, and what it costs if wrong.
- **Closing interfaces:** the exact interfaces later plans build on.
- **Self-review before finishing:**
  - every spec requirement maps to a task;
  - a placeholder scan;
  - type and name consistency across tasks.
- **Verify what you can:** compile and test the self-contained code in a scratch copy, with the pinned toolchain. List every assumption on code that isn't built yet, for the pre-flight later.
