# Reusing learned workflows

localDot keeps user facts and learned procedures separate. USER.md and MEMORY.md retain their
existing write restrictions. A procedure learned while reading files, screens or command output
is an **untrusted observation**, not a user instruction or an authorization grant.

## What is implemented

- `done.experience` lets the agent save a concise scope, applicability conditions, successful
  procedure and cheap recheck in its existing completion call. No extra model call is required.
- The daemon requires a successful shell or file tool receipt in the current task and records
  that receipt's event ID. This proves that work occurred; it does not independently prove every
  claim in the agent's lesson. The next task is instructed to verify applicability and outcome.
- If the agent omits a lesson after nontrivial background work, the daemon records a compact
  observed route after `task.result`: at least one failure and one success, or three successes.
  Only redacted command/file titles are retained, not raw output or screenshots.
- Automatic learning respects the task's memory allowance. It does not turn an ask or handoff
  policy into permission to write memory.
- Procedures are ordinary editable entries in **What dot knows → Daily notes**, with source task
  and date. Identical entries are deduplicated; a changed procedure with the same scope and
  conditions replaces the previous entry through the existing change journal. Deletion prevents
  retrieval, including after restart. Existing edit, history and undo behavior is retained.
- New API-model, Codex and Claude Code tasks load up to three matching procedures. Scheduled
  tasks use the same startup path. Matching requires words in the scope, not generic procedure
  words alone. Retrieval examines the latest 90 note files and shares the existing 20,000-character
  memory budget. Older notes remain searchable with `recall`.

The system does not execute saved commands automatically. Current instructions, permissions,
repository rules, environment checks and fresh verification remain necessary. Credentials and
key-shaped values are excluded; the model is also instructed not to retain personal account data.

## Research behind the design

[Anthropic's long-running agent harness work](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
uses persistent progress artifacts and startup checks to make work continuous across context
boundaries. [LangMem's conceptual guide](https://github.com/langchain-ai/langmem/blob/main/docs/docs/concepts/conceptual_guide.md)
distinguishes semantic facts, episodic evidence and procedural knowledge. That separation matters
here: a command succeeding in one environment is not a universal rule.

[LifeMem](https://arxiv.org/abs/2609.12655) studies extracting and retrieving reusable workflows
from past trajectories. [Managing Procedural Memory in LLM Agents](https://arxiv.org/abs/2606.23127)
evaluates transfer across tasks, roles and models, including cases where specialized procedures
transfer poorly. These findings motivate scoped applicability, provenance, consolidation and
rechecking. This implementation does not claim to reproduce either paper's full system or results.

## Experiments and limits

`apps/daemon/src/agent/experience.test.ts` runs a disk-backed two-task experiment: one task learns
a setup failure and successful recovery; a newly constructed memory store retrieves the procedure
for both a later repair request and a scheduled-task-shaped request. An unrelated project does not
receive it. Further checks cover correction, deduplication, deletion, memory permissions, secret
rejection and the context limit.

These are deterministic integration experiments, not a live-model quality benchmark. Retrieval is
lexical; aliases and semantically similar requests without shared scope words can be missed.
The fallback preserves observed steps, not a causal explanation. A model-written lesson is more
useful when it identifies the actual prerequisite or trap. Future quality evaluation should measure
successful second runs, avoided failed commands, stale-environment recovery and irrelevant recall
across multiple repositories, services and model providers before adding broader semantic retrieval.
