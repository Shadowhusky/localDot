// @vitest-environment jsdom
import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionClock } from "./clock-sync.ts";
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

// A synced clock that puts the daemon's session time at `sessionMs` now.
const clockAt = (sessionMs: number): SessionClock => ({
  offsetMicros: 0,
  originMicros: msToMicros(performance.timeOrigin + performance.now() - sessionMs),
});

it("runs on the daemon's clock while no events arrive", () => {
  const { result } = renderHook(() => useNowMs(model(), 0, () => false, clockAt(40_000)));
  expect(result.current).toBeGreaterThanOrEqual(40_000);
  expect(result.current).toBeLessThan(41_000);
});

it("never runs backwards for one task when the clock is lost or a late event re-anchors", () => {
  const m = model();
  const { result, rerender } = renderHook(
    ({ version, clock }) => useNowMs(m, version, () => false, clock),
    { initialProps: { version: 0, clock: clockAt(50_000) as SessionClock | null } },
  );
  expect(result.current).toBeGreaterThanOrEqual(50_000);
  rerender({ version: 1, clock: null });
  expect(result.current).toBeGreaterThanOrEqual(50_000);
});

it("starts afresh for another task", () => {
  const { result, rerender } = renderHook(({ m, clock }) => useNowMs(m, 0, () => false, clock), {
    initialProps: { m: model(), clock: clockAt(50_000) as SessionClock | null },
  });
  expect(result.current).toBeGreaterThanOrEqual(50_000);
  rerender({ m: model(), clock: null });
  expect(result.current).toBeLessThan(50_000);
});

it("re-reads on the task's next whole second", () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(globalThis, "setTimeout");
  renderHook(() => useNowMs(model(), 0, () => true, clockAt(30_400)));
  const delay = timeout.mock.calls.at(-1)?.[1] ?? 0;
  expect(delay).toBeGreaterThan(550);
  expect(delay).toBeLessThan(650);
  timeout.mockRestore();
});

it("re-reads at once when the page is shown again", () => {
  let renders = 0;
  renderHook(() => {
    renders++;
    return useNowMs(model(), 0, () => true);
  });
  const before = renders;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(renders).toBeGreaterThan(before);
});

it("ignores a clock that could not be read", () => {
  const broken = { offsetMicros: Number.NaN, originMicros: 0 };
  const { result } = renderHook(() => useNowMs(model(), 0, () => false, broken));
  expect(result.current).toBeGreaterThanOrEqual(21_010);
});
