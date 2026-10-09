// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { SafetyNotes } from "./SafetyNotes.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { SafetyView } from "./useSafety.ts";

afterEach(cleanup);
const line = () => document.querySelector(".ui-visually-hidden[role=status]")?.textContent;

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

it("says a task gone quiet in words that fit Watch and Replay", () => {
  const view = render(<SafetyNotes safety={safety} agent={agent} cell={null} />);
  expect(screen.getByText(/longer than usual/).textContent).toBe(
    "dot is taking longer than usual. Use Stop if it seems stuck.",
  );
  view.rerender(<SafetyNotes safety={safety} agent={agent} cell={null} replaying />);
  expect(screen.getByText(/longer than usual/).textContent).toBe(
    "The live task is taking longer than usual. Switch to Watch to stop it.",
  );
});

it("drops a decision the computer could not take as a note with a way to check again", () => {
  const checkAgain = vi.fn();
  const failed = {
    ...safety,
    allowed: null,
    dismissAllowed: vi.fn(),
    error: "Your decision could not be confirmed.",
    checkAgain,
  } as unknown as SafetyView;
  render(<SafetyNotes safety={failed} agent={agent} cell={null} />);
  const note = screen.getByRole("alert");
  expect(note.className).toContain("island-note");
  fireEvent.click(screen.getByRole("button", { name: "Check task status" }));
  expect(checkAgain).toHaveBeenCalledOnce();
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

it("confirms an Always allow choice under the island and hides it while a sheet covers it", () => {
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
  const view = render(<SafetyNotes safety={allowed} agent={confirmed} cell={null} />);
  expect(line()).toBe("Allowed for this task: sending messages.");
  expect(document.querySelector(".always-notice")?.className).toContain("island-note");
  fireEvent.click(
    screen.getByRole("button", { name: "Undo allowing sending messages for this task" }),
  );
  expect(undoAllowed).toHaveBeenCalledOnce();
  view.rerender(<SafetyNotes safety={allowed} agent={confirmed} cell={null} visible={false} />);
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
    const view = render(<SafetyNotes safety={allowed} agent={confirmed} cell={null} />);
    expect(line()).toBe("Allowed for this task: sending messages.");
    act(() => vi.advanceTimersByTime(5_000));
    view.rerender(<SafetyNotes safety={allowed} agent={confirmed} cell={null} visible={false} />);
    act(() => vi.advanceTimersByTime(2_000));
    view.rerender(<SafetyNotes safety={allowed} agent={confirmed} cell={null} />);
    expect(line()).toBe("Allowed for this task: sending messages.");
    act(() => vi.advanceTimersByTime(1_500));
    expect(dismissAllowed).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
