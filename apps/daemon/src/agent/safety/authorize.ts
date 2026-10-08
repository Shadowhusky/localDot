import { ApprovalCardDraft, type ToolName, UploadApproval } from "@localdot/protocol";
import type { ToolCallContext } from "../tools/deps.ts";
import { OncePermit } from "./approvals.ts";
import { actionDigest, buildApprovalCard, classify, type RiskFacts } from "./risk.ts";

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
function boundedPreview(value: string, ctx: ToolCallContext): string {
  const safe = ctx.redact(value);
  let text = "";
  for (const character of safe) {
    if (text.length + character.length > 512) break;
    text += character;
  }
  return text;
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
    const card = buildApprovalCard(prepared.facts, decision, ctx.redact);
    const object = input as Record<string, unknown> | null;
    const fields: [string, string][] = [...card.fields];
    fields.push(["Tool", prepared.tool]);
    if (prepared.tool === "computer" && object?.action && typeof object.action === "object") {
      const action = object.action as Record<string, unknown>;
      fields.push(["Action", boundedPreview(String(action.verb), ctx)]);
      if (Array.isArray(action.combo))
        fields.push(["Keys", boundedPreview(action.combo.join(" + "), ctx)]);
      if (action.point && typeof action.point === "object")
        fields.push(["Pointer", boundedPreview(JSON.stringify(action.point), ctx)]);
      if (action.verb === "click")
        fields.push([
          "Click",
          boundedPreview(`${String(action.button ?? "left")} × ${String(action.count ?? 1)}`, ctx),
        ]);
      if (action.verb === "scroll")
        fields.push(["Scroll", boundedPreview(`${String(action.dx)}, ${String(action.dy)}`, ctx)]);
      if (action.verb === "wait")
        fields.push(["Wait", boundedPreview(`${String(action.ms)} ms`, ctx)]);
    }

    if (object && typeof object === "object") {
      for (const key of ["op", "path", "file"])
        if (typeof object[key] === "string")
          fields.push([
            key === "op" ? "Operation" : "Destination",
            boundedPreview(object[key], ctx),
          ]);
      if (!upload && Array.isArray(object.files))
        fields.push(["Files", boundedPreview(object.files.join("\n"), ctx)]);
      if (typeof object.content === "string")
        fields.push(["Content", boundedPreview(object.content, ctx)]);
      if (typeof object.new_text === "string")
        fields.push(["New text", boundedPreview(object.new_text, ctx)]);
      if (typeof object.text === "string" && prepared.tool === "remember")
        fields.push(["Memory", boundedPreview(object.text, ctx)]);
    }
    const outcome = await ctx.session.requestApproval(
      {
        sessionId: ctx.session.id,
        cellId: ctx.session.cellId,
        generation: ctx.generation.id,
        callId: ctx.callId,
        digest,
        targetDigest,
      },
      ApprovalCardDraft.parse({
        ...card,
        fields,
        ...(upload ? { title: "Upload files", upload } : {}),
      }),
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
