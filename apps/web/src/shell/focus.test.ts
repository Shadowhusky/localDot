// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inFocus, STILL_MS, useStill } from "./focus.ts";

afterEach(() => vi.useRealTimers());

describe("focus mode", () => {
  const base = { landscape: true, live: true, needsThread: false, left: false };

  it("gives a sideways phone's screen to the live picture", () => {
    expect(inFocus(base)).toBe(true);
  });

  it("stays out while upright, without a live picture, while the thread is needed or once left", () => {
    expect(inFocus({ ...base, landscape: false })).toBe(false);
    expect(inFocus({ ...base, live: false })).toBe(false);
    expect(inFocus({ ...base, needsThread: true })).toBe(false);
    expect(inFocus({ ...base, left: true })).toBe(false);
  });
});

describe("useStill", () => {
  it("turns still after a quiet spell and wakes at a touch", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStill(true));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(STILL_MS));
    expect(result.current).toBe(true);
    act(() => {
      document.dispatchEvent(new Event("pointerdown"));
    });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(STILL_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("is never still while inactive", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ active }) => useStill(active), {
      initialProps: { active: true },
    });
    act(() => vi.advanceTimersByTime(STILL_MS));
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
