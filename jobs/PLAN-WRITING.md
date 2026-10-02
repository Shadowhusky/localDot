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
  - **Review tier:** `full` or `light`, chosen by the rule in `jobs/PROCESS.md`, with a one-line reason;
  - bite-sized steps: write the failing test, run it (with the expected failure), implement, run it (expected pass), commit (with the exact `git` commands and a conventional message).
  - **How much code:** this depends on the milestone (see "Plan format by milestone" below). Either way: no placeholders, no "TBD", no "similar to Task N", and no "add error handling" without saying exactly which errors and what happens.

## Plan format by milestone (user ruling 2026-10-02)
Plans that contain the complete code end up writing it twice, once in the plan and once in the build. So:
- **M1–M4 (Parts 2, 3, 4a, 4b, 5a and 5b):** keep the complete-code format above. Those plans are written or in progress.
- **M5–M9 (Part 6 onward, including Part 7, Replay):** write an interface-and-test plan instead. Each task gives:
  - **Files and Interfaces** as above, with exact signatures, types, protocol events, API routes and on-disk formats (these stay complete and exact, because later parts build on them);
  - **Tests:** every test named, with its input, its expected result and the file it lives in. Every Review Focus pin and every security test gets its complete test code;
  - **Implementation notes:** the algorithm, the edge cases, exact constants and values, and the traps (what is easy to get wrong and how the test catches it). Don't write the production code: the implementer writes it once, from the interfaces and the tests;
  - **Complete production code only where an exact value is the point:** the security boundary (keyd, the cell network, auth and tokens, secrets, sandboxing, approvals and the kill switch, download quarantine), protocol and schema types, and closed-form math;
  - **Acceptance:** the exact commands that prove the task is done.
- Expect an M5–M9 plan to be roughly a third the length of a complete-code plan.
- **Plan review:** one review, then one fix pass. Re-review only if the review found a Critical, and then only the changed sections.
- **"Decisions taken by this plan"** (`P<n>-R1…`): each with why, and what it costs if wrong.
- **Closing interfaces:** the exact interfaces later plans build on.
- **Self-review before finishing:**
  - every spec requirement maps to a task;
  - a placeholder scan;
  - type and name consistency across tasks.
- **Verify what you can:** compile and test the self-contained code in a scratch copy, with the pinned toolchain. List every assumption on code that isn't built yet, for the pre-flight later.
