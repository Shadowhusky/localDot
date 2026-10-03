// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { PlanRail } from "./PlanRail.tsx";

afterEach(cleanup);

const api = createApi("test", { origin: "http://localhost" });
const step = (
  id: string,
  startT: number,
  status: StepRowView["status"] = "doing",
): StepRowView => ({
  id,
  startT,
  label: id,
  status,
  durationMs: null,
});
const use = (t: number) => ({
  id: `key-${t}`,
  t,
  secretId: "weather",
  host: "api.weather.example",
  method: "GET",
  path: "/now",
  decision: "allow" as const,
});

describe("PlanRail", () => {
  it("preserves the last doing step highlight when key uses follow it", () => {
    render(
      <PlanRail
        rows={timelineRows([step("s1", 1), step("s2", 3)], [use(2), use(4)])}
        sessionId="session"
        scale={1}
        api={api}
        title="Plan"
      />,
    );
    const steps = screen.getAllByTestId("step-row");
    expect(steps.map((el) => el.classList.contains("now"))).toEqual([false, true]);
    expect(screen.getAllByTestId("key-use")).toHaveLength(2);
    expect(
      [...document.querySelectorAll(".steps > div")].map((el) => el.getAttribute("data-testid")),
    ).toEqual(["step-row", "key-use", "step-row", "key-use"]);
  });

  it("does not highlight an older doing step when the latest step finished", () => {
    const { container } = render(
      <PlanRail
        rows={timelineRows([step("s1", 1), step("s2", 3, "ok")], [use(4)])}
        sessionId="session"
        scale={1}
        api={api}
        title={null}
      />,
    );
    expect(container.querySelector(".step.now")).toBeNull();
  });

  it("shows a key-only timeline but keeps the empty state without a session", () => {
    const rows = timelineRows<StepRowView>([], [use(1)]);
    const { rerender } = render(
      <PlanRail rows={rows} sessionId="session" scale={1} api={api} title={null} />,
    );
    expect(screen.queryByTestId("step-row")).toBeNull();
    expect(screen.getByTestId("key-use")).toBeTruthy();
    rerender(<PlanRail rows={rows} sessionId={null} scale={1} api={api} title={null} />);
    expect(screen.queryByTestId("key-use")).toBeNull();
    expect(screen.getByText("Steps appear here as dot works.")).toBeTruthy();
  });
});
