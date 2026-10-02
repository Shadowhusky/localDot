# Review tiers and pace (user ruling 2026-10-02)

The user found the build too slow: every task went through a review, a fix round and a re-review, whatever the task. From now on, the depth of review follows the risk.

## Review tiers (for every task not yet reviewed, in every part)
- **`full`:** security-boundary code:
  - keyd (vault, surrogates, listeners, egress, SSRF guard, LLM gateway, budgets);
  - the cell network and gates;
  - auth, tokens and stream tickets;
  - anything that handles secrets;
  - sandboxing;
  - approvals, takeover, Stop and the kill switch;
  - download quarantine.

  The process stays as before: review, then a fix round, then a scoped re-review, with mutation testing and a bypass hunt.
- **`light`:** everything else (UI, the stage and renderer, replay, plumbing, docs, tooling):
  - **one review;**
  - **one fix round:** the implementer fixes Critical and Important findings in it;
  - **Minors:** fixed only when trivial, otherwise batched into the part's final review;
  - **no re-review,** unless the review found a Critical.
- **Assigning tiers:** plans written from now on label each task (see `PLAN-WRITING.md`). For a task in an older plan (Parts 2, 3, 4a and 4b), the controller assigns the tier by the rule above when it dispatches the task. If in doubt, use `full`.

## Plans
See "Plan format by milestone" in `PLAN-WRITING.md`: for M5–M9, interface-and-test plans, and one review plus one fix pass.

## Milestone order
M9 (Ship) comes before M8 (premium feel and more providers). M8 is polish and extra providers, so it follows the first release. Plans for M5–M7 must not depend on M8. An M8 interface they mention (for example, M6's what-changed flash hook) is a seam only.
