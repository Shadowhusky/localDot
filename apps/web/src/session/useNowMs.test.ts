// @vitest-environment jsdom
import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNowMs } from "./useNowMs.ts";

let seq = 0;
const ev = (type: string, tMs: number, data: Record<string, unknown>, step?: string) =>
  ({
    v: 1,
    id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    seq: seq++,
    t: msToMicros(tMs),
    agent: "main",
    ...(step ? { step } : {}),
    type,
    data,
  }) as LocalDotEvent;
const model = () =>
  foldEvents(emptyModel(), [
    ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" }),
    ev("action.intent", 20, { verb: "click", label: "Click OK", risk: "none" }, "s1"),
    ev("action.result", 1010, { ok: true }, "s1"),
    ev("agent.state", 21_010, { state: "done" }),
  ]);
afterEach(() => vi.useRealTimers());

it("anchors on the latest event of any kind, so a late state is not read as still to come", () => {
  const { result } = renderHook(() => useNowMs(model(), 0, () => false));
  expect(result.current).toBeGreaterThanOrEqual(21_010);
});

it.each([
  ["a screen read", () => [ev("observe", 30_000, { frameId: "f1", width: 2560, height: 1600 })]],
  ["a step's start", () => [ev("step.start", 30_000, { kind: "gui" }, "s9")]],
  [
    "a step's end",
    () => [
      ev("step.start", 21_020, { kind: "gui" }, "s9"),
      ev("step.end", 30_000, { status: "ok" }, "s9"),
    ],
  ],
  [
    "a timeline mark",
    () => [
      ev("approval.resolve", 30_000, {
        approvalId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
        decision: "approve",
        by: "user",
      }),
    ],
  ],
])("anchors on %s that comes after the latest state", (_, later) => {
  const m = model();
  foldEvents(m, later());
  const { result } = renderHook(() => useNowMs(m, 0, () => false));
  expect(result.current).toBeGreaterThanOrEqual(30_000);
});

it("ticks only while the task is running", () => {
  vi.useFakeTimers();
  const m = model();
  const { rerender } = renderHook(({ running }) => useNowMs(m, 0, () => running), {
    initialProps: { running: false },
  });
  expect(vi.getTimerCount()).toBe(0);
  rerender({ running: true });
  expect(vi.getTimerCount()).toBe(1);
  rerender({ running: false });
  expect(vi.getTimerCount()).toBe(0);
});
