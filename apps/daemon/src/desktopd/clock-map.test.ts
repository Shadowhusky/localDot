import { describe, expect, it } from "vitest";
import { ClockMap } from "./clock-map.ts";

describe("ClockMap", () => {
  it("takes the lowest-RTT sample and maps the cell's monotonic ms onto daemon microseconds", async () => {
    // The daemon clock runs in µs; the cell's clock reads 1 000 000 ms ahead of it and one ping is slow.
    let now = 10_000_000;
    const rtts = [900, 2500, 600, 1800, 700];
    let i = 0;
    const map = new ClockMap(
      async () => {
        const rtt = rtts[i++ % rtts.length] as number;
        now += rtt;
        return (now - rtt / 2) / 1000 + 1_000_000;
      },
      () => now,
    );
    const sample = await map.sync(5);
    expect(sample.rttMicros).toBe(600);
    expect(Math.abs(sample.offsetMicros - 1_000_000_000)).toBeLessThan(1);
    expect(Math.abs(map.toDaemonMicros(1_000_000 + 12.5) - 12_500)).toBeLessThan(1);
  });

  it("refuses to map before a sync", () => {
    const map = new ClockMap(
      async () => 0,
      () => 0,
    );
    expect(() => map.toDaemonMicros(1)).toThrow(/not synced/);
  });
});
