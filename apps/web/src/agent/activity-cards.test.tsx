// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import { stepRows } from "../session/session-view.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import { ActivityDetail } from "./ActivityDetails.tsx";
import { activityRows, foldKeyUses } from "./activity.ts";
import { ChangeRow } from "./ChangeRow.tsx";
import { type AgentChange, type AgentStep, emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
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
    render(<ActivityRail api={api} sessionId="plan-states" scale={1} rows={[]} agent={model} />);
    expect(document.querySelector(".plan-strip-count")?.textContent).toBe("1 of 4");
    fireEvent.click(screen.getByRole("button", { name: /^Plan/ }));
    expect(
      within(screen.getByRole("list", { name: "Task plan" }))
        .getAllByRole("img")
        .map((glyph) => glyph.getAttribute("aria-label")),
    ).toEqual(["Next", "In progress", "Done", "Skipped"]);
    const row = screen.getByTestId("tool-row");
    expect(within(row).getByRole("img", { name: "Running" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Files/ }));
    expect(
      within(screen.getByRole("tabpanel", { name: /^Files/ })).getAllByTestId("change-row"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: /^Steps/ }));
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

// Steps as the app records them: each is a row of its own and a step in dot's model.
const recorded = (...steps: [type: string, data: unknown, step: string][]) =>
  steps.map(([type, data, step], n) =>
    LocalDotEvent.parse({
      v: 1,
      id: String(n + 1).padStart(26, "0"),
      seq: n + 1,
      t: (n + 1) * 1000,
      agent: "main",
      type,
      data,
      step,
    }),
  );
function showSteps(events: LocalDotEvent[]) {
  const stage = foldEvents(emptyModel(), events);
  render(
    <ActivityRail
      api={api}
      sessionId="details"
      scale={1}
      rows={timelineRows(stepRows(stage), stage.keyUses)}
      keyUses={stage.keyUses}
      agent={events.reduce(projectAgentEvent, emptyAgentModel())}
    />,
  );
}
const rowNamed = (title: string) =>
  screen.getAllByTestId("tool-row").find((row) => row.textContent?.includes(title)) as HTMLElement;

describe("an unfolded step", () => {
  it("shows the command dot's line stood for, with its errors and the failure said once", () => {
    showSteps(
      recorded(
        ["step.start", { kind: "shell", intent: "Checking the build" }, "build"],
        ["tool.start", { tool: "shell", title: "npm test --workspace web" }, "build"],
        ["tool.output", { stream: "stderr", chunk: "1 test failed\n" }, "build"],
        ["tool.end", { ok: false, exitCode: 1 }, "build"],
        ["step.end", { status: "failed", note: "The command returned exit code 1." }, "build"],
      ),
    );
    const row = rowNamed("Checking the build");
    expect(row.querySelector(".activity-row-meta")?.textContent).toBe(
      "The command returned exit code 1.",
    );
    expect(screen.queryByText("npm test --workspace web")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /Checking the build/ }));
    const detail = row.querySelector(".activity-detail") as HTMLElement;
    expect(within(detail).getByText("npm test --workspace web").tagName).toBe("CODE");
    expect(within(detail).getByLabelText("Standard error text").textContent).toBe(
      "1 test failed\n",
    );
    expect(within(row).getAllByText(/The command returned exit code 1/)).toHaveLength(1);
    expect(detail.textContent).not.toContain("No screenshot");
    expect(detail.textContent).not.toContain("No output");
  });

  it("stays folded when its row already says it all, and says only of a command that it printed nothing", () => {
    showSteps(
      recorded(
        ["step.start", { kind: "file" }, "list"],
        ["tool.start", { tool: "files", title: "list /config/.agents/skills" }, "list"],
        ["tool.end", { ok: false }, "list"],
        ["step.end", { status: "failed", note: "The file or folder does not exist." }, "list"],
        ["step.start", { kind: "browser" }, "fetch"],
        ["tool.start", { tool: "web_fetch", title: "Read example.org" }, "fetch"],
        ["tool.end", { ok: true }, "fetch"],
        ["step.end", { status: "ok" }, "fetch"],
        ["step.start", { kind: "shell" }, "quiet"],
        ["tool.start", { tool: "shell", title: "touch report.md" }, "quiet"],
        ["tool.end", { ok: true, exitCode: 0 }, "quiet"],
        ["step.end", { status: "ok" }, "quiet"],
      ),
    );
    const list = rowNamed("list /config/.agents/skills");
    expect(list.textContent).toContain("The file or folder does not exist.");
    for (const row of [list, rowNamed("Read example.org")]) {
      expect(within(row).queryByRole("button")).toBeNull();
      expect(row.querySelector("[aria-expanded]")).toBeNull();
    }
    const quiet = rowNamed("touch report.md");
    fireEvent.click(within(quiet).getByRole("button", { name: /touch report\.md/ }));
    const detail = quiet.querySelector(".activity-detail") as HTMLElement;
    expect(within(detail).getByText("No output.")).toBeTruthy();
    expect(within(detail).getByText("Exit 0")).toBeTruthy();
    expect(detail.textContent).not.toContain("No screenshot");
  });

  it("shows the text a read brought back", () => {
    const page = "# Example Domain\nThis domain is for use in documentation examples.\n";
    showSteps(
      recorded(
        ["step.start", { kind: "browser" }, "fetch"],
        ["tool.start", { tool: "web_fetch", title: "Read example.org" }, "fetch"],
        ["tool.output", { stream: "stdout", chunk: page }, "fetch"],
        ["tool.end", { ok: true }, "fetch"],
        ["step.end", { status: "ok" }, "fetch"],
      ),
    );
    const row = rowNamed("Read example.org");
    fireEvent.click(within(row).getByRole("button", { name: /Read example\.org/ }));
    const detail = row.querySelector(".activity-detail") as HTMLElement;
    expect(within(detail).getByLabelText("Standard output text").textContent).toBe(page);
    expect(detail.textContent).not.toContain("No screenshot");
    expect(detail.textContent).not.toContain("No output");
  });

  it("in a recording, shows no empty picture for a step that never took one", () => {
    const events = recorded(
      ["step.start", { kind: "shell", intent: "Checking the build" }, "build"],
      ["tool.start", { tool: "shell", title: "npm test" }, "build"],
      ["tool.end", { ok: true, exitCode: 0 }, "build"],
      ["step.end", { status: "ok" }, "build"],
    );
    const agent = events.reduce(projectAgentEvent, emptyAgentModel());
    const rows = timelineRows(stepRows(foldEvents(emptyModel(), events)), []);
    const [entry] = foldKeyUses(activityRows(rows, agent));
    if (!entry) throw new Error("Expected the recorded step");
    const { container } = render(
      <ActivityDetail entry={entry} changes={[]} api={api} sessionId="details" scale={1} replay />,
    );
    expect(container.querySelector(".activity-frame")).toBeNull();
    expect(within(container).getByText("npm test").tagName).toBe("CODE");
  });
});
