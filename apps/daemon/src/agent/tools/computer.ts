import {
  type ComputerAction,
  type ComputerStep,
  clipText,
  type FindRequest,
  MAX_DRAG_MS,
  type Target,
  type ToolResult,
  ulid,
} from "@localdot/protocol";
import { checkCombo, checkModifiers } from "@localdot/protocol/keys";
import {
  type ActionContext,
  type ActionOutcome,
  CHANGED_WHILE_DECIDING,
  ELEMENT_GONE,
  type GuiAction,
  HELD_BUTTON_MS,
  type NativeActionIdentity,
} from "../../gateway/gateway.ts";
import { authorizePrepared, runsUnasked } from "../safety/authorize.ts";
import { decideAutonomy } from "../safety/autonomy.ts";
import { nativeActionFacts } from "../safety/classify.ts";
import type { AgentSession } from "../session.ts";
import { append, frame, screenContext, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const MAX_WAIT_MS = 30_000;
const LOOK_AGAIN =
  "Not done: the user had the computer, so the screen may have changed. Here is the screen now; look again before acting.";

export const UNCHANGED = "The screen did not change: it still matches your last screenshot.";

// The screen after an action, which counts as a fresh look: no new image when it is the very screen
// the model last saw. That is the newest screen sent, which in a turn of several actions is an
// earlier action's, not the turn's basis; a model with no screenshot (no basis) always gets one.
export async function observation(
  deps: ToolDeps,
  ctx: ToolCallContext,
  frameId: string,
  basedOn: string | undefined,
): Promise<ToolResult["content"][number]> {
  ctx.check();
  const last = ctx.session.lastFrameId;
  if (basedOn && last && last !== frameId && deps.png.same?.(ctx.session.id, last, frameId)) {
    ctx.session.lastFrameId = frameId;
    ctx.session.freshLook();
    return text(UNCHANGED);
  }
  const image = await frame(deps, ctx, frameId);
  ctx.session.freshLook();
  return image;
}

async function screenshot(
  deps: ToolDeps,
  ctx: ToolCallContext,
  basedOn: string | undefined,
): Promise<ToolResult> {
  ctx.check();
  const o = await deps.gateway.observe(screenContext(ctx));
  ctx.check();
  return { ok: true, content: [await observation(deps, ctx, o.frameId, basedOn)] };
}

const UNREAD =
  "Done, but the screen could not be read after it. Take a screenshot before acting on what it did.";

// DesktopdClient already parsed WireTarget. Classify full native strings before public clipping.
// A drag, and a move, scroll or release while a button is down, has the press as its start and
// what is under its own point as its drop.
const factsOf = (action: GuiAction, identity: NativeActionIdentity) =>
  nativeActionFacts(
    action,
    identity.target,
    identity.drop ? identity.drop.target : action.verb === "drag" ? null : undefined,
    { target: identity.unknown, drop: identity.drop?.unknown },
  );

const modsOf = (a: ComputerStep): { mods?: string[] } | string =>
  a.mods ? (checkModifiers(a.mods) ?? { mods: a.mods }) : {};

// `find` acts on an element instead of a point: a click or a scroll at its centre, wherever it is.
function gui(a: ComputerStep, basis: string | undefined, find?: FindRequest): GuiAction | string {
  const basedOn = basis ? { basedOn: basis } : {};
  const point = find ? {} : a.point ? { point: a.point } : {};
  const mods = modsOf(a);
  if (typeof mods === "string") return mods;
  switch (a.action) {
    case "click":
      return {
        verb: "click",
        ...point,
        ...(find ? { find } : {}),
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
        ...(find ? { find } : {}),
        dx: a.dx ?? 0,
        dy: a.dy ?? 0,
        ...mods,
        speed: "auto",
        ...basedOn,
      };
    case "wait":
      return { verb: "wait", ms: Math.min(MAX_WAIT_MS, a.ms ?? 1000) };
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
function keyboardNote(a: ComputerStep, outcome: ActionOutcome): string | undefined {
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
const STALE: Partial<Record<ComputerStep["action"], string>> = {
  click: "Not clicked",
  scroll: "Not scrolled",
  drag: "Not dragged",
  mouse_down: "Not pressed",
};

// What a pointer action did that its screenshot cannot show: a button left down, one that was not
// down, or a drag that was cancelled before its drop.
function pointerNote(a: ComputerStep, outcome: ActionOutcome): string | undefined {
  const button = a.button ?? "left";
  if (a.action === "mouse_down" && outcome.ok)
    return `The ${button} button is down. It stays down until mouse up, or ${BUTTON_HELD_S} s without another mouse action. A mouse move, a scroll and the mouse up while it is down drag from where it went down.`;
  if (a.action === "mouse_up" && outcome.notDown) return `The ${button} button was not down.`;
  if (outcome.dropCancelled)
    return "The drag was cancelled before its drop: Escape was pressed if the pointer had moved, then the button came up where the pointer was. Some apps keep what the drag did so far.";
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

export interface InputOptions {
  // The screenshot the model chose the input on.
  basedOn?: string;
  // A click or scroll at this element instead of the input's point.
  find?: FindRequest;
  // A batched input that needs the user's approval or control is not done, and ends the batch.
  stopOnAsk?: boolean;
  // An input on a password field is not done; this says why instead.
  refuseSecret?: string;
}

export interface InputRun {
  ok: boolean;
  // What the input did that a screenshot cannot show, or why it was not done.
  notes: ToolResult["content"];
  frameId?: string;
  stale?: true;
  needsUser?: true;
  // The element it was to act on is not there as listed.
  gone?: true;
}

const NEEDS_USER = "this step needs the user's approval or control";

// One input through Part 3's action gateway (intent → travel → dispatch → settle → observe), with
// its authorization: the classifier and approval path every pixel action takes.
export async function runInput(
  deps: ToolDeps,
  ctx: ToolCallContext,
  a: ComputerStep,
  options: InputOptions = {},
): Promise<InputRun> {
  ctx.check();
  const { session } = ctx;
  const selected = screenContext(ctx);
  const fail = (message: string): InputRun => ({ ok: false, notes: [text(message)] });
  // An element found at dispatch is checked by its own identity, not the screenshot's pixels.
  const action = gui(a, options.find ? undefined : options.basedOn, options.find);
  if (typeof action === "string") return fail(action);
  // What dot saw before the user had the computer may be gone: it acts on a fresh look.
  if (action.verb !== "wait" && session.lookOwed) {
    const o = await deps.gateway.observe(selected);
    ctx.check();
    return { ok: false, notes: [text(LOOK_AGAIN)], frameId: o.frameId, stale: true };
  }
  // The browser screen presses one key at a time and keeps no button down between actions:
  // refused before approval.
  if (ctx.screen?.selection.screen === "browser") {
    if (a.action === "hold_key")
      return fail("Holding keys is not available on the browser screen.");
    if (a.action === "mouse_down" || a.action === "mouse_up")
      return fail(
        "Holding a mouse button between actions is not available on the browser screen; drag with left_click_drag instead.",
      );
  }
  // A hold or a drag ends when the task is paused: nobody is left to let go.
  const hold =
    (action.verb === "key" && action.holdMs) || action.verb === "drag"
      ? untilPaused(session, ctx.signal)
      : undefined;
  let needsUser = false;
  let secret = false;
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
      const prepared = {
        tool: "computer" as const,
        input: { toolInput: a, action: request.action },
        target: request.identity,
        facts,
        revalidate: request.revalidate,
      };
      const identity = request.identity;
      if (options.refuseSecret && (identity.target?.secret || identity.drop?.target?.secret)) {
        secret = true;
        throw new Error(options.refuseSecret);
      }
      if (options.stopOnAsk && !runsUnasked(ctx, prepared)) {
        needsUser = true;
        throw new Error(NEEDS_USER);
      }
      const permit = await authorizePrepared(ctx, prepared);
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
  if (needsUser) return { ok: false, notes: [], needsUser: true };
  if (secret && options.refuseSecret) return fail(options.refuseSecret);
  if (outcome.cancelled === "preflight" && outcome.error === ELEMENT_GONE)
    return { ok: false, notes: [], gone: true };
  if (action.verb === "wait" && outcome.ok) {
    const o = await deps.gateway.observe(selected);
    ctx.check();
    return { ok: true, notes: [], frameId: o.frameId };
  }
  const notes: ToolResult["content"] = [];
  const note = keyboardNote(a, outcome) ?? pointerNote(a, outcome);
  if (note) notes.push(text(ctx.redact(note)));
  if (outcome.ok && outcome.unread) notes.push(text(UNREAD));
  if (outcome.cancelled === "stale") {
    notes.push(
      text(
        outcome.error === CHANGED_WHILE_DECIDING
          ? CHANGED_WHILE_DECIDING
          : `${STALE[a.action] ?? "Not done"}: the screen changed around that point since your screenshot. Here is the screen now; look again before acting.`,
      ),
    );
  } else if (!outcome.ok && !outcome.partial) {
    notes.push(
      text(ctx.redact(`Failed: ${outcome.error ?? outcome.cancelled ?? "unknown error"}`)),
    );
  }
  return {
    ok: outcome.ok,
    notes,
    ...(outcome.frameId ? { frameId: outcome.frameId } : {}),
    ...(outcome.cancelled === "stale" ? { stale: true as const } : {}),
  };
}

// An input's notes and its screen as one result. A stale cancel keeps its trusted cause even when
// the screenshot cannot be read.
export async function inputResult(
  deps: ToolDeps,
  ctx: ToolCallContext,
  run: InputRun,
  basedOn: string | undefined,
): Promise<ToolResult> {
  const content: ToolResult["content"] = [...run.notes];
  if (run.frameId) {
    try {
      content.push(await observation(deps, ctx, run.frameId, basedOn));
    } catch (error) {
      ctx.check();
      if (!run.stale) throw error;
      content.push(text("The new screenshot could not be read. Look again before acting."));
    }
  }
  return {
    ok: run.ok,
    ...(run.stale ? { cancelled: "stale" as const } : {}),
    content: content.length ? content : [text(run.ok ? "Done." : "Failed.")],
  };
}

// A further input of one call gets its own Activity step.
export function nextStep(ctx: ToolCallContext, status: "ok" | "failed" = "ok"): void {
  append(ctx, "step.end", { status });
  ctx.step = ulid();
  append(ctx, "step.start", { kind: "gui" });
}

const doneBefore = (i: number) =>
  i === 0 ? "" : i === 1 ? " Step 1 was done." : ` Steps 1 to ${i} were done.`;

// A step by its action alone: its point is in model pixels, which a model that gives points in
// another space would not recognise.
function ordinal(a: ComputerStep): string {
  const keys = a.keys?.join("+");
  if (a.action === "key" || a.action === "hold_key") return `${a.action} ${keys ?? ""}`.trim();
  return a.action;
}

// Steps run in order with the usual settle between them, each authorized on its own with the
// batch's screenshot as its basis, and one screen comes back at the end. The batch stops at the
// first step that fails, whose target changed since that screenshot, or that needs the user (it is
// not done: the model does it as its own action, which asks).
async function batch(deps: ToolDeps, ctx: ToolCallContext, a: ComputerAction): Promise<ToolResult> {
  const steps = a.steps;
  if (!steps?.length) return { ok: false, content: [text("batch needs steps")] };
  const notes: ToolResult["content"] = [];
  let frameId: string | undefined;
  for (const [i, step] of steps.entries()) {
    const which = `step ${i + 1} of ${steps.length} (${ordinal(step)})`;
    if (i > 0) nextStep(ctx);
    if (ctx.session.safetyPause) {
      notes.push(text(`Stopped before ${which}: the task was paused.`));
      return finish(false, "unrun");
    }
    const run = await runInput(deps, ctx, step, {
      ...(a.basedOn ? { basedOn: a.basedOn } : {}),
      stopOnAsk: true,
    });
    ctx.check();
    if (run.frameId) frameId = run.frameId;
    if (run.needsUser) {
      notes.push(
        text(
          `Stopped before ${which}: it needs the user's approval or control, so do it as its own action.${doneBefore(i)}`,
        ),
      );
      return finish(false, "unrun");
    }
    if (!run.ok) {
      notes.push(text(`Stopped at ${which}.${doneBefore(i)}`), ...run.notes);
      return finish(false, run.stale ? "stale" : undefined);
    }
    notes.push(...run.notes);
  }
  return finish(true);

  // The row of a step stopped before it did anything ends as cancelled, not failed.
  async function finish(ok: boolean, stop?: "stale" | "unrun"): Promise<ToolResult> {
    if (stop === "unrun") ctx.stepCancelled = true;
    if (!frameId) frameId = (await deps.gateway.observe(screenContext(ctx))).frameId;
    ctx.check();
    const stale = stop === "stale" ? { stale: true as const } : {};
    return inputResult(deps, ctx, { ok, notes, frameId, ...stale }, a.basedOn);
  }
}

// The computer tool: one input, a batch of them, or a look at the screen; its result frame goes
// back to the model as PNG unless it is the screen the model already has.
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
    return screenshot(deps, ctx, a.basedOn);
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
  if (a.action === "batch") return batch(deps, ctx, a);
  if (a.steps) return { ok: false, content: [text("steps are only for a batch")] };
  const { steps: _none, basedOn, region: _region, ...input } = a;
  const run = await runInput(deps, ctx, input as ComputerStep, basedOn ? { basedOn } : {});
  return inputResult(deps, ctx, run, basedOn);
}
