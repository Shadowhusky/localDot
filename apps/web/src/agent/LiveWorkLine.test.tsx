// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { SessionNowContext } from "../session/useNowMs.ts";
import { HOLD_MS, type LiveWork, LiveWorkLine } from "./LiveWorkLine.tsx";
import { type AgentStep, emptyAgentModel } from "./model.ts";
import { StepPreviewScope } from "./StepPreview.tsx";
import { appendTerminal, emptyTerminal } from "./terminal-text.ts";
import { type WorkStep, workSteps } from "./thread.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const step = (key: string, startT: number, state: WorkStep["state"] = "done"): WorkStep => ({
  key,
  entry: { key, row: { kind: "step", id: key, startT }, keys: [] },
  changes: [],
  testId: "step-row",
  title: `Step ${key}`,
  meta: "",
  time: "0:01",
  state,
  stateLabel: state,
  startT,
  endT: startT + 500,
});
const steps = [step("a", 1000), step("b", 3000, "failed"), step("c", 6000)];
const live = (label: string, extra: Partial<LiveWork> = {}): LiveWork => ({
  phase: "running",
  label,
  nowMs: 43_000,
  ...extra,
});
const trigger = () =>
  document.querySelector<HTMLElement>(".thread-work-steps > .ui-disclosure-trigger");
const summary = () => trigger()?.textContent?.trim();
const fold = () => fireEvent.click(trigger() as HTMLElement);

it("streams the steps of the run dot is at, open, and says what it is doing once they're folded", () => {
  render(<LiveWorkLine steps={steps} startMs={1000} live={live("Typing the total")} />);
  expect(summary()).toBe("Working · 3 steps · 1 failed · 0:42");
  expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s+/g, " ")),
  ).toEqual(["Step a 0:01", "Step b 0:01", "Step c 0:01"]);
  // The open list ends on what dot is doing, so the line under it waits for the fold.
  expect(screen.queryByText("Typing the total")).toBeNull();
  fold();
  expect(screen.getByText("Typing the total")).toBeTruthy();
  expect(screen.getByText("1 failed").className).toBe("thread-work-failed");
});

it("folds a run once dot moves on, unless the reader chose to keep it open", () => {
  const view = render(<LiveWorkLine steps={steps} startMs={1000} live={live("Typing")} />);
  view.rerender(<LiveWorkLine steps={steps} startMs={1000} live={null} />);
  expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
  expect(summary()).toBe("Worked for 0:06 · 3 steps · 1 failed");
  fold();
  view.rerender(<LiveWorkLine steps={[...steps]} startMs={1000} live={null} ended="done" />);
  expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
});

it("shows a run with no steps yet as its summary alone, counting the turn", () => {
  render(<LiveWorkLine steps={[]} startMs={1000} live={live("Thinking")} />);
  expect(trigger()).toBeNull();
  expect(document.querySelector(".thread-work-status")?.textContent?.trim()).toBe("Working · 0:42");
});

it("draws a single finished step as its own row, with no fold over it", () => {
  render(<LiveWorkLine steps={[step("only", 1000)]} startMs={0} live={null} />);
  expect(trigger()).toBeNull();
  expect(screen.getByTestId("step-row").textContent).toContain("Step only");
  cleanup();
  render(<LiveWorkLine steps={[step("only", 1000)]} startMs={0} live={null} ended="stopped" />);
  expect(summary()).toBe("Stopped after 0:02 · 1 step");
});

it("counts a running turn's time by itself from the page's clock", () => {
  vi.useFakeTimers();
  let now = 43_000;
  const view = render(
    <SessionNowContext.Provider value={() => now}>
      <LiveWorkLine steps={steps} startMs={1000} live={live("Typing", { nowMs: undefined })} />
    </SessionNowContext.Provider>,
  );
  expect(summary()).toBe("Working · 3 steps · 1 failed · 0:42");
  now = 44_000;
  act(() => vi.advanceTimersByTime(1_100));
  expect(summary()).toBe("Working · 3 steps · 1 failed · 0:43");
  view.rerender(
    <SessionNowContext.Provider value={() => now}>
      <LiveWorkLine steps={steps} startMs={1000} live={null} ended="done" />
    </SessionNowContext.Provider>,
  );
  expect(summary()).toBe("Worked for 0:06 · 3 steps · 1 failed");
  now = 50_000;
  act(() => vi.advanceTimersByTime(2_000));
  expect(summary()).toBe("Worked for 0:06 · 3 steps · 1 failed");
});

it("holds each line at least a second, so quick steps never flicker past", () => {
  vi.useFakeTimers();
  const view = render(<LiveWorkLine steps={steps} startMs={1000} live={live("Clicking Save")} />);
  fold();
  act(() => vi.advanceTimersByTime(HOLD_MS));
  view.rerender(<LiveWorkLine steps={steps} startMs={1000} live={live("Typing the name")} />);
  act(() => vi.advanceTimersByTime(10));
  view.rerender(<LiveWorkLine steps={steps} startMs={1000} live={live("Pressing Enter")} />);
  act(() => vi.advanceTimersByTime(HOLD_MS - 100));
  expect(screen.queryByText("Pressing Enter")).toBeNull();
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByText("Pressing Enter")).toBeTruthy();
});

it("names the wait or the end instead of narrating, and stops the clock", () => {
  const view = render(
    <LiveWorkLine
      steps={steps}
      startMs={1000}
      live={live("Needs your answer", { phase: "waiting", row: "question" })}
    />,
  );
  expect(summary()).toBe("Waiting for you · 3 steps · 1 failed");
  view.rerender(
    <LiveWorkLine
      steps={steps}
      startMs={1000}
      live={live("Paused", { phase: "waiting", row: "recovery" })}
    />,
  );
  expect(summary()).toBe("Paused · 3 steps · 1 failed");
  view.rerender(<LiveWorkLine steps={steps} startMs={1000} live={null} ended="done" />);
  expect(summary()).toBe("Worked for 0:06 · 3 steps · 1 failed");
  view.rerender(<LiveWorkLine steps={steps} startMs={1000} live={null} ended="stopped" />);
  expect(summary()).toBe("Stopped after 0:06 · 3 steps · 1 failed");
});

it("opens again on what dot does next, never on the words of the wait", () => {
  vi.useFakeTimers();
  const view = render(<LiveWorkLine steps={steps} startMs={1000} live={live("Clicking Save")} />);
  fold();
  act(() => vi.advanceTimersByTime(HOLD_MS));
  view.rerender(
    <LiveWorkLine
      steps={steps}
      startMs={1000}
      live={live("Needs your answer", { phase: "waiting", row: "question" })}
    />,
  );
  act(() => vi.advanceTimersByTime(HOLD_MS * 2));
  view.rerender(<LiveWorkLine steps={steps} startMs={1000} live={live("Typing PDF")} />);
  act(() => vi.advanceTimersByTime(HOLD_MS * 2));
  expect(screen.queryByText("Needs your answer")).toBeNull();
  expect(screen.getByText("Typing PDF")).toBeTruthy();
});

it("keeps cost out of the steps summary because it belongs in turn metadata", () => {
  render(
    <LiveWorkLine
      steps={steps}
      startMs={1000}
      spend={{ usd: 0.42, estimated: true }}
      live={null}
    />,
  );
  expect(summary()).not.toContain("$");
  expect(summary()).toContain("3 steps");
});

it("keeps all earlier steps in the scrollable work block", () => {
  const history = Array.from({ length: 140 }, (_, i) => step(String(i), i * 1000));
  render(<LiveWorkLine steps={history} startMs={0} live={live("Reading the page")} />);
  const scroll = screen.getByRole("region", { name: "Work history" });
  expect(scroll.querySelectorAll(".thread-work-window-row")).toHaveLength(140);
  expect(screen.getByText("Step 0")).toBeTruthy();
  expect(screen.getByText("Step 139")).toBeTruthy();
  expect(screen.queryByText(/earlier steps are/)).toBeNull();
});

it("keeps step descriptions visible in an earlier completed turn", () => {
  const history = [{ ...step("a", 1000), meta: "Chromium · Read the page title" }];
  const view = render(<LiveWorkLine steps={history} startMs={0} live={null} ended="done" />);
  expect(screen.getByText("Chromium · Read the page title")).toBeTruthy();
  view.rerender(
    <LiveWorkLine
      steps={[{ ...history[0]!, meta: "Page could not be reached" }]}
      startMs={0}
      live={null}
      ended="done"
    />,
  );
  expect(screen.getByText("Page could not be reached")).toBeTruthy();
});

it("groups read-only work in Chat with visibly nested children and keeps failures outside", () => {
  const history = [
    { ...step("read-a", 0), readGroup: "plan" },
    { ...step("read-b", 1000), readGroup: "plan" },
    step("failure", 2000, "failed"),
    step("current", 3000, "doing"),
  ];
  const view = render(<LiveWorkLine steps={history} startMs={0} live={live("Working")} />);
  expect(screen.queryByText("Step read-a")).toBeNull();
  expect(screen.getByText("Step failure")).toBeTruthy();
  expect(screen.getByText("Step current")).toBeTruthy();
  const group = screen.getByRole("button", { name: /Read files and instructions/ });
  fireEvent.click(group);
  expect(view.container.querySelectorAll("[data-group-child]")).toHaveLength(2);
  expect(screen.getByText("Step read-a").closest("[data-group-child]")).toBeTruthy();
  expect(screen.getByText("Step failure").closest("[data-group-child]")).toBeNull();
  fireEvent.click(group);
  expect(screen.queryByText("Step read-a")).toBeNull();
});

it("windows thousands of Chat steps while more steps arrive", () => {
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computed(element);
    return element.classList.contains("thread-work-scroll")
      ? new Proxy(style, {
          get: (target, key) => (key === "overflowY" ? "auto" : Reflect.get(target, key)),
        })
      : style;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(280);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(390);
  const history = Array.from({ length: 3000 }, (_, i) => step(String(i), i * 1000));
  const view = render(<LiveWorkLine steps={history} startMs={0} live={live("Reading")} />);
  const mounted = () => view.container.querySelectorAll(".thread-work-window-row").length;
  expect(mounted()).toBeGreaterThan(0);
  expect(mounted()).toBeLessThan(40);
  view.rerender(
    <LiveWorkLine
      steps={[
        ...history,
        ...Array.from({ length: 1000 }, (_, i) => step(`new-${i}`, (3000 + i) * 1000)),
      ]}
      startMs={0}
      live={live("Reading")}
    />,
  );
  expect(mounted()).toBeGreaterThan(0);
  expect(mounted()).toBeLessThan(40);
});

const tool = (id: string, at: number, extra: Partial<AgentStep> = {}): [string, AgentStep] => [
  id,
  {
    id,
    kind: "shell",
    startedAt: at * 1000,
    endedAt: at * 1000 + 500_000,
    status: "ok",
    tool: { name: "shell", title: `Run ${id}`, ok: true, exitCode: 0 },
    output: [],
    outputTruncated: false,
    ...extra,
  },
];
const toolSteps = () =>
  workSteps([], {
    ...emptyAgentModel(),
    steps: new Map([
      tool("a", 1000),
      tool("b", 2000, {
        terminal: appendTerminal(emptyTerminal(), "stderr", "no such file"),
        status: "failed",
        tool: { name: "shell", title: "Run b", ok: false, exitCode: 2 },
      }),
      tool("c", 3000, { tool: { name: "shell", title: "Run c" } }),
    ]),
  });
const api = createApi("test", { origin: "http://localhost" });

it("unfolds a step's details in place in the chat, one at a time, and Escape folds it", () => {
  render(
    <StepPreviewScope api={api} sessionId="one" results={[]}>
      <LiveWorkLine steps={toolSteps()} startMs={0} live={null} ended="done" />
    </StepPreviewScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Worked/ }));
  const first = screen.getByRole("button", { name: /Run a/ });
  const second = screen.getByRole("button", { name: /Run b/ });
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(first.getAttribute("aria-controls") ?? "")).toBeTruthy();
  fireEvent.click(first);
  expect(first.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(second);
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(second.getAttribute("aria-expanded")).toBe("true");
  const output = screen.getByLabelText("Standard error text");
  expect(output.textContent).toBe("no such file");
  expect(output.closest(".thread-work-list")).toBeTruthy();
  fireEvent.keyDown(output, { key: "Escape" });
  expect(second.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(second);
  // A step with nothing more to show is a plain row.
  expect(screen.queryByRole("button", { name: /Run c/ })).toBeNull();
  expect(screen.getByText("Run c")).toBeTruthy();
});

it("keeps steps as plain rows where there is no task to read their details from", () => {
  render(<LiveWorkLine steps={toolSteps()} startMs={0} live={null} ended="done" />);
  fireEvent.click(screen.getByRole("button", { name: /Worked/ }));
  expect(screen.getByText("Run a")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Run a/ })).toBeNull();
});
