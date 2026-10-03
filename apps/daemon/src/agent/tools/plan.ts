import type { ToolResult, UpdatePlanInput } from "@localdot/protocol";
import type { PlanItem } from "../session.ts";
import { append, type ToolCallContext, text } from "./deps.ts";

// update_plan: the task checklist (spec "Tools", "the plan lives outside the model's context").
// The brain sends the whole list; the plan panel gets plan.set when the items change and one
// plan.update per item when only their statuses do.
export function updatePlanTool(ctx: ToolCallContext, input: UpdatePlanInput): ToolResult {
  ctx.check();
  const { session } = ctx;
  const next: PlanItem[] = input.items.map((item, i) => ({
    id: `p${i + 1}`,
    text: ctx.redact(item.text),
    status: item.status,
  }));
  const same =
    next.length === session.plan.length &&
    next.every((item, i) => item.text === session.plan[i]?.text);
  if (!same) {
    append(ctx, "plan.set", { items: next });
  } else {
    next.forEach((item, i) => {
      if (item.status !== session.plan[i]?.status)
        append(ctx, "plan.update", { id: item.id, status: item.status });
    });
  }
  session.plan = next;
  const done = next.filter((i) => i.status === "done").length;
  return { ok: true, content: [text(`Plan saved: ${done} of ${next.length} done.`)] };
}
