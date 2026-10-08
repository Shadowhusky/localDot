import { type ComputerAction, clipText, type Target, type ToolResult } from "@localdot/protocol";
import { checkCombo } from "@localdot/protocol/keys";
import type { ActionContext, ActionOutcome, GuiAction } from "../../gateway/gateway.ts";
import { authorizePrepared } from "../safety/authorize.ts";
import { classify, type RiskFacts } from "../safety/risk.ts";
import type { AgentSession } from "../session.ts";
import { frame, screenContext, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const MAX_WAIT_MS = 30_000;

async function screenshot(deps: ToolDeps, ctx: ToolCallContext): Promise<ToolResult> {
  ctx.check();
  const o = await deps.gateway.observe(screenContext(ctx));
  ctx.check();
  return { ok: true, content: [await frame(deps, ctx, o.frameId)] };
}

// DesktopdClient already parsed WireTarget. Classify full native strings before public clipping.
function nativeFacts(action: GuiAction, target: Target | null): RiskFacts {
  if (action.verb === "wait" || action.verb === "scroll") return { operation: action.verb };
  return {
    operation: action.verb,
    ...(target
      ? {
          target: {
            source: target.source,
            fresh: true,
            role: target.role,
            name: target.name,
            url: target.url,
            secret: target.secret === true,
          },
        }
      : {}),
  };
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
      return (
        checkCombo(a.keys) ?? {
          verb: "key",
          combo: a.keys,
          ...(a.repeat && a.repeat > 1 ? { repeat: a.repeat } : {}),
          speed: "auto",
        }
      );
    case "hold_key":
      if (!a.keys || !a.ms) return "hold_key needs keys and how long to hold them (ms)";
      return checkCombo(a.keys) ?? { verb: "key", combo: a.keys, holdMs: a.ms, speed: "auto" };
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

function element(t: Target): string {
  return [
    t.name ? JSON.stringify(clipText(t.name, 60)) : "an unnamed element",
    ...(t.role ? [`(${clipText(t.role, 40)})`] : []),
    ...(t.window ? [`in ${JSON.stringify(clipText(t.window, 80))}`] : []),
  ].join(" ");
}

// Where typing and keys went, and whether the screen changed: a screenshot shows neither keyboard
// focus nor a key that reached nothing.
function keyboardNote(a: ComputerAction, outcome: ActionOutcome): string | undefined {
  if (!outcome.ok) return undefined;
  const focus = outcome.focus;
  const target = focus && !focus.unknown ? focus.target : undefined;
  const still = outcome.changed === false ? " No visible change." : "";
  if (a.action === "type" && a.text) {
    const n = [...a.text].length;
    const typed = `Typed ${n} character${n === 1 ? "" : "s"}`;
    if (target) return `${typed} into ${element(target)}.${still}`;
    if (target === null) return `${typed}, but no element had keyboard focus.${still}`;
    return `${typed}; where keyboard focus was is unknown.${still}`;
  }
  if ((a.action !== "key" && a.action !== "hold_key") || !a.keys) return undefined;
  const keys = a.keys.join("+");
  const did =
    a.action === "hold_key"
      ? `Held ${keys} for ${Number(((a.ms ?? 0) / 1000).toFixed(1))} s.`
      : a.repeat && a.repeat > 1
        ? `Pressed ${keys} ${a.repeat} times.`
        : `Pressed ${keys}.`;
  const where = target
    ? `keyboard focus is on ${element(target)}`
    : target === null
      ? "no element has keyboard focus"
      : "keyboard focus is unknown";
  return outcome.changed === false
    ? `${did} No visible change: ${where}.`
    : `${did} ${where[0]?.toUpperCase()}${where.slice(1)}.`;
}

// A hold ends when the task is paused: nobody is left to let go of the keys.
function untilPaused(session: AgentSession, signal: AbortSignal) {
  const paused = new AbortController();
  const over = new AbortController();
  const watching = AbortSignal.any([signal, over.signal]);
  void (async () => {
    while (!watching.aborted) {
      if (session.safetyPause) return paused.abort(new Error("the task was paused"));
      const revision = session.safetyControlRevision;
      await session.waitSafetyControl(revision, 25_000, watching).catch(() => undefined);
    }
  })();
  return { signal: AbortSignal.any([signal, paused.signal]), end: () => over.abort() };
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
  const hold =
    action.verb === "key" && action.holdMs ? untilPaused(session, ctx.signal) : undefined;
  const nativeContext: ActionContext = {
    ...selected,
    ...(hold ? { signal: hold.signal } : {}),
    source: "agent",
    beforeEffect: (action, identity) => session.admitNativeEffect(action, identity),
    afterEffect: (changed) => session.settleNativeEffect(changed),
    redact: ctx.redact,
    authorizeAgent: async (request) => {
      ctx.check();
      const facts = nativeFacts(request.action, request.identity.target);
      const approved = classify(facts, ctx.session.autonomy).actionClass;
      const boundInput = { toolInput: a, action: request.action };
      const permit = await authorizePrepared(ctx, {
        tool: "computer",
        input: boundInput,
        target: request.identity,
        facts,
        revalidate: request.revalidate,
      });
      ctx.check();
      if (!permit) return undefined;
      return {
        // An approval made without an element binds only its window, so the read at dispatch may
        // name one: it must fall in the approved class, or in one the policy runs without asking.
        consume: (current, identity, fresh) => {
          const found = classify(nativeFacts(current, fresh.target), ctx.session.autonomy);
          if (found.mode !== "act" && found.actionClass !== approved) return false;
          if (ctx.redact(JSON.stringify(fresh)) !== JSON.stringify(fresh)) return false;
          return permit.consume({ toolInput: a, action: current }, identity);
        },
      };
    },
  };
  let outcome: ActionOutcome;
  try {
    outcome = await deps.gateway.run(nativeContext, action);
  } finally {
    hold?.end();
  }
  ctx.check();
  if (action.verb === "wait" && outcome.ok) return screenshot(deps, ctx);
  const content: ToolResult["content"] = [];
  const note = keyboardNote(a, outcome);
  if (note) content.push(text(ctx.redact(note)));
  if (outcome.cancelled === "stale") {
    content.push(
      text(
        "Not clicked: the screen changed around that point since your screenshot. Here is the screen now; look again before acting.",
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
