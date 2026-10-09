import type { SwitchScreenInput, ToolResult } from "@localdot/protocol";
import { append, fail, type ToolCallContext, text } from "./deps.ts";

export async function switchScreenTool(
  ctx: ToolCallContext,
  input: SwitchScreenInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.session.screens) return fail("The web browser is unavailable in this session.");
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "switch_screen",
    title: input.screen === "browser" ? "Switching to the web browser" : "Switching to the desktop",
  });
  // No old screen lease is held here: the controller drains native work and revokes
  // its previous grant before recording and publishing the newly selected screen.
  const selected = await ctx.session.switchScreen(input.screen, ctx.lease);
  ctx.check();
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  return {
    ok: true,
    content: [
      text(
        `Selected ${selected.screen === "browser" ? "the web browser" : "the desktop"}. Request a fresh screenshot before GUI input. Shell and files still operate on the desktop.`,
      ),
    ],
  };
}
