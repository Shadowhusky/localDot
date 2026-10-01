import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StallWatchdog } from "./watchdog.ts";

describe("StallWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pings on every tick, reports stalled after silence and live again on the next sign of life", () => {
    const pings: number[] = [];
    const changes: string[] = [];
    const dog = new StallWatchdog({
      pingEveryMs: 100,
      stallAfterMs: 250,
      ping: () => pings.push(Date.now()),
      onChange: (state) => changes.push(state),
    });
    dog.start();
    vi.advanceTimersByTime(200);
    dog.touch();
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(changes).toEqual(["stalled"]);
    expect(pings).toHaveLength(6);
    dog.touch();
    expect(changes).toEqual(["stalled", "live"]);
    dog.stop();
    vi.advanceTimersByTime(1000);
    expect(pings).toHaveLength(6);
  });
});
