// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { SafetyControls } from "./SafetyControls.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { SafetyView } from "./useSafety.ts";

afterEach(cleanup);
const line = () => document.querySelector(".sr-only[role=status]")?.textContent;

const sessionId = "01J00000000000000000000002";
const cellId = "01J00000000000000000000001";
const agent: AgentSessionView = {
  sessionId,
  model: {
    ...emptyAgentModel(),
    state: { state: "acting" },
    lastHeartbeat: { t: 0, everyMs: 500, ongoing: true, receivedAt: performance.now() - 5000 },
  } as AgentSessionView["model"],
  snapshot: { sessionId, cellId, status: "running", toolCalls: 0 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile: vi.fn(),
};
const safety = {
  approval: null,
  pause: null,
  canPause: true,
  canResume: false,
  canReplace: false,
  canNotify: false,
  error: null,
  replacement: null,
  replacing: false,
  requestPause: vi.fn(),
} as unknown as SafetyView;

it("keeps the live task's Pause and Stop guidance out of Replay", () => {
  const view = render(<SafetyControls safety={safety} agent={agent} cell={null} />);
  expect(screen.getByRole("button", { name: "Pause after this step" })).toBeTruthy();
  expect(screen.getByText("Stop: Ctrl/Cmd + Shift + .")).toBeTruthy();
  expect(screen.getByText(/heartbeat is late/).textContent).toContain("use Stop");
  view.rerender(<SafetyControls safety={safety} agent={agent} cell={null} replaying />);
  expect(screen.queryByRole("button", { name: "Pause after this step" })).toBeNull();
  expect(screen.queryByText("Stop: Ctrl/Cmd + Shift + .")).toBeNull();
  expect(screen.getByText(/heartbeat is late/).textContent).toBe(
    "The live task's heartbeat is late. Switch to Watch if you want to stop it.",
  );
});

it("drops Pause and the Stop shortcut once the task has finished", () => {
  const idle = { ...agent, snapshot: { sessionId, cellId, status: "idle" as const, toolCalls: 0 } };
  render(<SafetyControls safety={{ ...safety, canPause: false }} agent={idle} cell={null} />);
  expect(screen.queryByRole("button", { name: "Pause after this step" })).toBeNull();
  expect(screen.queryByText("Stop: Ctrl/Cmd + Shift + .")).toBeNull();
});

const ID = "01J00000000000000000000003";
const card = {
  approvalId: ID,
  generation: 1,
  revision: 1,
  expiresAt: Date.now() + 60_000,
  actionClass: "send" as const,
  risk: "high" as const,
  title: "Send as you",
  fields: [] as [string, string][],
  always: [{ scope: "task" as const, label: "For this task" }],
};

it("puts Always allow in the approval card and confirms the choice after it", () => {
  const answerApproval = vi.fn(async () => true);
  const deciding = { ...safety, approval: card, canApprove: true, answerApproval, allowed: null };
  const view = render(<SafetyControls safety={deciding} agent={agent} cell={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Always allow…" }));
  fireEvent.click(screen.getByRole("button", { name: "For this task" }));
  expect(answerApproval).toHaveBeenCalledWith({
    approvalId: ID,
    generation: 1,
    revision: 1,
    decision: "approve",
    always: "task",
  });
  const undoAllowed = vi.fn(async () => true);
  const allowed = {
    ...safety,
    undoAllowed,
    dismissAllowed: vi.fn(),
    allowed: {
      session: sessionId,
      approvalId: ID,
      actionClass: "send" as const,
      option: card.always[0],
      undo: "idle" as const,
    },
  } as unknown as SafetyView;
  const confirmed = {
    ...agent,
    model: {
      ...agent.model,
      approvalOutcome: {
        approvalId: ID,
        decision: "approve" as const,
        actionClass: "send" as const,
        rule: { scope: "task" as const, label: "For this task", actionClass: "send" as const },
      },
    },
  };
  view.rerender(<SafetyControls safety={allowed} agent={confirmed} cell={null} />);
  expect(screen.queryByRole("button", { name: "Always allow…" })).toBeNull();
  expect(line()).toBe("Allowed for this task: sending messages.");
  fireEvent.click(
    screen.getByRole("button", { name: "Undo allowing sending messages for this task" }),
  );
  expect(undoAllowed).toHaveBeenCalledOnce();
  view.rerender(<SafetyControls safety={allowed} agent={confirmed} cell={null} visible={false} />);
  expect(line()).toBe("");
  expect(document.querySelector(".always-notice")).toBeNull();
});

it("keeps the status line's time running while Settings is open", () => {
  vi.useFakeTimers();
  try {
    const dismissAllowed = vi.fn();
    const allowed = {
      ...safety,
      undoAllowed: vi.fn(),
      dismissAllowed,
      allowed: {
        session: sessionId,
        approvalId: ID,
        actionClass: "send" as const,
        option: card.always[0],
        undo: "idle" as const,
      },
    } as unknown as SafetyView;
    const confirmed = {
      ...agent,
      model: {
        ...agent.model,
        approvalOutcome: {
          approvalId: ID,
          decision: "approve" as const,
          actionClass: "send" as const,
          rule: { scope: "task" as const, label: "For this task", actionClass: "send" as const },
        },
      },
    };
    const view = render(<SafetyControls safety={allowed} agent={confirmed} cell={null} />);
    expect(line()).toBe("Allowed for this task: sending messages.");
    act(() => vi.advanceTimersByTime(3_000));
    view.rerender(
      <SafetyControls safety={allowed} agent={confirmed} cell={null} visible={false} />,
    );
    act(() => vi.advanceTimersByTime(10_000));
    expect(dismissAllowed).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["ready", {}, {}, true],
  ["the task cannot take a decision", { canApprove: false }, {}, false],
  ["a decision is being sent", { pending: "approval" }, {}, false],
  ["Settings or Keys is open", {}, { visible: false }, false],
  ["the card has expired", { approval: { ...card, expiresAt: Date.now() - 1 } }, {}, false],
])("lets Always allow approve only while Approve once can, when %s", (_name, over, props, can) => {
  const answerApproval = vi.fn(async () => true);
  const deciding = {
    ...safety,
    approval: card,
    canApprove: true,
    pending: null,
    answerApproval,
    allowed: null,
    ...over,
  } as unknown as SafetyView;
  render(<SafetyControls safety={deciding} agent={agent} cell={null} {...props} />);
  const button = (name: string) =>
    screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;
  expect(button("Approve once").disabled).toBe(!can);
  expect(button("Always allow…").disabled).toBe(!can);
  const option = button("For this task");
  expect(option.disabled).toBe(!can);
  fireEvent.click(option);
  expect(answerApproval).toHaveBeenCalledTimes(can ? 1 : 0);
});
