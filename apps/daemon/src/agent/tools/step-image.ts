import { ulid } from "@localdot/protocol";
import type { ToolCallContext, ToolDeps } from "./deps.ts";

// UI-only: persist the already decoded model image without another fetch or model input.
// Return only a private, session-owned reference; never put it in ToolResult.content.
export async function saveStepImage(
  deps: ToolDeps,
  ctx: ToolCallContext,
  bytes: Uint8Array,
  alt: string,
): Promise<{ name: string; alt: string } | undefined> {
  ctx.check();
  if (ctx.callId.startsWith("skill-")) return undefined;
  const name = `step-image-${ulid()}.jpg`;
  try {
    await deps.saveOutput(
      ctx.session.id,
      name,
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { signal: ctx.signal, check: ctx.check },
    );
    ctx.check();
    return { name, alt: ctx.redact(alt).slice(0, 1024) };
  } catch {
    // Disk failure must not discard the model's existing image; cancellation still propagates.
    ctx.check();
    return undefined;
  }
}
