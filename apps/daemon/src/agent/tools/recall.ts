import {
  clipText,
  RECALL_DEFAULT_LIMIT,
  type RecallInput,
  type ToolResult,
} from "@localdot/protocol";
import { untrusted } from "../untrusted.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const KIND_WORD = {
  title: "title",
  user: "the user wrote",
  assistant: "dot replied",
  summary: "result",
  step: "step",
  file: "file",
  note: "daily note",
} as const;

// Earlier tasks hold what pages said, so a recall reaches the model as untrusted text and marks the
// task as having read private data.
export async function recallTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RecallInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  if (!deps.recall && !deps.recallExperience)
    return fail("Search of earlier tasks is not available.");
  const query = ctx.redact(input.query);
  append(ctx, "step.start", { kind: "think" });
  append(ctx, "tool.start", {
    tool: "recall",
    title: clipText(`Search earlier tasks: ${query}`, 200),
  });
  const hits = deps.recall?.(query, input.limit ?? RECALL_DEFAULT_LIMIT, ctx.session.id) ?? [];
  const experience = deps.recallExperience?.(query, ctx.session.id) ?? "";
  const history = hits.length
    ? hits
        .map((h, i) => `${i + 1}. ${h.title} · ${h.day} · ${KIND_WORD[h.kind]}\n   ${h.snippet}`)
        .join("\n")
    : "No earlier tasks match.";
  const body = experience ? `${experience}\n\n${history}` : history;
  ctx.session.tainted = true;
  if (hits.length || experience) ctx.session.taint.add("recall", "earlier tasks", body);
  ctx.check();
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  return { ok: true, content: [text(untrusted("earlier tasks", ctx.redact(body)))] };
}
