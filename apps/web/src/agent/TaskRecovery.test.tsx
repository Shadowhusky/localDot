// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { raiseChoice, raiseSteps, spendingText, TaskRecovery } from "./TaskRecovery.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { TaskControls } from "./useTaskControls.ts";

const sessionId = "01JXYZ0000000000000000SESS";
const controls = { fenced: false, canRaiseBudget: false, canResumeTask: false } as TaskControls;
const agentWith = (reason: string, detail?: string): AgentSessionView => ({
  sessionId,
  model: {
    ...emptyAgentModel(),
    state: { state: "paused", reason, ...(detail ? { detail } : {}) },
  },
  snapshot: { sessionId, cellId: "01JXYZ0000000000000000CE11", status: "running", toolCalls: 0 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile: vi.fn(),
});
afterEach(() => cleanup());

it("continues with the selected replacement model instead of resuming the limited model", async () => {
  const resume = vi.fn(async () => true);
  const replacement = vi.fn(async () => true);
  render(
    <TaskRecovery
      agent={agentWith("chatgpt plan limit reached")}
      controls={{ ...controls, canResumeTask: true, resume }}
      onSettings={vi.fn()}
      onResumeSelected={replacement}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(replacement).toHaveBeenCalledTimes(1);
  expect(resume).not.toHaveBeenCalled();
});

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
  expect(region.textContent).toContain(
    "dot's next step could cost up to $2, and $1 of this task's limit is left.",
  );
  expect(region.textContent).not.toMatch(/microdollar|ceiling|reached/i);
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

it("says why the limit stopped dot: a next step that needs more than is left, or nothing left", () => {
  expect(spendingText({ scope: "task", limitUSD: 5, spentUSD: 4.5, needUSD: 1.25 })).toBe(
    "dot's next step could cost up to $1.25, and $0.50 of this task's limit is left. Raise the limit to continue; what was spent stays counted.",
  );
  expect(spendingText({ scope: "task", limitUSD: 5, spentUSD: 5.01 })).toBe(
    "dot has spent all of this task's limit. Raise the limit to continue; what was spent stays counted.",
  );
  expect(spendingText({ scope: "day", limitUSD: 20, spentUSD: 19.8, needUSD: 0.4 })).toBe(
    "dot's next step could cost up to $0.40, and $0.20 of today's limit is left.",
  );
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

describe("never silent: a line from dot and the one action that fixes it", () => {
  const stalled = (state: "paused" | "idle" | "error", reason: string, detail?: string) => {
    const agent = agentWith(reason);
    return {
      ...agent,
      snapshot: agent.snapshot
        ? { ...agent.snapshot, status: state === "idle" ? "idle" : "paused" }
        : null,
      model: { ...agent.model, state: { state, reason, ...(detail ? { detail } : {}) } },
    } as AgentSessionView;
  };
  it("offers Retry now while dot waits on a busy model", () => {
    const resume = vi.fn(async () => true);
    render(
      <TaskRecovery
        agent={stalled("paused", "model busy")}
        controls={{ ...controls, canResumeTask: true, resume }}
        onSettings={vi.fn()}
      />,
    );
    const region = screen.getByRole("region", { name: "Task recovery" });
    expect(region.textContent).toContain("The model is busy");
    expect(screen.queryByRole("button", { name: "Change model" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(resume).toHaveBeenCalledOnce();
  });
  it("says what the model said when it turned dot down, with Retry now and Change model", () => {
    const onSettings = vi.fn();
    render(
      <TaskRecovery
        agent={stalled("paused", "model refused", "400: image input is not supported")}
        controls={{ ...controls, canResumeTask: true, resume: vi.fn(async () => true) }}
        onSettings={onSettings}
      />,
    );
    expect(screen.getByText("The model said: 400: image input is not supported")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change model" }));
    expect(onSettings).toHaveBeenCalledWith(expect.any(HTMLButtonElement), "models");
    expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
  });
  it("continues a task the action limit stopped with a message, and says if it didn't go through", async () => {
    const onContinue = vi.fn(async () => false);
    render(
      <TaskRecovery
        agent={stalled("idle", "action limit")}
        controls={controls}
        onSettings={vi.fn()}
        onContinue={onContinue}
      />,
    );
    expect(screen.getByRole("region", { name: "Task recovery" }).textContent).toContain(
      "I reached your action limit",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
  it("stays out of the way while dot starts again by itself", () => {
    render(
      <TaskRecovery
        agent={stalled("error", "the brain stopped; restarting from saved history")}
        controls={controls}
        onSettings={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "Task recovery" })).toBeNull();
  });
});

it("offers to carry on a task localDot went away under, and says when that can't happen yet", async () => {
  const interrupted: AgentSessionView = {
    ...agentWith("user"),
    interrupted: true,
    model: { ...emptyAgentModel(), state: { state: "acting" }, ended: { reason: "stopped" } },
    snapshot: { sessionId, cellId: "01JXYZ0000000000000000CE11", status: "ended", toolCalls: 0 },
  };
  const view = render(
    <TaskRecovery agent={interrupted} controls={controls} onSettings={vi.fn()} />,
  );
  const region = screen.getByRole("region", { name: "Task recovery" });
  expect(region.querySelector("h3")?.textContent).toBe("I was cut off before I finished");
  expect(screen.getByRole("button", { name: "Continue" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  const carryOn = vi.fn(async () => true);
  view.rerender(
    <TaskRecovery
      agent={interrupted}
      controls={controls}
      onSettings={vi.fn()}
      onCarryOn={carryOn}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(carryOn).toHaveBeenCalledOnce();
  view.rerender(
    <TaskRecovery
      agent={{ ...interrupted, interrupted: false }}
      controls={controls}
      onSettings={vi.fn()}
      onCarryOn={carryOn}
    />,
  );
  expect(screen.queryByRole("region", { name: "Task recovery" })).toBeNull();
});

it("names the key to enter again and opens Keys at it, with Continue for after", () => {
  const onReenterKey = vi.fn();
  const resume = vi.fn(async () => true);
  const agent = agentWith("key needs re-entering", "deepseek");
  render(
    <TaskRecovery
      agent={agent}
      controls={{ ...controls, canResumeTask: true, resume }}
      onSettings={vi.fn()}
      onReenterKey={onReenterKey}
    />,
  );
  const region = screen.getByRole("region", { name: "Task recovery" });
  expect(screen.getByRole("heading", { name: "Re-enter your deepseek key" })).toBeTruthy();
  expect(region.textContent).toContain("Enter it again in Keys, then continue.");
  expect(region.textContent).not.toContain("Reported reason");
  const reenter = screen.getByRole("button", { name: "Re-enter key" });
  expect(reenter.getAttribute("data-variant")).toBe("primary");
  fireEvent.click(reenter);
  expect(onReenterKey).toHaveBeenCalledWith(reenter, "deepseek");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(resume).toHaveBeenCalled();
});

// Entering the key again would store the real key for the changed destination, so the card offers
// Keys, where the key is removed and added again, and never Re-enter.
it("names a key changed outside localDot and opens Keys, never re-entry", () => {
  const onReenterKey = vi.fn();
  const onSettings = vi.fn();
  render(
    <TaskRecovery
      agent={agentWith("key changed outside localDot", "deepseek")}
      controls={{ ...controls, canResumeTask: true }}
      onSettings={onSettings}
      onReenterKey={onReenterKey}
    />,
  );
  const region = screen.getByRole("region", { name: "Task recovery" });
  expect(
    screen.getByRole("heading", { name: "Your deepseek key was changed outside localDot" }),
  ).toBeTruthy();
  expect(region.textContent).toContain("Remove it in Keys and add it again");
  expect(screen.queryByRole("button", { name: "Re-enter key" })).toBeNull();
  const keys = screen.getByRole("button", { name: "Open Keys" });
  expect(keys.getAttribute("data-variant")).toBe("primary");
  fireEvent.click(keys);
  expect(onSettings).toHaveBeenCalledWith(keys, "keys");
  expect(onReenterKey).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Continue" }).getAttribute("data-variant")).toBe(
    "secondary",
  );
});

it.each(["provider limit reached", "chatgpt plan limit reached", "claude code plan limit reached"])(
  "explains %s and offers another model",
  (reason) => {
    render(
      <TaskRecovery
        agent={agentWith(reason, "Usage resets later today.")}
        controls={controls}
        onSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole("region", { name: "Task recovery" }).textContent).toMatch(
      /credit|plan/,
    );
    expect(screen.getByText("The model said: Usage resets later today.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change model" })).toBeTruthy();
  },
);
