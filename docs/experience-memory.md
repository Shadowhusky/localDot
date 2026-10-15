# Learning from sessions

localDot learns reusable methods across browser tasks, desktop apps, research, documents,
communication and coding. Project setup is one example, not a special learning path. Durable
learning means changing the context available to later runs; it does not train model weights.

## How the loop works

1. **Observe.** A bounded, in-process trace watches executed tool/action receipts across tool
   types. It holds kinds, outcomes and evidence IDs—not passwords, screenshots or command output.
2. **Distill.** In its existing `done` call, the agent reflects on a useful method, correction or
   failure recovery. A lesson has a stable scope, applicability, procedure, observed outcome,
   short alternate recall phrases and a cheap recheck. `experience: null` means there was nothing
   durable to learn. It is valid to remember a failed approach as failed.
3. **Finish normally.** The tool schema shown to current models requires a lesson or explicit
   null in that same completion call. The daemon still accepts older clients that omit it.
   Learning never requests another turn or holds completion open at an action/credit limit.
   There is no separate reflection service, hidden provider call, or automatic promotion of raw
   step titles to skills.
4. **Store.** Memory permission must already allow the write. Successful/limited lessons require
   an actual successful receipt; failed lessons require a failed receipt. A receipt proves that
   an action ran, **not** that every claim in the lesson is true. Blocked or cancelled actions
   and memory retrieval itself cannot supply evidence. Secret-shaped values are rejected and
   known secrets are redacted at the tool boundary. Instructions forbid retaining account data,
   external instructions, unverified claims or credentials.
5. **Retrieve and verify.** A new conversation or routine receives a small selection. During
   work, `recall` can fetch complete relevant lessons and saved facts alongside history snippets.
   The agent must check current applicability and outcome rather than blindly repeat a procedure.

All API-model, Claude Code and Codex runs use the same daemon storage and tool path. DeepSeek
Harness drives API-model orchestration; localDot still owns durable context, memory selection
and compaction. DSH's compaction summarizes only subagents' own histories, never that state.

## Selection and token cost

- The **combined** startup budget for USER.md, MEMORY.md and retrieved lessons is at most
  2,400 estimated tokens. For API models it is also capped at 4% of the configured main context
  window. Subscription drivers use the 2,400 ceiling. This is a conservative local text estimate,
  not the provider's tokenizer; it charges non-ASCII text by UTF-8 bytes rather than chars/3.
- Up to three whole lessons fit within 900 estimated tokens (less for small contexts). Facts
  retain pinned-first ordering and use the remaining budget. Entries are not cut mid-procedure.
  A large legacy unstructured book can be clipped; all saved facts remain available to recall.
- Retrieval uses Unicode word segmentation, scope matching, model-authored alternate phrases,
  inverse document frequency, applicability-word overlap and recency tie-breaking. Alternate
  phrases can bridge wording and languages without running an embedding service. Cues help
  selection but are not repeated in the model's context.
- Only one variant of an identical normalized scope is injected at a time. The most relevant
  conditions win; this is not an automatic semantic conflict resolver. Lessons are candidates,
  not a guarantee that their conditions match the current environment.
- All daily notes are eligible, including those outside the previous 90-file cutoff. Observations
  older than 90 days get a revalidation label rather than being silently forgotten. On-demand
  recall has a separate 1,200 estimated-token budget for complete facts and lessons.

## Corrections, ownership and deletion

Lessons appear in **What dot knows → Daily notes**, with date, source task and evidence ID.
Matching scope and applicability consolidate an agent's correction into the existing entry.
A repeated lesson on a later day refreshes its evidence/date; identical same-day writes do not
create duplicates. Newly user-edited lessons carry an edit marker, preserve source attribution
and resist automatic replacement. Older edits made before that marker existed cannot reliably
be distinguished from agent text. Different conditions coexist; a newer date alone does not
invalidate an older method.

Existing edit, history and undo behavior remains. Deletion removes a lesson from retrieval
immediately and after restart. Memory stays in private local Markdown files; credentials stay
in the separate vault. Permissions, repository rules and current user instructions remain
independent of learned observations. A lesson never grants permission to act.

## Why this approach

[Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
argues for small, useful context, structured notes and retrieving details when needed.
[LangChain's session-learning guidance](https://www.langchain.com/blog/how-to-give-your-agent-memory)
distinguishes traces from lessons and stresses closing the loop from observations to future
context. [Managing Procedural Memory in LLM Agents](https://arxiv.org/abs/2606.23127) evaluates
transfer across tasks, roles and models and finds that specialization can limit transfer.
[LifeMem](https://arxiv.org/abs/2609.12655), published in September 2026, studies extracting and
consolidating reusable workflows across environments. [PRAXIS](https://arxiv.org/abs/2511.22074)
studies retrieval using the current environment and task state. These support treating
applicability and observed outcomes as part of a lesson rather than replaying action sequences.

Those principles fit localDot's varied tasks, provider switching, local storage and token budget.
We use the existing agent's judgment to distill lessons and author retrieval cues, then keep
storage and retrieval deterministic. We have **not** established a state-of-the-art benchmark
score, implemented those papers' complete systems, or assumed that installing a harness provides
learning automatically. Embeddings or a second model for reranking may help as memory grows;
adding their runtime, privacy and latency costs needs evidence from real usage.

## Reproducible checks and remaining limits

```sh
pnpm exec vitest run apps/daemon/src/agent/experience.test.ts \
  apps/daemon/src/agent/tools/experience.test.ts \
  apps/daemon/src/agent/experience-retrieval.test.ts --disableConsoleIntercept
```

The hand-authored retrieval corpus has nine lessons and 22 queries spanning authentication,
QR interaction, spreadsheets, research, document layout, scheduling, email, coding and archives,
including Chinese queries and irrelevant requests. Against the frozen previous scope-only
selector, correct first result or correct abstention improves from **9/22 to 21/22**; precision
among all returned candidates improves from **77.8% to 90.5%**. Every selection stays within the
900-token estimate. These are synthetic retrieval regressions, **not live-agent success rates**.
The remaining failure, “import browser bookmarks,” retrieves browser-authentication and spreadsheet
lessons through generic shared words. Applicability checks matter; lexical retrieval is fallible.

Disk-backed and tool-boundary tests cover cross-session learning in six tool categories,
failed-only experience, same-call reflection and explicit decline, deletion, user corrections,
revalidation, secret rejection, memory permissions, untrusted recall and multilingual budgets.
The runtime does not learn from an abruptly stopped task, and an agent can decline or omit a
useful lesson. Saving a lesson still depends on model judgment. Future live-model evaluation
should measure successful later runs, avoided failures, irrelevant recall and stale-method
recovery across multiple tasks and providers before making stronger quality claims.
