import {
  type AutonomyPolicy,
  freezeAutonomy,
  type RoutineProfile,
  type SessionRun,
} from "@localdot/protocol";
import type { PolicyCall, ToolPolicy } from "../agent/policy.ts";

const LOOKING = new Set(["screenshot", "zoom", "cursor_position", "scroll", "wait", "move"]);
const LOOKING_STEPS = new Set(["scroll", "wait", "move"]);
export const WRAP_UP =
  "nobody approved the last step in time. Do not try anything else: call done now with a short summary of what you did and what is left";

/** Routine runs whose approval window ran out: they may only wrap up. */
export class ExpiredRuns {
  readonly #ids = new Set<string>();
  mark(sessionId: string): void {
    this.#ids.add(sessionId);
  }
  has(sessionId: string): boolean {
    return this.#ids.has(sessionId);
  }
  release(sessionId: string): void {
    this.#ids.delete(sessionId);
  }
}

export function readOnlyAllows(call: Pick<PolicyCall, "tool" | "input">): boolean {
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.tool) {
    case "computer": {
      if (input.action !== "batch") return LOOKING.has(String(input.action));
      const steps = Array.isArray(input.steps) ? (input.steps as { action?: unknown }[]) : [];
      return steps.length > 0 && steps.every((step) => LOOKING_STEPS.has(String(step.action)));
    }
    case "files":
      return input.op === "read" || input.op === "list";
    case "browser_navigate":
    case "browser_read":
    case "web_search":
    case "web_fetch":
    case "find":
    case "switch_screen":
    case "update_plan":
    case "remember":
    case "done":
      return true;
    default:
      return false;
  }
}

/** Only ever refuses: the dispatcher's own risk classification still runs after it. */
export function routinePolicy(deps: {
  runOf(sessionId: string): SessionRun | undefined;
  expired: Pick<ExpiredRuns, "has">;
  inner?: ToolPolicy;
}): ToolPolicy {
  return {
    async decide(call) {
      const run = deps.runOf(call.sessionId);
      if (run) {
        if (deps.expired.has(call.sessionId) && call.tool !== "done" && call.tool !== "update_plan")
          return { kind: "deny", reason: WRAP_UP };
        if (run.profile === "read_only" && !readOnlyAllows(call))
          return {
            kind: "deny",
            reason: `this routine is read-only, so ${call.tool} is not allowed`,
          };
      }
      return deps.inner ? deps.inner.decide(call) : { kind: "act" };
    },
  };
}

const CONSEQUENTIAL = [
  "purchase",
  "send",
  "post",
  "delete",
  "download_execute",
  "system_settings",
] as const;

/** Consequential classes the user lets dot do become Ask; stricter choices stay as they are. */
export function askFirst(policy: AutonomyPolicy): AutonomyPolicy {
  const next: Record<string, unknown> = { ...policy };
  for (const actionClass of CONSEQUENTIAL)
    if (next[actionClass] === "act") next[actionClass] = "ask";
  return freezeAutonomy(next);
}

export function autonomyFor(profile: RoutineProfile, user: AutonomyPolicy): AutonomyPolicy {
  return profile === "act_within_rules" ? freezeAutonomy({ ...user }) : askFirst(user);
}
