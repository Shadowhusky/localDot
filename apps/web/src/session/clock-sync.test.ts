import { microsToMs, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { sessionMsAt, syncClock } from "./clock-sync.ts";

describe("syncClock", () => {
  it("maps viewer wall-clock ms onto daemon microseconds with the lowest-RTT ping", async () => {
    let wall = 1_700_000_000_000;
    const daemonAt = (w: number) => (w - 1_700_000_000_000) * 1000 + 999_000_000;
    const rtts = [3, 1, 2];
    let i = 0;
    const fetchImpl = (async () => {
      const rtt = rtts[i++ % rtts.length] as number;
      const mid = wall + rtt / 2;
      wall += rtt;
      return new Response(JSON.stringify({ nowMicros: daemonAt(mid) }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const sample = await syncClock(fetchImpl, "http://x", "tok", 3, () => wall);
    expect(sample.rttMicros).toBe(1000);
    expect(Math.abs(msToMicros(wall) + sample.offsetMicros - daemonAt(wall))).toBeLessThan(1);
    expect(
      sessionMsAt(wall, { offsetMicros: sample.offsetMicros, originMicros: 999_000_000 }),
    ).toBeCloseTo(microsToMs(daemonAt(wall) - 999_000_000), 3);
  });
});
