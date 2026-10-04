import type { RememberInput, ToolResult } from "@localdot/protocol";
import { MemoryError } from "../memory.ts";
import { append, contain, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
export async function rememberTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RememberInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  if (ctx.session.tainted)
    return fail(
      "Memory can only be saved from the user's own request or reply. Ask the user to confirm the fact first.",
    );
  try {
    ctx.check();
    const change = deps.memory.apply(
      ctx.session.id,
      input.file,
      input.op,
      ctx.redact(input.text),
      input.old_text === undefined ? undefined : ctx.redact(input.old_text),
    );
    ctx.check();
    append(ctx, "memory.change", {
      file: change.file,
      patch: change.patch,
      changeId: change.changeId,
    });
    return { ok: true, content: [text(`Saved to ${input.file}.`)] };
  } catch (error) {
    if (error instanceof MemoryError) return fail(ctx.redact(error.message));
    return contain(deps, ctx, "memory_write_uncertain");
  }
}
