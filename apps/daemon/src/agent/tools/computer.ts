import {
  type ComputerAction,
  clipText,
  MAX_DRAG_MS,
  type Target,
  type ToolResult,
} from "@localdot/protocol";
import { checkCombo, checkModifiers } from "@localdot/protocol/keys";
import {
  type ActionContext,
  type ActionOutcome,
  CHANGED_WHILE_DECIDING,
  type GuiAction,
  HELD_BUTTON_MS,
  type NativeActionIdentity,
} from "../../gateway/gateway.ts";
import { authorizePrepared } from "../safety/authorize.ts";
import { decideAutonomy } from "../safety/autonomy.ts";
import { nativeActionFacts } from "../safety/classify.ts";
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
// A drag, and a move, scroll or release while a button is down, has the press as its start and
// what is under its own point as its drop.
const factsOf = (action: GuiAction, identity: NativeActionIdentity) =>
  nativeActionFacts(
    action,
    identity.target,
    identity.drop ? identity.drop.target : action.verb === "drag" ? null : undefined,
  );

const modsOf = (a: ComputerAction): { mods?: string[] } | string =>
  a.mods ? (checkModifiers(a.mods) ?? { mods: a.mods }) : {};

function gui(a: ComputerAction): GuiAction | string {
  const basedOn = a.basedOn ? { basedOn: a.basedOn } : {};
  const point = a.point ? { point: a.point } : {};
  const mods = modsOf(a);
  if (typeof mods === "string") return mods;
  switch (a.action) {
    case "click":
      return {
        verb: "click",
        ...point,
        button: a.button ?? "left",
        count: a.count ?? 1,
        ...mods,
        speed: "auto",
        ...basedOn,
      };
    case "drag":
      if (!a.path) return "drag needs a path";
      if (a.ms !== undefined && (a.ms <= 0 || a.ms > MAX_DRAG_MS))
        return `a drag lasts more than 0 and at most ${MAX_DRAG_MS} ms`;
      return {
        verb: "drag",
        path: a.path,
        button: a.button ?? "left",
        ...mods,
        ...(a.ms ? { durationMs: a.ms } : {}),
        speed: "auto",
        ...basedOn,
      };
    case "move":
      if (!a.point) return "move needs a point";
      return { verb: "move", point: a.point, speed: "auto", ...basedOn };
    case "mouse_down":
      return {
        verb: "down",
        ...point,
        button: a.button ?? "left",
        ...mods,
        speed: "auto",
        ...basedOn,
      };
    case "mouse_up":
      if (a.mods) return "mouse_up takes no keys: the keys held with mouse_down come up with it";
      return { verb: "up", ...point, button: a.button ?? "left", speed: "auto" };
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
      return {
        verb: "scroll",
        ...point,
        dx: a.dx ?? 0,
        dy: a.dy ?? 0,
        ...mods,
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

const seconds = (ms: number | undefined) => Number(((ms ?? 0) / 1000).toFixed(1));

// Where typing and keys went, and whether the screen changed: a screenshot shows neither keyboard
// focus nor a key that reached nothing. A repeat or hold that stopped part-way says how far it got.
function keyboardNote(a: ComputerAction, outcome: ActionOutcome): string | undefined {
  const partial = outcome.partial;
  if (!outcome.ok && !partial) return undefined;
  const focus = outcome.focus;
  const target = focus && !focus.unknown ? focus.target : undefined;
  const still = outcome.changed === false ? " No visible change." : "";
  if (a.action === "type" && a.text) {
    const n = [...a.text].length;
    const typed = `Typed ${n} character${n === 1 ? "" : "s"}`;
    if (target) return `${typed} into ${element(target)}.${still}`;
    if (target === null) return `${typed}, but no element had keyboard focus.${still}`;
    return `${typed}; keyboard focus is unknown.${still}`;
  }
  if ((a.action !== "key" && a.action !== "hold_key") || !a.keys) return undefined;
  const keys = a.keys.join("+");
  const did = partial
    ? a.action === "hold_key"
      ? `Held ${keys} for ${seconds(partial.heldMs)} s of ${seconds(a.ms)} s, then stopped: ${outcome.error ?? "stopped"}.`
      : `Pressed ${keys} ${partial.presses} of ${a.repeat ?? 1} times, then stopped: ${outcome.error ?? "stopped"}.`
    : a.action === "hold_key"
      ? `Held ${keys} for ${seconds(a.ms)} s.`
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

const BUTTON_HELD_S = HELD_BUTTON_MS / 1000;
const STALE: Partial<Record<ComputerAction["action"], string>> = {
  click: "Not clicked",
  scroll: "Not scrolled",
  drag: "Not dragged",
  mouse_down: "Not pressed",
};

// What a pointer action did that its screenshot cannot show: a button left down, one that was not
// down, or a drag that was cancelled before its drop.
function pointerNote(a: ComputerAction, outcome: ActionOutcome): string | undefined {
  const button = a.button ?? "left";
  if (a.action === "mouse_down" && outcome.ok)
    return `The ${button} button is down. It stays down until mouse up, or ${BUTTON_HELD_S} s without another mouse action. Each mouse move and the mouse up while it is down asks like a drag.`;
  if (a.action === "mouse_up" && outcome.notDown) return `The ${button} button was not down.`;
  if (outcome.dropCancelled)
    return "The drag was cancelled before its drop: Escape was pressed while the button was down, then the button came up where the pointer was.";
  return undefined;
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
  // The browser screen presses one key at a time and keeps no button down between actions:
  // refused before approval.
  if (ctx.screen?.selection.screen === "browser") {
    if (a.action === "hold_key")
      return { ok: false, content: [text("Holding keys is not available on the browser screen.")] };
    if (a.action === "mouse_down" || a.action === "mouse_up")
      return {
        ok: false,
        content: [
          text(
            "Holding a mouse button between actions is not available on the browser screen; drag with left_click_drag instead.",
          ),
        ],
      };
  }
  // A hold or a drag ends when the task is paused: nobody is left to let go.
  const hold =
    (action.verb === "key" && action.holdMs) || action.verb === "drag"
      ? untilPaused(session, ctx.signal)
      : undefined;
  const nativeContext: ActionContext = {
    ...selected,
    ...(hold ? { signal: hold.signal } : {}),
    source: "agent",
    beforeEffect: (action, identity) => session.admitNativeEffect(action, identity, ctx.step),
    afterEffect: (action, identity, changed) =>
      session.settleNativeEffect(action, identity, changed),
    holdInput: (release) => session.holdInput(release),
    redact: ctx.redact,
    authorizeAgent: async (request) => {
      ctx.check();
      const facts = factsOf(request.action, request.identity);
      const approved = decideAutonomy(ctx, facts).actionClass;
      const permit = await authorizePrepared(ctx, {
        tool: "computer",
        input: { toolInput: a, action: request.action },
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
          const found = decideAutonomy(ctx, factsOf(current, fresh));
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
  const note = keyboardNote(a, outcome) ?? pointerNote(a, outcome);
  if (note) content.push(text(ctx.redact(note)));
  if (outcome.cancelled === "stale") {
    content.push(
      text(
        outcome.error === CHANGED_WHILE_DECIDING
          ? CHANGED_WHILE_DECIDING
          : `${STALE[a.action] ?? "Not done"}: the screen changed around that point since your screenshot. Here is the screen now; look again before acting.`,
      ),
    );
  } else if (!outcome.ok && !outcome.partial) {
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
