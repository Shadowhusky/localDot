import type { AskUserInput, RequestTakeoverInput, ToolResult } from "@localdot/protocol";
import { screenOf } from "../safety/autonomy.ts";
import { frame, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
export async function askUserTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: AskUserInput,
): Promise<ToolResult> {
  ctx.check();
  const options = (input.options ?? []).map(ctx.redact);
  const answer = await ctx.session.ask(
    ctx.redact(input.question),
    options,
    input.allow_text ?? options.length === 0,
    deps.askTimeoutMs ?? 1800000,
    ctx.step,
    ctx.generation,
    ctx.signal,
  );
  ctx.check();
  if (answer.by === "pause")
    return {
      ok: false,
      pause: true,
      content: [text("The task was paused while waiting for an answer.")],
    };
  if (answer.by === "timeout")
    return { ok: false, content: [text("The user did not answer within 30 minutes.")] };
  if (answer.by === "stop") return { ok: false, content: [text("The question was cancelled.")] };
  const picked = answer.option ? options["ABCDEF".indexOf(answer.option)] : undefined;
  return {
    ok: true,
    content: [
      text(
        ctx.redact(
          [
            picked ? `The user chose ${answer.option}: ${picked}` : undefined,
            answer.text ? `The user wrote: ${answer.text}` : undefined,
          ]
            .filter(Boolean)
            .join("\n") || "The user answered without text.",
        ),
      ),
    ],
  };
}
export async function requestTakeoverTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RequestTakeoverInput,
): Promise<ToolResult> {
  ctx.check();
  if (input.reason !== "other") ctx.session.taskAutonomy.signIn(screenOf(ctx));
  const outcome = await ctx.session.takeover(
    input.reason,
    ctx.redact(input.note),
    ctx.step,
    ctx.lease,
  );
  ctx.check();
  if (outcome.by !== "user") return { ok: false, content: [text("The hand-back was cancelled.")] };
  const o = await deps.gateway.observe({
    sessionId: ctx.session.id,
    cellId: ctx.session.cellId,
    step: ctx.step,
    signal: ctx.signal,
  });
  ctx.check();
  const image = await frame(deps, ctx, o.frameId);
  ctx.check();
  return {
    ok: true,
    content: [
      text(
        ctx.redact(
          `The user handed the screen back.${outcome.note ? ` Their note: ${outcome.note}` : ""}`,
        ),
      ),
      image,
    ],
  };
}
