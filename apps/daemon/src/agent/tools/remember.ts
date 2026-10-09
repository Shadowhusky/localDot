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
  if (input.file === "notes" && input.op !== "append")
    return fail('Daily notes are append-only. Use op "append".');
  try {
    ctx.check();
    const change =
      input.file === "notes"
        ? deps.memory.appendNote(ctx.session.id, ctx.redact(input.text))
        : deps.memory.apply(
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
    return {
      ok: true,
      content: [
        text(input.file === "notes" ? "Saved to today's notes." : `Saved to ${input.file}.`),
      ],
    };
  } catch (error) {
    if (error instanceof MemoryError) return fail(ctx.redact(error.message));
    return contain(deps, ctx, "memory_write_uncertain");
  }
}
