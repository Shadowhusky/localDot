import type { ToolName } from "@localdot/protocol";

// The seam M5's autonomy levels and risk rules plug into (spec "Safety and control"): every tool
// call the brain makes passes here, in the daemon, before it touches the computer or the user's
// files. A prompt injection can make the brain ask for anything; this decides (trust rule 5).
export interface PolicyCall {
  sessionId: string;
  tool: ToolName;
  input: unknown;
  // The session has read untrusted text (a page, a file, command output) since the user last
  // spoke: M5's rules can ask for approval more readily then.
  tainted: boolean;
}

export type PolicyDecision =
  | { kind: "act" }
  | { kind: "deny"; reason: string }
  // M5: an approval card; until then, the call is refused with this reason.
  | { kind: "ask"; reason: string };

export interface ToolPolicy {
  decide(call: PolicyCall): Promise<PolicyDecision>;
}

// M4 acts on every call: risk rules, approvals and hand-offs are M5's.
export const actPolicy: ToolPolicy = { decide: async () => ({ kind: "act" }) };
