// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentStep, emptyAgentModel } from "../agent/model.ts";
import { appendTerminal, emptyTerminal } from "../agent/terminal-text.ts";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { ActivityRail } from "./ActivityRail.tsx";

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
  durationMs: status === "doing" ? null : 400,
});
const use = (t: number, decision: "allow" | "deny" = "allow") => ({
  id: `key-${t}`,
  t,
  secretId: "weather",
  host: "api.weather.example",
  method: "GET",
  path: "/now",
  decision,
});
const tool = (id: string, planItem: string, at: number, extra: Partial<AgentStep> = {}) =>
  [
    id,
    {
      id,
      kind: "shell" as const,
      planItem,
      startedAt: at * 1000,
      endedAt: at * 1000 + 500_000,
      status: "ok" as const,
      tool: { name: "shell", title: `Run ${id}`, ok: true, exitCode: 0 },
      output: [],
      outputTruncated: false,
      ...extra,
    },
  ] as const;

describe("ActivityRail", () => {
  it("marks the live step and folds allowed key uses into the steps they follow", () => {
    render(
      <ActivityRail
        rows={timelineRows([step("s1", 1, "ok"), step("s2", 3)], [use(2), use(4)])}
        sessionId="session"
        scale={1}
        api={api}
      />,
    );
    const steps = screen.getAllByTestId("step-row");
    expect(steps.map((row) => row.hasAttribute("data-current"))).toEqual([false, true]);
    expect(screen.queryAllByTestId("key-use")).toHaveLength(0);
    fireEvent.click(within(steps[0] as HTMLElement).getByRole("button", { name: /s1/ }));
    expect(screen.getByRole("list", { name: "Keys used" }).textContent).toContain(
      "Used weather key → api.weather.example",
    );
  });

  it("marks no step live once the latest one has finished", () => {
    const { container } = render(
      <ActivityRail
        rows={timelineRows([step("s1", 1), step("s2", 3, "ok")], [use(4)])}
        sessionId="session"
        scale={1}
        api={api}
      />,
    );
    expect(container.querySelector("[data-current]")).toBeNull();
  });

  it("keeps a blocked key use as its own row, and the empty state without a task", () => {
    const rows = timelineRows<StepRowView>([], [use(1, "deny"), use(2)]);
    const { rerender } = render(
      <ActivityRail rows={rows} sessionId="session" scale={1} api={api} />,
    );
    expect(
      screen.getAllByTestId("key-use").map((row) => row.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual([
      "Blocked weather key → api.weather.example GET /now",
      "Used weather key → api.weather.example",
    ]);
    rerender(<ActivityRail rows={rows} sessionId={null} scale={1} api={api} />);
    expect(screen.queryByTestId("key-use")).toBeNull();
    expect(screen.getByText("Plan and steps appear here once dot starts.")).toBeTruthy();
  });

  it("groups steps by plan item, folding earlier runs and keeping the live run open", () => {
    const model = {
      ...emptyAgentModel(),
      plan: [
        { id: "read", text: "Read the sample data", status: "done" as const },
        { id: "write", text: "Write the report", status: "doing" as const },
      ],
      steps: new Map([
        tool("a", "read", 1),
        tool("b", "read", 2),
        tool("c", "write", 3),
        tool("d", "write", 4, { status: undefined, endedAt: undefined }),
      ]),
    };
    render(<ActivityRail rows={[]} sessionId="one" scale={1} api={api} agent={model} />);
    const earlier = screen.getByRole("button", { name: /^Read the sample data/ });
    const live = screen.getByRole("button", { name: /^Write the report/ });
    expect(earlier.getAttribute("aria-expanded")).toBe("false");
    expect(earlier.textContent).toContain("2 steps");
    expect(live.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Run d/ }).closest("[data-current]")).toBeTruthy();
    fireEvent.click(earlier);
    expect(earlier.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list", { name: "Task plan" }).textContent).toBe(
      "Read the sample dataWrite the report",
    );
    expect(
      within(screen.getByRole("list", { name: "Task plan" }))
        .getAllByRole("img")
        .map((glyph) => glyph.getAttribute("aria-label")),
    ).toEqual(["Done", "In progress"]);
  });

  it("unfolds one step at a time in place, and Escape folds it and returns focus", () => {
    const failing = {
      terminal: appendTerminal(emptyTerminal(), "stderr", "no such file"),
      status: "failed" as const,
      note: "The command returned exit code 2.",
      tool: { name: "shell", title: "Run b", ok: false, exitCode: 2 },
    };
    const model = {
      ...emptyAgentModel(),
      steps: new Map([tool("a", "x", 1), tool("b", "x", 2, failing)]),
    };
    render(<ActivityRail rows={[]} sessionId="one" scale={1} api={api} agent={model} />);
    const first = screen.getByRole("button", { name: /Run a/ });
    const second = screen.getByRole("button", { name: /Run b/ });
    expect(second.closest(".activity-row")?.textContent).toContain(
      "The command returned exit code 2.",
    );
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(second);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Standard error text").textContent).toBe("no such file");
    fireEvent.keyDown(screen.getByLabelText("Standard error text"), { key: "Escape" });
    expect(second.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(second);
  });

  it("keeps a filtered row under the plan item it happened in, with that run's own span", () => {
    const model = {
      ...emptyAgentModel(),
      plan: [
        { id: "open", text: "Open the app", status: "done" as const },
        { id: "sketch", text: "Sketch it", status: "done" as const },
        { id: "colour", text: "Colour it", status: "doing" as const },
      ],
      steps: new Map([
        tool("find", "open", 1_000),
        tool("outline", "sketch", 2_000, { kind: "gui" }),
        tool("face", "sketch", 4_000, { kind: "gui" }),
        tool("size", "colour", 60_000),
      ]),
    };
    render(
      <ActivityRail
        rows={[]}
        keyUses={[use(3_000, "deny")]}
        sessionId="one"
        scale={1}
        api={api}
        agent={model}
      />,
    );
    const filter = within(screen.getByRole("radiogroup", { name: "Activity filter" }));
    fireEvent.click(filter.getByRole("radio", { name: "Tools" }));
    const sketch = screen.getByRole("button", { name: /^Sketch it/ });
    fireEvent.click(sketch);
    const blocked = screen.getByTestId("key-use");
    expect(blocked.closest(".activity-group")?.contains(sketch)).toBe(true);
    expect(screen.getByRole("button", { name: /^Open the app/ }).textContent).toBe(
      "Open the app 1 step",
    );
  });

  it("keeps the run just watched open when the next plan item starts, and folds it a run later", () => {
    const plan = [
      { id: "a", text: "First item", status: "done" as const },
      { id: "b", text: "Second item", status: "doing" as const },
      { id: "c", text: "Third item", status: "todo" as const },
    ];
    const at = (steps: ReturnType<typeof tool>[]) => ({
      ...emptyAgentModel(),
      plan,
      steps: new Map(steps),
    });
    const first = [tool("a1", "a", 1), tool("a2", "a", 2)];
    const second = [...first, tool("b1", "b", 3), tool("b2", "b", 4)];
    const third = [...second, tool("c1", "c", 5, { status: undefined, endedAt: undefined })];
    const view = render(
      <ActivityRail rows={[]} sessionId="one" scale={1} api={api} agent={at(second)} />,
    );
    const run = (name: RegExp) => screen.getByRole("button", { name });
    expect(run(/^First item/).getAttribute("aria-expanded")).toBe("false");
    view.rerender(<ActivityRail rows={[]} sessionId="one" scale={1} api={api} agent={at(third)} />);
    expect(run(/^Second item/).getAttribute("aria-expanded")).toBe("true");
    expect(run(/^Third item/).getAttribute("aria-expanded")).toBe("true");
    view.rerender(
      <ActivityRail
        rows={[]}
        sessionId="one"
        scale={1}
        api={api}
        agent={at([...third, tool("a3", "a", 6)])}
      />,
    );
    expect(run(/^Second item/).getAttribute("aria-expanded")).toBe("false");
    expect(run(/^Third item/).getAttribute("aria-expanded")).toBe("true");
  });

  it("filters to screen steps or tools with a segmented choice", () => {
    const model = { ...emptyAgentModel(), steps: new Map([tool("cmd", "x", 5)]) };
    render(
      <ActivityRail
        rows={timelineRows([step("click", 1, "ok")], [])}
        sessionId="one"
        scale={1}
        api={api}
        agent={model}
      />,
    );
    const filter = within(screen.getByRole("radiogroup", { name: "Activity filter" }));
    fireEvent.click(filter.getByRole("radio", { name: "Screen" }));
    expect(screen.getAllByTestId("step-row")).toHaveLength(1);
    expect(screen.queryByTestId("tool-row")).toBeNull();
    fireEvent.keyDown(filter.getByRole("radio", { name: "Screen" }), { key: "ArrowRight" });
    expect(filter.getByRole("radio", { name: "Tools" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("step-row")).toBeNull();
    expect(screen.getAllByTestId("tool-row")).toHaveLength(1);
  });
});
