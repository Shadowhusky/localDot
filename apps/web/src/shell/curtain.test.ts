// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerPhase } from "../cells/hud-state.ts";
import { curtainFor, LIVE_HOLD_MS, useCurtain } from "./curtain.ts";

afterEach(() => vi.useRealTimers());

describe("the curtain", () => {
  it("covers the stage while there is no picture, and leaves a reconnecting or frozen one", () => {
    for (const phase of [
      "checking",
      "none",
      "starting",
      "connecting",
      "stopped",
      "failed",
    ] as const)
      expect(curtainFor(phase), phase).toBe(true);
    for (const phase of ["live", "reconnecting", "frozen"] as const)
      expect(curtainFor(phase), phase).toBe(false);
  });

  it("stays up for dot's reaction when the computer comes on, keeping its last words", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ phase }: { phase: ComputerPhase }) => useCurtain(phase, false),
      { initialProps: { phase: "starting" as ComputerPhase } },
    );
    rerender({ phase: "live" });
    expect(result.current).toEqual({ up: true, phase: "starting", lifting: true });
    act(() => vi.advanceTimersByTime(LIVE_HOLD_MS - 1));
    expect(result.current.up).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.up).toBe(false);
  });

  it("lifts at once when the page finds the computer already on", () => {
    const { result, rerender } = renderHook(
      ({ phase }: { phase: ComputerPhase }) => useCurtain(phase, false),
      { initialProps: { phase: "checking" as ComputerPhase } },
    );
    expect(result.current.up).toBe(true);
    rerender({ phase: "live" });
    expect(result.current.up).toBe(false);
  });

  it("is never up over Replay", () => {
    const { result } = renderHook(() => useCurtain("stopped", true));
    expect(result.current.up).toBe(false);
  });
});
