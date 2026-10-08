import type { ComputerAction, ToolResult } from "@localdot/protocol";
import {
  type ActionContext,
  CHANGED_WHILE_DECIDING,
  type GuiAction,
} from "../../gateway/gateway.ts";
import { authorizePrepared, type EffectPermit } from "../safety/authorize.ts";
import { nativeActionFacts } from "../safety/classify.ts";
import { frame, screenContext, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const MAX_WAIT_MS = 30_000;

async function screenshot(deps: ToolDeps, ctx: ToolCallContext): Promise<ToolResult> {
  ctx.check();
  const o = await deps.gateway.observe(screenContext(ctx));
  ctx.check();
  return { ok: true, content: [await frame(deps, ctx, o.frameId)] };
}

function gui(a: ComputerAction): GuiAction | string {
  const basedOn = a.basedOn ? { basedOn: a.basedOn } : {};
  switch (a.action) {
    case "click":
      if (!a.point) return "click needs a coordinate";
      return {
        verb: "click",
        point: a.point,
        button: a.button ?? "left",
        count: a.count ?? 1,
        speed: "auto",
        ...basedOn,
      };
    case "type":
      if (!a.text) return "type needs text";
      return { verb: "type", text: a.text, speed: "auto" };
    case "key":
      if (!a.keys) return "key needs keys";
      return { verb: "key", combo: a.keys, speed: "auto" };
    case "scroll":
      if (!a.point) return "scroll needs a coordinate";
      return {
        verb: "scroll",
        point: a.point,
        dx: a.dx ?? 0,
        dy: a.dy ?? 0,
        speed: "auto",
        ...basedOn,
      };
    case "wait":
      return { verb: "wait", ms: Math.min(MAX_WAIT_MS, a.ms ?? 1000) };
    default:
      return `${a.action} is not an input`;
  }
}

// The computer tool: every input runs through Part 3's action gateway (intent → travel → dispatch
// → settle → observe), and its own result frame goes back to the model as PNG.
export async function computerTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  a: ComputerAction,
): Promise<ToolResult> {
  ctx.check();
  const { session } = ctx;
  const selected = screenContext(ctx);
  if (a.action === "screenshot") {
    if (!ctx.permit?.consume(a, null))
      return { ok: false, content: [text("This screenshot was not authorized.")] };
    return screenshot(deps, ctx);
  }
  if (a.action === "cursor_position") {
    const device = deps.gateway.cursorOf(selected.cellId);
    const scale = ctx.nativeScreen?.scale ?? deps.scaleOf(session.cellId) ?? 1;
    const p = device
      ? { x: Math.round(device.x / scale), y: Math.round(device.y / scale) }
      : { x: 640, y: 400 };
    return { ok: true, content: [text(`The cursor is at (${p.x}, ${p.y}).`)] };
  }
  if (a.action === "zoom") {
    if (!ctx.permit?.consume(a, null))
      return { ok: false, content: [text("This screenshot was not authorized.")] };
    if (!a.region) return { ok: false, content: [text("zoom needs a region")] };
    const frameId = session.lastFrameId ?? (await deps.gateway.observe(selected)).frameId;
    ctx.check();
    return { ok: true, content: [await frame(deps, ctx, frameId, a.region)] };
  }
  const action = gui(a);
  if (typeof action === "string") return { ok: false, content: [text(action)] };
  const repeat = a.action === "key" ? (a.repeat ?? 1) : 1;
  let runs = 0;
  // One card covers the whole repeat, for the exact input and target it showed and nothing else.
  let approval: EffectPermit | undefined;
  const nativeContext: ActionContext = {
    ...selected,
    source: "agent",
    beforeEffect: (action, identity) => session.admitNativeEffect(action, identity, ctx.step),
    redact: ctx.redact,
    authorizeAgent: async (request) => {
      ctx.check();
      const left = repeat - runs++;
      const permit =
        approval ??
        (await authorizePrepared(ctx, {
          tool: "computer",
          input: { toolInput: a, action: request.action },
          target: request.identity,
          // DesktopdClient already parsed WireTarget. Classify full native strings before public clipping.
          facts: nativeActionFacts(request.action, request.identity.target),
          revalidate: request.revalidate,
          count: left,
        }));
      ctx.check();
      if (!permit) return undefined;
      if (permit.approved) approval = permit;
      return {
        consume: (current, identity) => permit.consume({ toolInput: a, action: current }, identity),
      };
    },
  };
  let outcome = await deps.gateway.run(nativeContext, action);
  ctx.check();
  for (let i = 1; i < repeat && outcome.ok; i++) {
    outcome = await deps.gateway.run(nativeContext, action);
    ctx.check();
  }
  if (action.verb === "wait" && outcome.ok) return screenshot(deps, ctx);
  const content: ToolResult["content"] = [];
  if (outcome.cancelled === "stale") {
    content.push(
      text(
        outcome.error === CHANGED_WHILE_DECIDING
          ? CHANGED_WHILE_DECIDING
          : "Not clicked: the screen changed around that point since your screenshot. Here is the screen now; look again before acting.",
      ),
    );
  } else if (!outcome.ok) {
    content.push(
      text(ctx.redact(`Failed: ${outcome.error ?? outcome.cancelled ?? "unknown error"}`)),
    );
  }
  if (outcome.frameId) {
    try {
      content.push(await frame(deps, ctx, outcome.frameId));
    } catch (error) {
      ctx.check();
      if (outcome.cancelled !== "stale") throw error;
      // A failed screenshot read must not erase the gateway's trusted cancellation cause.
      content.push(text("The new screenshot could not be read. Look again before acting."));
    }
  }
  return {
    ok: outcome.ok,
    ...(outcome.cancelled === "stale" ? { cancelled: "stale" as const } : {}),
    content: content.length ? content : [text(outcome.ok ? "Done." : "Failed.")],
  };
}
