// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { raiseChoice, raiseSteps, TaskRecovery } from "./TaskRecovery.tsx";
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
it("explains a known pause reason without printing its internal code", () => {
  render(<TaskRecovery agent={agentWith("budget")} controls={controls} onSettings={vi.fn()} />);
  const region = screen.getByRole("region", { name: "Task recovery" });
  expect([...region.querySelectorAll("p")].map((p) => p.textContent)).not.toContain("budget");
  cleanup();
  render(
    <TaskRecovery
      agent={agentWith("provider quota exhausted")}
      controls={controls}
      onSettings={vi.fn()}
    />,
  );
  expect(screen.getByText("Reported reason: provider quota exhausted")).toBeTruthy();
});

const budgetAgent = (): AgentSessionView => {
  const agent = agentWith("budget");
  return {
    ...agent,
    snapshot: agent.snapshot ? { ...agent.snapshot, status: "paused" } : null,
    model: {
      ...agent.model,
      budget: {
        id: "01JXYZ00000000000000BUDGET",
        at: 1,
        data: { scope: "task", taskId: sessionId, limitUSD: 5, spentUSD: 4, needUSD: 2 },
      },
    },
  };
};

it("raises the limit by a chosen step and continues, and checks an amount of your own", () => {
  const raiseBudget = vi.fn(async () => true);
  render(
    <TaskRecovery
      agent={budgetAgent()}
      controls={{ ...controls, canRaiseBudget: true, canResumeTask: true, raiseBudget }}
      onSettings={vi.fn()}
    />,
  );
  const region = screen.getByRole("region", { name: "Task recovery" });
  expect(region.textContent).toContain("$4 of $5 spent");
  expect(region.textContent).not.toMatch(/microdollar|ceiling/i);
  expect(screen.getByRole("meter", { name: "Spent of this task's limit" })).toBeTruthy();
  // The smallest step that covers what the next request needs is chosen first.
  fireEvent.click(screen.getByRole("button", { name: "Raise to $7 and continue" }));
  expect(raiseBudget).toHaveBeenLastCalledWith(7);
  fireEvent.click(screen.getByRole("radio", { name: "+$5" }));
  fireEvent.click(screen.getByRole("button", { name: "Raise to $10 and continue" }));
  expect(raiseBudget).toHaveBeenLastCalledWith(10);
  fireEvent.click(screen.getByRole("radio", { name: "Other" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New limit" }), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Raise and continue" }));
  expect(screen.getByText("Enter a limit above $5, up to $10,000.")).toBeTruthy();
  expect(raiseBudget).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByRole("textbox", { name: "New limit" }), {
    target: { value: "8.5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Raise to $8.50 and continue" }));
  expect(raiseBudget).toHaveBeenLastCalledWith(8.5);
});

it("offers the smallest step that covers the next request, and the one after", () => {
  expect(raiseSteps(2)).toEqual([2, 5]);
  expect(raiseSteps(3)).toEqual([5, 10]);
  expect(raiseSteps(undefined)).toEqual([5, 10]);
  expect(raiseSteps(400)).toEqual([25, 50]);
});

it("works out the new limit from a step or an amount", () => {
  expect(raiseChoice("2", "", 5)).toBe(7);
  expect(raiseChoice("other", "12.25", 5)).toBe(12.25);
  for (const custom of ["", "5", "0", "10001", "abc"])
    expect(typeof raiseChoice("other", custom, 5)).toBe("string");
});

it("starts from the first step that covers a refusal that arrives after the card", () => {
  const agent = budgetAgent();
  const later = { ...agent, model: { ...agent.model, budget: null } };
  const props = {
    controls: { ...controls, canRaiseBudget: true, canResumeTask: true },
    onSettings: vi.fn(),
  };
  const view = render(<TaskRecovery agent={later} {...props} />);
  view.rerender(<TaskRecovery agent={agent} {...props} />);
  expect(screen.getByRole("button", { name: "Raise to $7 and continue" })).toBeTruthy();
});
