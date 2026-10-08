// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { TaskRecovery } from "./TaskRecovery.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { TaskControls } from "./useTaskControls.ts";

const sessionId = "01JXYZ0000000000000000SESS";
const controls = { fenced: false, canRaiseBudget: false, canResumeTask: false } as TaskControls;
const agentWith = (reason: string): AgentSessionView => ({
  sessionId,
  model: { ...emptyAgentModel(), state: { state: "paused", reason } },
  snapshot: { sessionId, cellId: "01JXYZ0000000000000000CE11", status: "running", toolCalls: 0 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile: vi.fn(),
});
afterEach(() => cleanup());

it("offers recovery for a budget pause but not for a Pause, question or approval that has settled", () => {
  for (const reason of [
    "user",
    "repeated_action",
    "question",
    "approval",
    "Waiting for explicit Resume",
  ]) {
    render(<TaskRecovery agent={agentWith(reason)} controls={controls} onSettings={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Task recovery" })).toBeNull();
    cleanup();
  }
  render(<TaskRecovery agent={agentWith("budget")} controls={controls} onSettings={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Task recovery" }).textContent).toContain(
    "spending limit",
  );
});
