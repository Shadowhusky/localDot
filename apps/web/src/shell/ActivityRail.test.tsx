// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentStep, emptyAgentModel } from "../agent/model.ts";
import { appendTerminal, emptyTerminal } from "../agent/terminal-text.ts";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { ActivityRail } from "./ActivityRail.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

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

  it("lists every step as one flat row in time order, with no folds by plan item", () => {
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
    const { container } = render(
      <ActivityRail rows={[]} sessionId="one" scale={1} api={api} agent={model} nowMs={2_004} />,
    );
    expect(
      container.querySelector(".activity-group, .activity-timeline .ui-disclosure"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Read the sample data/ })).toBeNull();
    const rows = within(screen.getByRole("region", { name: "Recorded steps" })).getAllByTestId(
      "tool-row",
    );
    expect(rows.map((row) => row.querySelector(".activity-row-title")?.textContent)).toEqual([
      "Run a",
      "Run b",
      "Run c",
      "Run d",
    ]);
    expect(rows.map((row) => row.querySelector(".activity-row-time")?.textContent)).toEqual([
      "0:01",
      "0:01",
      "0:01",
      "0:02",
    ]);
    expect(rows[3]?.hasAttribute("data-current")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Plan/ }));
    expect(screen.getByRole("list", { name: "Task plan" }).textContent).toBe(
      "Read the sample dataWrite the report",
    );
    expect(
      within(screen.getByRole("list", { name: "Task plan" }))
        .getAllByRole("img")
        .map((glyph) => glyph.getAttribute("aria-label")),
    ).toEqual(["Done", "In progress"]);
  });

  it("lists the files dot changed after the steps, each unfolding its diff", () => {
    const model = {
      ...emptyAgentModel(),
      steps: new Map([tool("w", "write", 1, { kind: "file" as const })]),
      changes: [
        {
          id: "c",
          step: "w",
          type: "file" as const,
          path: "report/summary.md",
          op: "create" as const,
          patch: "+# Report",
          truncated: false,
        },
      ],
    };
    render(<ActivityRail rows={[]} sessionId="changed" scale={1} api={api} agent={model} />);
    fireEvent.click(screen.getByRole("tab", { name: "Files 1" }));
    const changed = screen.getByRole("region", { name: "Changed" });
    const row = within(changed).getByTestId("change-row");
    expect(row.textContent?.replace(/\s+/g, " ").trim()).toBe("summary.md Created · +1");
    fireEvent.click(within(row).getByRole("button"));
    expect(within(row).getByLabelText("Unified text diff").textContent).toBe("+# Report");
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

  it("says in a failed row what dot did next, even when the filter hides that step", () => {
    const model = {
      ...emptyAgentModel(),
      steps: new Map([
        tool("check", "x", 1, {
          status: "failed",
          note: "The command returned exit code 2.",
          tool: { name: "shell", title: "Run check", ok: false, exitCode: 2 },
        }),
      ]),
    };
    render(
      <ActivityRail
        rows={timelineRows([step("Clicked Save", 3, "ok")], [])}
        sessionId="one"
        scale={1}
        api={api}
        agent={model}
      />,
    );
    const filter = within(screen.getByRole("radiogroup", { name: "Activity filter" }));
    fireEvent.click(filter.getByRole("radio", { name: "Tools" }));
    expect(screen.getByTestId("tool-row").querySelector(".activity-row-meta")?.textContent).toBe(
      "The command returned exit code 2. Then clicked Save.",
    );
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

  it("pins a compact plan: the count, the item dot is on and the next, unfolding the whole list", () => {
    const model = {
      ...emptyAgentModel(),
      plan: [
        { id: "a", text: "Open the sheet", status: "done" as const },
        { id: "b", text: "Check the **totals**", status: "doing" as const },
        { id: "c", text: "Write the report", status: "todo" as const },
        { id: "d", text: "Send it", status: "todo" as const },
      ],
    };
    const { container } = render(
      <ActivityRail rows={[]} sessionId="strip" scale={1} api={api} agent={model} />,
    );
    const strip = screen.getByRole("button", { name: /^Plan/ });
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".plan-strip-count")?.textContent).toBe("1 of 4");
    expect(
      [...container.querySelectorAll(".plan-strip-text")].map((line) => [
        line.textContent,
        line.getAttribute("title"),
      ]),
    ).toEqual([
      ["Check the totals", "Check the totals"],
      ["Write the report", "Write the report"],
    ]);
    expect(screen.queryByRole("list", { name: "Task plan" })).toBeNull();
    fireEvent.click(strip);
    expect(strip.getAttribute("aria-expanded")).toBe("true");
    // Expanding the overlay keeps the compact summary in place, avoiding a layout jump.
    expect(container.querySelector(".plan-strip-text")?.textContent).toBe("Check the totals");
    expect(
      within(screen.getByRole("list", { name: "Task plan" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Open the sheet", "Check the totals", "Write the report", "Send it"]);
  });

  it("has no plan strip without a plan", () => {
    render(
      <ActivityRail rows={[]} sessionId="no-plan" scale={1} api={api} agent={emptyAgentModel()} />,
    );
    expect(screen.queryByRole("button", { name: /^Plan/ })).toBeNull();
  });

  it("puts steps, files and sources on tabs with counts, each only once it has something", () => {
    const base = { ...emptyAgentModel(), steps: new Map([tool("a", "x", 1), tool("b", "x", 2)]) };
    const view = render(
      <ActivityRail rows={[]} sessionId="tabs" scale={1} api={api} agent={base} />,
    );
    const names = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(names()).toEqual(["Steps 2"]);
    const full = {
      ...base,
      changes: [
        { id: "f", type: "file" as const, path: "a.md", op: "create" as const, truncated: false },
        { id: "m", type: "memory" as const, path: "MEMORY.md", truncated: false },
      ],
      research: {
        startMs: 0,
        budget: { sources: 20, minutes: 15 },
        sources: [{ n: 1, url: "https://example.org/a", title: "A page", passages: 0 }],
      },
    };
    view.rerender(<ActivityRail rows={[]} sessionId="tabs" scale={1} api={api} agent={full} />);
    expect(names()).toEqual(["Steps 2", "Files 2", "Sources 1"]);
    expect(screen.getByRole("tab", { name: "Steps 2" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Files 2" }));
    const files = screen.getByRole("tabpanel", { name: "Files 2" });
    expect(within(files).getByRole("region", { name: "Changed" }).textContent).toContain("a.md");
    expect(within(files).getByRole("region", { name: "Memory" }).textContent).toContain(
      "MEMORY.md",
    );
    expect(screen.queryByRole("region", { name: "Recorded steps" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Sources 1" }));
    expect(screen.getByRole("list", { name: "Sources dot read" }).textContent).toContain("A page");
  });

  it("remembers the chosen tab per task across mounts", () => {
    const model = {
      ...emptyAgentModel(),
      steps: new Map([tool("a", "x", 1)]),
      changes: [
        { id: "f", type: "file" as const, path: "a.md", op: "create" as const, truncated: false },
      ],
    };
    const rail = (sessionId: string) => (
      <ActivityRail rows={[]} sessionId={sessionId} scale={1} api={api} agent={model} />
    );
    const selected = () =>
      screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.textContent;
    const view = render(rail("memory-a"));
    fireEvent.click(screen.getByRole("tab", { name: "Files 1" }));
    view.rerender(rail("memory-b"));
    expect(selected()).toBe("Steps 1");
    view.rerender(rail("memory-a"));
    expect(selected()).toBe("Files 1");
    view.unmount();
    render(rail("memory-a"));
    expect(selected()).toBe("Files 1");
  });

  it("still switches tabs when browser storage cannot save preferences", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const model = {
      ...emptyAgentModel(),
      changes: [
        { id: "f", type: "file" as const, path: "a.md", op: "create" as const, truncated: false },
      ],
    };
    render(<ActivityRail rows={[]} sessionId="blocked" scale={1} api={api} agent={model} />);
    fireEvent.click(screen.getByRole("tab", { name: "Files 1" }));
    expect(screen.getByRole("tab", { name: "Files 1" }).getAttribute("aria-selected")).toBe("true");
  });

  it("marks Files when a file is handed over, without leaving the tab the reader is on", () => {
    const model = { ...emptyAgentModel(), steps: new Map([tool("a", "x", 1)]) };
    const handed = {
      ...model,
      results: [
        {
          id: "r",
          summary: "Done",
          files: [{ name: "report.pdf", path: "report.pdf", bytes: 10 }],
        },
      ],
    };
    const rail = (agent: typeof model) => (
      <ActivityRail rows={[]} sessionId="fresh" scale={1} api={api} agent={agent} historyLoaded />
    );
    const view = render(rail(model));
    view.rerender(rail(handed));
    const files = screen.getByRole("tab", { name: "Files 1" });
    expect(files.querySelector(".ui-segment-fresh")).toBeTruthy();
    expect(files.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(files);
    expect(files.querySelector(".ui-segment-fresh")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Steps 1" }));
    expect(
      screen.getByRole("tab", { name: "Files 1" }).querySelector(".ui-segment-fresh"),
    ).toBeNull();
  });

  it("keeps the usage line out of the scroller, at the rail's foot", () => {
    const { container } = render(
      <ActivityRail rows={[]} sessionId="usage" scale={1} api={api} agent={emptyAgentModel()} />,
    );
    const usage = container.querySelector(".activity-usage");
    expect(usage).toBeTruthy();
    expect(container.querySelector(".activity-scroll")?.contains(usage)).toBe(false);
    expect(container.querySelector(".activity-rail")?.lastElementChild).toBe(usage);
  });
});
