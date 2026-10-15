import { afterEach, expect, it, vi } from "vitest";
import { onStepFocus, showStep, takeStep, wantedStep } from "./step-focus.ts";

afterEach(() => vi.useRealTimers());

it("keeps the newest request until Activity takes it, and tells listeners", () => {
  const heard = vi.fn();
  const stop = onStepFocus(heard);
  showStep("a");
  showStep("b");
  const wanted = wantedStep();
  expect(wanted?.key).toBe("b");
  takeStep((wanted?.serial ?? 0) - 1);
  expect(wantedStep()?.key).toBe("b");
  takeStep(wanted?.serial ?? 0);
  expect(wantedStep()).toBeNull();
  expect(heard).toHaveBeenCalledTimes(3);
  stop();
});

it("lets a request nothing took lapse, so opening Activity later shows no old step", () => {
  vi.useFakeTimers();
  showStep("c");
  expect(wantedStep()?.key).toBe("c");
  vi.advanceTimersByTime(10_000);
  expect(wantedStep()).toBeNull();
});
