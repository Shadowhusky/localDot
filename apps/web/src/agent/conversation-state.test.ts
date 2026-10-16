import { expect, it } from "vitest";
import { conversationBlockReason } from "./conversation-state.ts";
import { emptyAgentModel } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

const running = (): AgentSessionView => ({
  sessionId: "session",
  model: emptyAgentModel(),
  snapshot: { sessionId: "session", cellId: "computer", status: "running", toolCalls: 1 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile() {},
});
const reason = (agent: AgentSessionView) =>
  conversationBlockReason(agent, false, false, false, false);
it("lets a completed result request conversation release while caller retirement finishes", () => {
  const agent = running();
  if (!agent.snapshot) throw new Error("fixture snapshot missing");
  expect(reason(agent)).toBe("Finish or stop the current task first.");
  expect(reason({ ...agent, model: { ...agent.model, completion: "complete" } })).toBeUndefined();
  expect(reason({ ...agent, fresh: false })).toBeUndefined();
});
it("never treats final prose, a question or held control as permission to leave live work", () => {
  const agent = running();
  const snapshot = agent.snapshot;
  if (!snapshot) throw new Error("fixture snapshot missing");
  expect(
    reason({
      ...agent,
      model: {
        ...agent.model,
        messages: new Map([["m", { id: "m", role: "assistant", text: "Done.", final: true }]]),
      },
    }),
  ).toBeDefined();
  for (const state of [
    { pendingAsk: "ask" },
    { pendingTakeover: "take" },
    { holder: true as const },
  ])
    expect(
      reason({
        ...agent,
        model: { ...agent.model, completion: "complete" },
        snapshot: { ...snapshot, ...state },
      }),
    ).toBeDefined();
  expect(conversationBlockReason(agent, true, false, false, false)).toBeUndefined();
});
