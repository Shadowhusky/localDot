// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HOLD_MS, type LiveWork, LiveWorkLine } from "./LiveWorkLine.tsx";
import type { WorkStep } from "./thread.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Step a0:01",
    "Step b0:01",
    "Step c0:01",
  ]);
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
