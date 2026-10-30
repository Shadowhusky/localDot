import {
  ApprovalRequestDraft,
  clipText,
  type ToolName,
  UploadApproval,
  type WebSearchKind,
} from "@localdot/protocol";
import { repeatsWhileHeld } from "@localdot/protocol/keys";
import type { ToolCallContext } from "../tools/deps.ts";
import { searchAddresses } from "../web/engines.ts";
import { OncePermit } from "./approvals.ts";
import { actingFacts, alwaysOptions, decideAutonomy, screenOf } from "./autonomy.ts";
import { handoffFor } from "./handoff.ts";
import { outboundOf, type PurposeVerdict } from "./purpose.ts";
import { actionDigest, buildApprovalCard, type RiskDecision, type RiskFacts } from "./risk.ts";
import { PausedStepError } from "./step-barrier.ts";

const MAX_DESTINATIONS = 64;
// A card holds 16 rows: the app, the tool and the purpose check's destination leave the rest for
// the arguments, the last of which gathers any that don't fit.
const ARGUMENT_ROWS = 13;

export interface EffectPermit {
  // The user approved a card for this exact effect, rather than the policy letting it act.
  readonly approved: boolean;
  consume(input: unknown, target: unknown): boolean;
}
export interface PreparedEffect {
  // A v1 tool, or a connected app's tool by dot's name for it.
  readonly tool: ToolName | string;
  readonly input: unknown;
  readonly target: unknown;
  readonly facts: RiskFacts;
  readonly upload?: UploadApproval;
  observeTarget?: () => Promise<import("./visual-target.ts").TargetObservation>;
  revalidate(): Promise<boolean>;
}
export function freezeExecutionInput<T>(input: T): T {
  const copy = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}
// Every value goes on the card whole; the broker, not this list, decides what a card can carry.
export function approvalDraft(
  tool: ToolName | string,
  input: unknown,
  facts: RiskFacts,
  decision: RiskDecision,
  redact: (text: string) => string,
  upload?: UploadApproval,
): ApprovalRequestDraft {
  const card = buildApprovalCard(facts, decision, redact);
  const object = input as Record<string, unknown> | null;
  const fields: [string, string][] = [...card.fields];
  const add = (key: string, value: string) => fields.push([key, redact(value)]);
  if (facts.connector) {
    // An app's tool: exactly what dot would send it, every argument whole.
    add("App", facts.connector.app);
    add("Tool", facts.connector.tool);
    const args = Object.entries(object ?? {});
    const shown = args.length > ARGUMENT_ROWS ? args.slice(0, ARGUMENT_ROWS - 1) : args;
    const value = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
    for (const [key, v] of shown) add(clipText(key, 80), value(v));
    if (shown.length < args.length)
      add("More", JSON.stringify(Object.fromEntries(args.slice(shown.length)), null, 2));
    return ApprovalRequestDraft.parse({ ...card, fields });
  }
  fields.push(["Tool", tool]);
  if (facts.operation === "window" && typeof object?.action === "string")
    add("Action", object.action.replaceAll("_", " "));
  if (tool === "computer" && object?.action && typeof object.action === "object") {
    const action = object.action as Record<string, unknown>;
    const verb = String(action.verb);
    add("Action", VERBS[verb] ?? verb);
    if (Array.isArray(action.combo)) add("Keys", action.combo.join(" + "));
    if (Array.isArray(action.mods)) add("Keys held", action.mods.join(" + "));
    const at = (p: unknown) => {
      const { x, y } = p as { x: unknown; y: unknown };
      return `(${String(x)}, ${String(y)})`;
    };
    if (Array.isArray(action.path) && action.path.length >= 2) {
      add("Drag", `${at(action.path[0])} to ${at(action.path.at(-1))}`);
      if (action.path.length > 2) add("Path", `${action.path.length} points`);
    }
    // A move, scroll or release while a button is down: the drag from where it went down.
    if (action.drag && typeof action.drag === "object") {
      const { from, to } = action.drag as { from: unknown; to: unknown };
      add("Drag", `${at(from)} to ${at(to)}`);
    }
    if (["drag", "down", "up"].includes(verb)) add("Button", String(action.button ?? "left"));
    if (typeof action.repeat === "number") add("Repeat", `× ${action.repeat}`);
    if (typeof action.holdMs === "number") {
      const repeats = Array.isArray(action.combo) && repeatsWhileHeld(action.combo.map(String));
      add("Hold", `${action.holdMs / 1000} s${repeats ? " (repeats while held)" : ""}`);
    }
    if (action.point && typeof action.point === "object")
      add("Pointer", JSON.stringify(action.point));
    if (action.verb === "click")
      add("Click", `${String(action.button ?? "left")} × ${String(action.count ?? 1)}`);
    if (action.verb === "scroll") add("Scroll", `${String(action.dx)}, ${String(action.dy)}`);
    if (action.verb === "wait") add("Wait", `${String(action.ms)} ms`);
  }
  if (object && typeof object === "object") {
    for (const key of ["op", "path", "file"])
      if (typeof object[key] === "string")
        add(key === "op" ? "Operation" : "Destination", object[key]);
    if (tool === "shell" && typeof object.cwd === "string") add("Folder", object.cwd);
    if (!upload && Array.isArray(object.files)) add("Files", object.files.join("\n"));
    if (typeof object.content === "string") add("Content", object.content);
    if (typeof object.old_text === "string") add("Old text", object.old_text);
    if (typeof object.new_text === "string") add("New text", object.new_text);
    if (typeof object.text === "string" && tool === "remember") add("Memory", object.text);
    if (
      typeof object.query === "string" &&
      (tool === "recall" || tool === "people" || tool === "web_search")
    )
      add("Search", object.query);
    if (tool === "people")
      for (const [key, label] of [
        ["name", "Name"],
        ["app", "App"],
        ["handle", "Handle"],
        ["note", "Note"],
      ] as const)
        if (typeof object[key] === "string") add(label, object[key]);
  }
  return ApprovalRequestDraft.parse({
    ...card,
    fields,
    ...(upload ? { title: "Upload files", upload } : {}),
  });
}
// Known daemon credentials remain human-owned, even under a permissive editable class.
function holdsCredentials(
  ctx: ToolCallContext,
  prepared: Pick<PreparedEffect, "tool" | "input" | "target" | "facts" | "upload">,
): boolean {
  const shows = (value: unknown) => ctx.redact(JSON.stringify(value)) !== JSON.stringify(value);
  return (
    (!(prepared.tool === "done" && prepared.facts.operation === "files_read") &&
      shows(prepared.input)) ||
    shows(prepared.target) ||
    (prepared.upload !== undefined && shows(prepared.upload))
  );
}

// web_fetch and a research PDF are fetched without the user's cookies, so neither is signed in
// whichever screen is selected.
function riskFacts({ tool, facts }: Pick<PreparedEffect, "tool" | "facts">): RiskFacts {
  return (tool === "web_fetch" || tool === "research") && facts.operation === "navigate"
    ? { ...facts, signedIn: false }
    : facts;
}

// Whether authorizePrepared would let this effect run with no card and no hand-off.
export function runsUnasked(
  ctx: ToolCallContext,
  prepared: Pick<PreparedEffect, "tool" | "input" | "target" | "facts" | "upload">,
): boolean {
  return (
    decideAutonomy(ctx, riskFacts(prepared)).mode === "act" &&
    !holdsCredentials(ctx, {
      ...prepared,
      input: freezeExecutionInput(prepared.input),
      target: freezeExecutionInput(prepared.target),
    })
  );
}

export async function authorizePrepared(
  ctx: ToolCallContext,
  prepared: PreparedEffect,
): Promise<EffectPermit | undefined> {
  ctx.check();
  const input = freezeExecutionInput(prepared.input);
  const target = freezeExecutionInput(prepared.target);
  const inputDigest = actionDigest(input),
    targetDigest = actionDigest(target);
  const digest = actionDigest({ tool: prepared.tool, input, target });
  const permit = new OncePermit(digest);
  const facts = riskFacts(prepared);
  let decision = decideAutonomy(ctx, facts);
  const permission = ctx.session.permissionMode();
  const upload = prepared.upload ? UploadApproval.parse(prepared.upload) : undefined;
  if (upload && (prepared.tool !== "browser_upload" || facts.operation !== "files_upload"))
    throw new Error("Upload approval does not match this action.");
  const handOff = async (handed: RiskDecision): Promise<undefined> => {
    // No native effect has begun. Release this initiating tool's physical screen lease
    // before takeover drains all screens; the old lease can never authorize a replay.
    ctx.screen?.finish();
    const { reason, note } = handoffFor(handed, facts);
    // A held Pause refuses the hand-off before anything counts as signed in.
    if (ctx.session.safetyPause) throw new PausedStepError();
    if (reason !== "other") ctx.session.taskAutonomy.signIn(screenOf(ctx));
    await ctx.session.takeover(reason, note, ctx.step, ctx.lease);
    ctx.check();
    // Hand-back never authorizes automatic replay of the action that caused takeover.
    return undefined;
  };
  if (decision.mode === "handoff" || holdsCredentials(ctx, { ...prepared, input, target, upload }))
    return handOff(decision);
  // Others may use the computer while this step waits on a judge or the user; it takes its turn
  // back before it looks or acts again.
  const aside = <T>(work: (resume?: () => Promise<void>) => Promise<T>): Promise<T> =>
    ctx.turn ? ctx.turn.yielding(work) : work();
  if (decision.judge && ctx.session.autoPermit) {
    const { autoPermit } = ctx.session;
    const observe = prepared.observeTarget;
    const allowed = await aside((resume) =>
      autoPermit(
        {
          tool: prepared.tool,
          operation: facts.operation,
          actionClass: decision.actionClass,
          ...(decision.local ? { local: true } : {}),
          input,
          target,
          facts: actingFacts(ctx, facts),
        },
        ctx.signal,
        observe &&
          (async () => {
            await resume?.();
            return observe();
          }),
      ),
    ).then(
      (yes) => yes,
      () => undefined,
    );
    ctx.check();
    if (allowed) {
      if (!(await prepared.revalidate())) return undefined;
      ctx.check();
      decision.mode = "act";
    } else if (allowed === undefined) {
      // A judge that couldn't answer leaves the step to the user's own settings.
      decision = decideAutonomy(ctx, facts, false);
      if (decision.mode === "handoff") return handOff(decision);
    }
  }
  const purpose =
    decision.mode === "act" && permission !== "full"
      ? await aside(() => purposeCheck(ctx, prepared, input))
      : undefined;
  if (decision.mode === "ask" || purpose) {
    const draft = approvalDraft(prepared.tool, input, facts, decision, ctx.redact, upload);
    const acting = actingFacts(ctx, facts);
    const outcome = await aside((resume) =>
      ctx.session.requestApproval(
        {
          sessionId: ctx.session.id,
          cellId: ctx.session.cellId,
          generation: ctx.generation.id,
          callId: ctx.callId,
          digest,
          targetDigest,
        },
        ApprovalRequestDraft.parse(
          purpose
            ? {
                ...draft,
                title: purpose.title,
                why: purpose.why,
                ...(purpose.destinations.length
                  ? { destinations: purpose.destinations.slice(0, MAX_DESTINATIONS) }
                  : {}),
                fields: [
                  ["Destination", purpose.destinations.join("\n") || "Not named in this step"],
                  ...draft.fields,
                ],
                // A yes reaches these hosts for this task, never a kind of step. One for a host
                // nothing names covers only this step.
                always: purpose.destinations.length
                  ? alwaysOptions(decision.actionClass, acting, ctx.redact).filter(
                      (option) => option.scope === "task",
                    )
                  : [],
              }
            : { ...draft, always: alwaysOptions(decision.actionClass, acting, ctx.redact) },
        ),
        {
          signal: ctx.signal,
          check: () => ctx.check(),
          revalidate: async () => {
            await resume?.();
            ctx.check();
            const valid = await prepared.revalidate();
            ctx.check();
            return valid;
          },
          place: decision.place,
        },
      ),
    );
    ctx.check();
    if (outcome === "take_control") {
      ctx.screen?.finish();
      await ctx.session.takeover(
        "other",
        "Complete this action yourself, then hand control back.",
        ctx.step,
        ctx.lease,
        true,
      );
      ctx.check();
      return undefined;
    }
    if (outcome !== "approve") return undefined;
  }
  ctx.check();
  return Object.freeze({
    approved: decision.mode === "ask" || purpose !== undefined,
    consume(nextInput: unknown, nextTarget: unknown): boolean {
      ctx.check();
      if (actionDigest(nextInput) !== inputDigest || actionDigest(nextTarget) !== targetDigest)
        return false;
      return permit.consume(digest);
    },
  });
}
// A step the policy lets run still asks when it would carry what the task read to a host outside
// the task's purpose. Only a yes for that host covers it, never one for a kind of step.
async function purposeCheck(
  ctx: ToolCallContext,
  prepared: PreparedEffect,
  input: unknown,
): Promise<Extract<PurposeVerdict, { allow: false }> | undefined> {
  const gate = ctx.session.purpose;
  if (!gate) return undefined;
  const acting = actingFacts(ctx, prepared.facts);
  const verdict = await gate.check(outboundOf(prepared.tool, input, acting), ctx.signal);
  ctx.check();
  return verdict.allow ? undefined : verdict;
}
// The card's words for gateway verbs that are not plain English on their own.
const VERBS: Record<string, string> = {
  down: "hold down a mouse button",
  up: "release a mouse button",
  move: "move the pointer",
};
export function toolRisk(
  tool: ToolName,
  raw: unknown,
  routineName?: (routineId: string) => string | undefined,
): RiskFacts | undefined {
  const input = raw as Record<string, unknown>;
  switch (tool) {
    case "computer":
      return ["screenshot", "zoom"].includes(String(input.action))
        ? { operation: "observe" }
        : undefined;
    case "shell":
      return { operation: "shell", command: String(input.command) };
    case "files":
      return {
        operation: input.op === "read" || input.op === "list" ? "files_read" : "files_write",
      };
    case "api_request": {
      const method = String(input.method ?? "GET");
      return {
        operation: "connector",
        connector: {
          app: "Service API",
          tool: method,
          exposed: "api_request",
          host: new URL(String(input.url)).hostname,
          actionClass:
            method === "DELETE"
              ? "delete"
              : ["GET", "HEAD", "OPTIONS"].includes(method)
                ? "reading"
                : "send",
        },
      };
    }
    case "credentials":
    case "work_context":
    case "browser_read":
      return { operation: "files_read" };
    case "find":
      return { operation: "observe" };
    case "browser_navigate":
    case "web_fetch":
      return { operation: "navigate", destination: String(input.url) };
    // A search opens the first engine's results page for the query, as browser_navigate would.
    case "web_search":
      return {
        operation: "navigate",
        destination:
          searchAddresses(String(input.query), input.kind as WebSearchKind | undefined)[0]?.href ??
          "",
      };
    case "remember":
      return { operation: "memory_write" };
    case "recall":
      return { operation: "files_read" };
    case "people":
      return { operation: input.op === "save" ? "memory_write" : "files_read" };
    case "done":
      if ((input.completion as { status?: unknown } | undefined)?.status === "waiting")
        return { operation: "wait" };
      return {
        operation:
          Array.isArray(input.files) && input.files.length > 0 ? "files_write" : "files_read",
      };
    case "routine": {
      if (input.op !== "pause") return undefined;
      const id = String(input.routine_id ?? "");
      return {
        operation: "schedule",
        schedule: { title: "Pause a routine", fields: [["Routine", routineName?.(id) ?? id]] },
      };
    }
    case "research":
      return input.op === "pdf"
        ? { operation: "navigate", destination: String(input.url) }
        : input.op === "report"
          ? { operation: "files_write" }
          : undefined;
    case "follow_up_at":
      return {
        operation: "schedule",
        schedule: {
          title: "Follow up later",
          fields: [
            ["When", String(input.at).replace("T", " ")],
            ["Note", String(input.note)],
          ],
        },
      };
    default:
      return undefined; // Metadata and direct user questions grant no native execution.
  }
}
