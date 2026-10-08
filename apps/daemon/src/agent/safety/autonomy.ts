import {
  type ActionClass,
  type AutonomyMode,
  AutonomyPolicy,
  type ScreenName,
} from "@localdot/protocol";
import type { ToolCallContext } from "../tools/deps.ts";
import { classify } from "./classify.ts";
import type { RiskDecision, RiskFacts } from "./risk.ts";

const MODE_RANK = { act: 0, ask: 1, handoff: 2 } as const;
const DESKTOP_ONLY = new Set<RiskFacts["operation"]>(["shell", "files_write", "files_delete"]);
const RISK_RANK = { none: 0, medium: 1, high: 2 } as const;

function mode(actionClass: ActionClass, policy: AutonomyPolicy): AutonomyMode {
  if (actionClass === "credentials") return "handoff";
  if (actionClass === "unknown") return "ask";
  if (actionClass === "upload") return policy.send === "handoff" ? "handoff" : "ask";
  return policy[actionClass];
}

function risk(actionClass: ActionClass): RiskDecision["risk"] {
  if (["reading", "browsing", "computer"].includes(actionClass)) return "none";
  return actionClass === "unknown" || actionClass === "memory" ? "medium" : "high";
}

export function decide(facts: RiskFacts, rawPolicy: AutonomyPolicy): RiskDecision {
  const policy = AutonomyPolicy.parse(rawPolicy);
  return classify(facts)
    .map((actionClass) => ({
      actionClass,
      mode: mode(actionClass, policy),
      risk: risk(actionClass),
    }))
    .reduce((best, next) =>
      MODE_RANK[next.mode] > MODE_RANK[best.mode] ||
      (next.mode === best.mode && RISK_RANK[next.risk] > RISK_RANK[best.risk])
        ? next
        : best,
    );
}

export function screenOf(ctx: ToolCallContext): ScreenName {
  return ctx.screen?.selection.screen ?? ctx.session.screens?.selection.screen ?? "desktop";
}

// Commands and file changes run on the desktop whichever screen is selected.
export function decideAutonomy(ctx: ToolCallContext, facts: RiskFacts): RiskDecision {
  const screen = DESKTOP_ONLY.has(facts.operation) ? "desktop" : screenOf(ctx);
  return decide(
    { ...facts, screen, signedIn: ctx.session.taskAutonomy.signedIn(screen) },
    ctx.session.autonomy,
  );
}
