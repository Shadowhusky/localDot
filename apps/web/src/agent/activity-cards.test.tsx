// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import { ChangeRow } from "./ChangeRow.tsx";
import { type AgentChange, type AgentStep, emptyAgentModel } from "./model.ts";
import { appendTerminal, emptyTerminal } from "./terminal-text.ts";

afterEach(cleanup);
const api = createApi("sample", { origin: "http://localhost" });
const source: AgentChange = {
  id: "event",
  type: "memory",
  path: "MEMORY.md",
  patch: "+sample",
  truncated: false,
  changeId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
};
const step: AgentStep = {
  id: "command",
  kind: "shell",
  startedAt: 1000,
  tool: { name: "run", title: "Check report", ok: false, exitCode: 7 },
  output: [],
  outputTruncated: false,
  terminal: appendTerminal(emptyTerminal(), "stderr", "Useful failure output"),
};

describe("activity rows and inspection", () => {
  it("keeps failed command output inspectable after a crash and filters without losing it", () => {
    const model = {
      ...emptyAgentModel(),
      steps: new Map([[step.id, step]]),
      ended: { reason: "error" as const },
    };
    const view = render(
      <ActivityRail api={api} sessionId="one" scale={1} rows={[]} agent={model} />,
    );
    const row = screen.getByTestId("tool-row");
    expect(row.textContent).toContain("The task ended before this step finished.");
    expect(within(row).getByRole("img", { name: "Not confirmed" })).toBeTruthy();
    const head = screen.getByRole("button", { name: /Check report/ });
    fireEvent.click(head);
    expect(screen.getByLabelText("Standard error text").textContent).toBe("Useful failure output");
    const filter = within(screen.getByRole("radiogroup", { name: "Activity filter" }));
    fireEvent.click(filter.getByRole("radio", { name: "Screen" }));
    expect(screen.queryByTestId("tool-row")).toBeNull();
    fireEvent.click(filter.getByRole("radio", { name: "All" }));
    expect(screen.getByLabelText("Standard error text").textContent).toBe("Useful failure output");
    view.rerender(<ActivityRail api={api} sessionId="two" scale={1} rows={[]} agent={model} />);
    expect(screen.getByRole("button", { name: /Check report/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("shows plan states and a step's file diff once, and never treats tool success as step completion", () => {
    const change = {
      ...source,
      type: "file" as const,
      path: "report.txt",
      op: "create" as const,
      step: step.id,
    };
    const model = {
      ...emptyAgentModel(),
      plan: ["todo", "doing", "done", "skipped"].map((status, index) => ({
        id: String(index),
        text: `Part ${index}`,
        status: status as "todo" | "doing" | "done" | "skipped",
      })),
      steps: new Map([
        [step.id, { ...step, tool: { name: "run", title: "Check report", ok: true, exitCode: 0 } }],
      ]),
      changes: [change],
    };
    render(<ActivityRail api={api} sessionId="one" scale={1} rows={[]} agent={model} />);
    expect(document.querySelector(".plan-count")?.textContent).toBe("1 of 4 done");
    expect(
      within(screen.getByRole("list", { name: "Task plan" }))
        .getAllByRole("img")
        .map((glyph) => glyph.getAttribute("aria-label")),
    ).toEqual(["Next", "In progress", "Done", "Skipped"]);
    const row = screen.getByTestId("tool-row");
    expect(within(row).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Files" })).getAllByTestId("change-row"),
    ).toHaveLength(1);
    fireEvent.click(within(row).getByRole("button"));
    expect(screen.getAllByLabelText("Unified text diff")).toHaveLength(1);
    expect(screen.getByLabelText("Unified text diff").textContent).toBe("+sample");
  });

  it("names only the selected durable memory ID, suppresses already undone changes, and offers a reread on conflict", () => {
    const undo = vi.fn(),
      reread = vi.fn(),
      toggle = vi.fn();
    const row = (props: Partial<Parameters<typeof ChangeRow>[0]>) => (
      <ChangeRow
        id="memory"
        change={source}
        changes={[source]}
        open
        onToggle={toggle}
        onUndo={undo}
        {...props}
      />
    );
    const view = render(row({}));
    fireEvent.click(screen.getByRole("button", { name: "Undo this change" }));
    expect(undo).toHaveBeenCalledExactlyOnceWith(source.changeId);
    view.rerender(row({ onReread: reread, status: "conflict" }));
    expect(
      screen.getByRole("button", { name: "Undo this change" }).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Undo this change" }));
    fireEvent.click(screen.getByRole("button", { name: "Read memory again" }));
    expect(reread).toHaveBeenCalledOnce();
    view.rerender(
      row({
        changes: [
          source,
          { ...source, id: "undo", changeId: "different", undoes: source.changeId },
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: "Undo this change" })).toBeNull();
    expect(screen.getByText("This change has already been undone.")).toBeTruthy();
    view.rerender(row({ change: { ...source, changeId: undefined }, changes: [] }));
    expect(screen.queryByRole("button", { name: "Undo this change" })).toBeNull();
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
