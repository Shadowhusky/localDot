// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { PlanRail } from "../shell/PlanRail.tsx";
import { MemoryCard } from "./MemoryCard.tsx";
import { type AgentChange, type AgentStep, emptyAgentModel } from "./model.ts";
import { QuestionCard } from "./QuestionCard.tsx";
import { ResultCard } from "./ResultCard.tsx";
import { SkillsView } from "./SkillsView.tsx";
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

describe("activity cards and inspection", () => {
  it("keeps failed command output inspectable after a crash and filters without losing selected history", () => {
    const model = {
      ...emptyAgentModel(),
      steps: new Map([[step.id, step]]),
      ended: { reason: "error" as const },
    };
    const view = render(
      <PlanRail api={api} sessionId="one" scale={1} title={null} rows={[]} agent={model} />,
    );
    expect(screen.getByText("Completion not confirmed")).toBeTruthy();
    expect(screen.getByText("Tool failed. Exit code 7.")).toBeTruthy();
    expect(screen.queryByLabelText("Standard error text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Check report" }));
    expect(screen.getByLabelText("Standard error text").textContent).toBe("Useful failure output");
    const filter = within(screen.getByRole("group", { name: "Activity filter" }));
    fireEvent.click(filter.getByRole("button", { name: /^Computer$/ }));
    expect(screen.queryByTestId("tool-row")).toBeNull();
    expect(screen.getByLabelText("Standard error text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close output" }));
    fireEvent.click(filter.getByRole("button", { name: /^All$/ }));
    expect(screen.getByTestId("tool-row")).toBeTruthy();
    view.rerender(
      <PlanRail api={api} sessionId="two" scale={1} title={null} rows={[]} agent={model} />,
    );
    expect(screen.queryByRole("region", { name: "Selected output" })).toBeNull();
  });
  it("renders plan states and relevant file diffs once without treating tool success as step completion", () => {
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
    render(<PlanRail api={api} sessionId="one" scale={1} title={null} rows={[]} agent={model} />);
    expect(screen.getByText("1 of 4 completed")).toBeTruthy();
    expect(screen.getByText("Step completion not confirmed")).toBeTruthy();
    const diff = screen.getAllByRole("button", { name: "Inspect create: report.txt" });
    expect(diff).toHaveLength(1);
    const trigger = diff[0];
    if (!trigger) throw new Error("Missing relevant diff control");
    fireEvent.click(trigger);
    expect(screen.getByLabelText("Unified text diff").textContent).toBe("+sample");
  });
  it("names only the selected durable memory ID, suppresses already undone changes, and offers reread on conflict", () => {
    const undo = vi.fn(),
      reread = vi.fn(),
      inspect = vi.fn();
    const view = render(
      <MemoryCard change={source} changes={[source]} onInspect={inspect} onUndo={undo} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo this change" }));
    expect(undo).toHaveBeenCalledExactlyOnceWith(source.changeId);
    view.rerender(
      <MemoryCard
        change={source}
        changes={[source]}
        onInspect={inspect}
        onUndo={undo}
        onReread={reread}
        status="conflict"
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Undo this change" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reread memory" }));
    expect(reread).toHaveBeenCalledOnce();
    view.rerender(
      <MemoryCard
        change={source}
        changes={[
          source,
          { ...source, id: "undo", changeId: "different", undoes: source.changeId },
        ]}
        onInspect={inspect}
        onUndo={undo}
      />,
    );
    expect(screen.queryByRole("button", { name: "Undo this change" })).toBeNull();
    expect(screen.getByText("This change has already been undone.")).toBeTruthy();
    view.rerender(
      <MemoryCard
        change={{ ...source, changeId: undefined }}
        changes={[]}
        onInspect={inspect}
        onUndo={undo}
      />,
    );
    expect(screen.queryByRole("button", { name: "Undo this change" })).toBeNull();
    expect(undo).toHaveBeenCalledTimes(1);
  });
  it("preserves multiline plain result text with zero or multiple files and separates result receipt from task ending", () => {
    const result = { id: "r", summary: "First line\n<script>plain text</script>\n中文", files: [] };
    const view = render(<ResultCard result={result} latest ended={false} idle={false} />);
    expect(view.container.querySelector(".result-summary")?.textContent).toBe(result.summary);
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByText("No files attached to this result.")).toBeTruthy();
    expect(screen.getByText("Result received. The task may continue.")).toBeTruthy();
    view.rerender(
      <ResultCard
        result={{
          ...result,
          files: [
            { name: "a", path: "ignored", bytes: 1 },
            { name: "b", path: "ignored", bytes: 2 },
          ],
        }}
        latest
        ended={false}
        idle
      />,
    );
    expect(screen.getByText("2 files attached.")).toBeTruthy();
    expect(screen.getByText("Ready for a follow-up in Conversation.")).toBeTruthy();
    view.rerender(<ResultCard result={result} latest ended idle={false} />);
    expect(screen.getByText("This task has ended. Its history remains available.")).toBeTruthy();
  });
  it("keeps questions and skills as plain history without submitting answers or exposing unsupported editors", () => {
    const question = {
      askId: "ask",
      question: "Use <b>plain</b>?",
      options: [{ key: "A" as const, text: "Yes" }],
      allowText: true,
      answer: { askId: "ask", by: "user" as const, option: "A" as const },
    };
    const { container } = render(
      <>
        <QuestionCard question={question} pending={false} />
        <SkillsView skills={[{ name: "Report", description: "<img src=x>", source: "built-in" }]} />
      </>,
    );
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.getByText("Answer: Yes")).toBeTruthy();
    expect(container.querySelectorAll("form,input,textarea,button,img,b")).toHaveLength(0);
    expect(screen.getByText("Skills are read-only here.")).toBeTruthy();
  });
});
