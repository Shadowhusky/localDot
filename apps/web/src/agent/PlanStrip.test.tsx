// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { type AgentModel, emptyAgentModel } from "./model.ts";
import { PlanStrip } from "./PlanStrip.tsx";
import { type PlanPhase, planPhase } from "./plan-state.ts";

afterEach(cleanup);

const plan: AgentModel["plan"] = [
  { id: "a", text: "Open the sheet", status: "done" },
  { id: "b", text: "Check the totals", status: "doing" },
  { id: "c", text: "Write the report", status: "todo" },
];

it("opens into the whole list on one card and closes on a press outside or Escape", () => {
  const { container } = render(
    <div>
      <PlanStrip plan={plan} />
      <p>Steps</p>
    </div>,
  );
  const strip = screen.getByRole("button", { name: /^Plan/ });
  fireEvent.click(strip);
  expect(strip.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelectorAll(".plan-strip-text")).toHaveLength(0);
  fireEvent.pointerDown(screen.getByText("Steps"));
  expect(strip.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(strip);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(strip.getAttribute("aria-expanded")).toBe("false");
});

it.each(["waiting", "paused", "finished", "stopped", "blocked", "error"] as PlanPhase[])(
  "never animates unfinished checklist entries while the task is %s",
  (phase) => {
    const { container } = render(<PlanStrip plan={plan} phase={phase} />);
    expect(container.querySelector('[data-state="doing"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Plan/ }));
    expect(container.querySelector('[data-state="doing"]')).toBeNull();
    expect(screen.getAllByRole("img", { name: "Done" })).toHaveLength(1);
    expect(screen.getByText("Write the report")).toBeTruthy();
  },
);

it("uses result and ownership state instead of delayed progress or unfinished plan entries", () => {
  const model = { ...emptyAgentModel(), plan, state: { state: "acting" as const } };
  expect(planPhase(model)).toBe("working");
  expect(planPhase({ ...model, pendingAsk: "question" })).toBe("waiting");
  expect(planPhase({ ...model, completion: "complete" })).toBe("finished");
  expect(planPhase({ ...model, completion: "blocked" })).toBe("blocked");
  expect(planPhase({ ...model, ended: { reason: "stopped" } })).toBe("stopped");
  expect(planPhase({ ...model, ended: { reason: "error" } })).toBe("error");
  expect(model.plan[1]?.status).toBe("doing");
});
