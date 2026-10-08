import { ApprovalRequestDraft, type ToolName, UploadApproval } from "@localdot/protocol";
import type { ToolCallContext } from "../tools/deps.ts";
import { OncePermit } from "./approvals.ts";
import {
  actionDigest,
  buildApprovalCard,
  classify,
  type RiskDecision,
  type RiskFacts,
} from "./risk.ts";

export interface EffectPermit {
  consume(input: unknown, target: unknown): boolean;
}
export interface PreparedEffect {
  readonly tool: ToolName;
  readonly input: unknown;
  readonly target: unknown;
  readonly facts: RiskFacts;
  readonly upload?: UploadApproval;
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
  tool: ToolName,
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
  fields.push(["Tool", tool]);
  if (tool === "computer" && object?.action && typeof object.action === "object") {
    const action = object.action as Record<string, unknown>;
    add("Action", String(action.verb));
    if (Array.isArray(action.combo)) add("Keys", action.combo.join(" + "));
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
  }
  return ApprovalRequestDraft.parse({
    ...card,
    fields,
    ...(upload ? { title: "Upload files", upload } : {}),
  });
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
  const decision = classify(prepared.facts, ctx.session.autonomy);
  const upload = prepared.upload ? UploadApproval.parse(prepared.upload) : undefined;
  if (upload && (prepared.tool !== "browser_upload" || prepared.facts.operation !== "files_upload"))
    throw new Error("Upload approval does not match this action.");
  // Known daemon credentials remain human-owned, even under a permissive editable class.
  const protectedInput =
    !(prepared.tool === "done" && prepared.facts.operation === "files_read") &&
    ctx.redact(JSON.stringify(input)) !== JSON.stringify(input);
  const protectedTarget = ctx.redact(JSON.stringify(target)) !== JSON.stringify(target);
  const protectedPreview = upload && ctx.redact(JSON.stringify(upload)) !== JSON.stringify(upload);
  if (decision.mode === "handoff" || protectedInput || protectedTarget || protectedPreview) {
    // No native effect has begun. Release this initiating tool's physical screen lease
    // before takeover drains all screens; the old lease can never authorize a replay.
    ctx.screen?.finish();
    await ctx.session.takeover(
      "other",
      "This action needs your control. Complete it on the computer, then hand control back.",
      ctx.step,
      ctx.lease,
    );
    ctx.check();
    // Hand-back never authorizes automatic replay of the action that caused takeover.
    return undefined;
  }
  if (decision.mode === "ask") {
    const outcome = await ctx.session.requestApproval(
      {
        sessionId: ctx.session.id,
        cellId: ctx.session.cellId,
        generation: ctx.generation.id,
        callId: ctx.callId,
        digest,
        targetDigest,
      },
      approvalDraft(prepared.tool, input, prepared.facts, decision, ctx.redact, upload),
      {
        signal: ctx.signal,
        check: () => ctx.check(),
        revalidate: async () => {
          ctx.check();
          const valid = await prepared.revalidate();
          ctx.check();
          return valid;
        },
      },
    );
    ctx.check();
    if (outcome === "take_control") {
      ctx.screen?.finish();
      await ctx.session.takeover(
        "other",
        "Complete this action yourself, then hand control back.",
        ctx.step,
        ctx.lease,
      );
      ctx.check();
      return undefined;
    }
    if (outcome !== "approve") return undefined;
  }
  ctx.check();
  const permit = new OncePermit(digest);
  return Object.freeze({
    consume(nextInput: unknown, nextTarget: unknown): boolean {
      ctx.check();
      if (actionDigest(nextInput) !== inputDigest || actionDigest(nextTarget) !== targetDigest)
        return false;
      return permit.consume(digest);
    },
  });
}
export function toolRisk(tool: ToolName, raw: unknown): RiskFacts | undefined {
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
    case "browser_read":
      return { operation: "files_read" };
    case "browser_navigate":
      return { operation: "navigate", destination: String(input.url) };
    case "remember":
      return { operation: "files_write" };
    case "done":
      return {
        operation:
          Array.isArray(input.files) && input.files.length > 0 ? "files_write" : "files_read",
      };
    default:
      return undefined; // Metadata and direct user questions grant no native execution.
  }
}
