import { MCP_SERVER_NAME } from "./args.ts";

// Structural compatibility with the daemon's owned BrainGeneration; no separate generation.
export interface ApprovalBrainGeneration {
  readonly id: number;
  readonly signal: AbortSignal;
}
export interface CodexTurnEpoch {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly basisFrameId: string;
}
export interface ApprovalIdentity {
  readonly generation: ApprovalBrainGeneration;
  readonly authGeneration: number;
  readonly turn: CodexTurnEpoch;
  readonly mainThreadId: string | undefined;
  readonly turnId: string | undefined;
  readonly controlHeld: boolean;
}
export interface ApprovalContext {
  readonly captured: ApprovalIdentity;
  // Trusted owner/controller view, never derived from the server's claimed metadata.
  readonly current: () => ApprovalIdentity | undefined;
}
export interface BlockedStep {
  kind: "shell" | "file" | "ask" | "think";
  tool: string;
  note: string;
}
export type ServerRequestDecision =
  | { verdict: "approved" | "declined"; result: unknown; blocked?: BlockedStep }
  | { verdict: "declined"; error: { code: number; message: string }; blocked?: BlockedStep };
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const DENY_LABELS = new Set(["cancel", "deny", "decline", "reject", "no"]);
const approvals = new WeakMap<
  ServerRequestDecision,
  { captured: ApprovalIdentity; current: ApprovalContext["current"] }
>();
function valid(identity: ApprovalIdentity): boolean {
  return (
    Number.isSafeInteger(identity.authGeneration) &&
    identity.authGeneration >= 0 &&
    Number.isSafeInteger(identity.generation.id) &&
    identity.generation.id > 0 &&
    identity.generation.signal instanceof AbortSignal &&
    !identity.generation.signal.aborted &&
    Number.isSafeInteger(identity.turn.id) &&
    identity.turn.id > 0 &&
    identity.turn.signal instanceof AbortSignal &&
    !identity.turn.signal.aborted &&
    typeof identity.turn.basisFrameId === "string" &&
    identity.turn.basisFrameId.length > 0 &&
    typeof identity.mainThreadId === "string" &&
    identity.mainThreadId.length > 0 &&
    typeof identity.turnId === "string" &&
    identity.turnId.length > 0 &&
    identity.controlHeld === false
  );
}
function currentMatches(captured: ApprovalIdentity, current: ApprovalContext["current"]): boolean {
  try {
    const live = current();
    return (
      live !== undefined &&
      valid(captured) &&
      valid(live) &&
      live.generation === captured.generation &&
      live.authGeneration === captured.authGeneration &&
      live.turn === captured.turn &&
      live.mainThreadId === captured.mainThreadId &&
      live.turnId === captured.turnId
    );
  } catch {
    return false;
  }
}
// The RPC owner must recheck immediately before writing the response. Clones/forgeries have
// no authority, and replacing the caller's capture cannot revive an already issued decision.
export function isApprovalCurrent(decision: ServerRequestDecision): boolean {
  const authority = approvals.get(decision);
  return authority !== undefined && currentMatches(authority.captured, authority.current);
}
export function explicitDefaults(schema: unknown): Json {
  const out: Json = Object.create(null);
  try {
    if (!object(schema) || schema.type !== "object" || !object(schema.properties)) return out;
    const entries = Object.entries(schema.properties);
    if (entries.length > 128) return out;
    for (const [key, prop] of entries) {
      if (!object(prop) || !Object.hasOwn(prop, "default")) continue;
      const value = prop.default;
      const allowed =
        (prop.type === "string" && typeof value === "string" && value.length <= 8192) ||
        (prop.type === "boolean" && value === false) ||
        ((prop.type === "number" || prop.type === "integer") &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          (prop.type !== "integer" || Number.isInteger(value)));
      if (!allowed) continue;
      if (Array.isArray(prop.enum) && !prop.enum.includes(value)) continue;
      if (Object.hasOwn(prop, "const") && prop.const !== value) continue;
      out[key] = value;
    }
  } catch {
    return Object.create(null) as Json;
  }
  return out;
}
function denyAnswer(options: unknown): string[] {
  if (!Array.isArray(options) || options.length > 64) return [];
  for (const option of options)
    if (
      object(option) &&
      typeof option.label === "string" &&
      DENY_LABELS.has(option.label.trim().toLowerCase())
    )
      return [option.label];
  return [];
}
export function decideServerRequest(
  method: string,
  params: unknown,
  ctx: ApprovalContext,
): ServerRequestDecision {
  const p = object(params) ? params : {};
  switch (method) {
    case "item/commandExecution/requestApproval":
      return {
        verdict: "declined",
        result: { decision: "decline" },
        blocked: { kind: "shell", tool: "codex.command", note: "Codex commands are disabled." },
      };
    case "item/fileChange/requestApproval":
      return {
        verdict: "declined",
        result: { decision: "decline" },
        blocked: {
          kind: "file",
          tool: "codex.apply_patch",
          note: "Codex file edits are disabled.",
        },
      };
    case "item/permissions/requestApproval":
      return {
        verdict: "declined",
        result: { permissions: {}, scope: "turn" },
        blocked: {
          kind: "think",
          tool: "codex.permissions",
          note: "No additional permissions were granted.",
        },
      };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { verdict: "declined", result: { decision: "denied" } };
    case "mcpServer/elicitation/request": {
      const decline: ServerRequestDecision = { verdict: "declined", result: { action: "decline" } };
      try {
        const captured = Object.freeze({ ...ctx.captured }),
          current = ctx.current.bind(ctx);
        if (!currentMatches(captured, current)) return decline;
        const meta = object(p._meta) ? p._meta : {};
        if (
          p.serverName !== MCP_SERVER_NAME ||
          p.threadId !== captured.mainThreadId ||
          p.turnId !== captured.turnId ||
          p.mode !== "form" ||
          meta.codex_approval_kind !== "mcp_tool_call" ||
          !object(p.requestedSchema) ||
          p.requestedSchema.type !== "object"
        )
          return decline;
        const content = explicitDefaults(p.requestedSchema);
        if (!currentMatches(captured, current)) return decline;
        const decision: ServerRequestDecision = Object.freeze({
          verdict: "approved",
          result: Object.freeze({ action: "accept", content: Object.freeze(content) }),
        });
        approvals.set(decision, { captured, current });
        return decision;
      } catch {
        return decline;
      }
    }
    case "item/tool/requestUserInput": {
      const answers: Record<string, { answers: string[] }> = Object.create(null);
      const questions = Array.isArray(p.questions) && p.questions.length <= 128 ? p.questions : [];
      for (const question of questions)
        if (
          object(question) &&
          typeof question.id === "string" &&
          question.id.length <= 1024 &&
          !Object.hasOwn(answers, question.id)
        )
          answers[question.id] = { answers: denyAnswer(question.options) };
      return {
        verdict: "declined",
        result: { answers },
        blocked: {
          kind: "ask",
          tool: "codex.request_user_input",
          note: "Questions are handled through localDot's Ask tool.",
        },
      };
    }
    case "item/tool/call":
      return {
        verdict: "declined",
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "localDot has no dynamic tools. Use localDot's tools (mcp__localdot__…) instead.",
            },
          ],
        },
      };
    default:
      return {
        verdict: "declined",
        error: { code: -32601, message: "localDot does not handle this Codex request." },
      };
  }
}
