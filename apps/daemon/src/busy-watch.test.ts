import { afterEach, expect, it, vi } from "vitest";
import { watchBusy } from "./busy-watch.ts";

afterEach(() => {
  vi.useRealTimers();
});

it("says when the daemon answered nothing for a while, and stays quiet otherwise", () => {
  vi.useFakeTimers();
  let clock = 0;
  const log = vi.fn();
  const stop = watchBusy({ everyMs: 500, afterMs: 2_000, log, now: () => clock });
  clock += 500;
  vi.advanceTimersByTime(500);
  clock += 1_900;
  vi.advanceTimersByTime(500);
  expect(log).not.toHaveBeenCalled();
  // Held for 3 s: the timer that was due after half a second runs only now.
  clock += 3_500;
  vi.advanceTimersByTime(500);
  expect(log).toHaveBeenCalledWith("the daemon was busy for 3.0 s and answered nothing meanwhile");
  stop();
});
