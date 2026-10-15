// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HOLD_MS, type LiveWork, LiveWorkLine } from "./LiveWorkLine.tsx";
import type { WorkStep } from "./thread.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const step = (key: string, startT: number, state: WorkStep["state"] = "done"): WorkStep => ({
  key,
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
const summary = () => screen.getByRole("button", { expanded: false }).textContent?.trim();

it("says what dot is doing while it works, with the turn's steps and time under a fold", () => {
  render(<LiveWorkLine steps={steps} startMs={1000} live={live("Typing the total")} />);
  expect(screen.getByText("Typing the total")).toBeTruthy();
  expect(summary()).toBe("Working · 3 steps · 1 failed · 0:42");
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s+/g, " ")),
  ).toEqual(["Step a 0:01", "Step b 0:01", "Step c 0:01"]);
});

it("holds each line at least a second, so quick steps never flicker past", () => {
  vi.useFakeTimers();
  const view = render(<LiveWorkLine steps={steps} startMs={1000} live={live("Clicking Save")} />);
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
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  const scroll = screen.getByRole("region", { name: "Work history" });
  expect(scroll.querySelectorAll(".thread-work-window-row")).toHaveLength(140);
  expect(screen.getByText("Step 0")).toBeTruthy();
  expect(screen.getByText("Step 139")).toBeTruthy();
  expect(screen.queryByText(/earlier steps are/)).toBeNull();
});

it("keeps step descriptions visible in an earlier completed turn", () => {
  const history = [{ ...step("a", 1000), meta: "Chromium · Read the page title" }];
  const view = render(<LiveWorkLine steps={history} startMs={0} live={null} ended="done" />);
  fireEvent.click(screen.getByRole("button", { expanded: false }));
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
  fireEvent.click(screen.getByRole("button", { expanded: false }));
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
  fireEvent.click(screen.getByRole("button", { expanded: false }));
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

it("shows a step in Activity when its row is chosen, and only for the task Activity shows", () => {
  const open = vi.fn();
  const view = render(<LiveWorkLine steps={steps} startMs={1000} live={null} onOpenStep={open} />);
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  fireEvent.click(screen.getByRole("button", { name: /Step b/ }));
  expect(open).toHaveBeenCalledWith("b");
  view.unmount();
  render(<LiveWorkLine steps={steps} startMs={1000} live={null} />);
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(screen.queryByRole("button", { name: /Step b/ })).toBeNull();
});
